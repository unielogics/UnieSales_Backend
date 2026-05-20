import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ConflictError, ValidationError } from '../utils/errors';
import * as threadService from '../services/thread.service';
import * as aiTasks from '../services/ai-tasks.service';
import { sendEmail } from '../services/gmail.service';

const ListQuery = z.object({
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const ThreadPath = z.object({ workspaceId: z.string().uuid(), threadId: z.string().uuid() });
const HandoffPath = z.object({ workspaceId: z.string().uuid(), leadId: z.string().uuid() });

const SendReplySchema = z.object({
  subject: z.string().min(1).max(998).optional(),
  body: z.string().min(1).max(200_000),
});
const StopSchema = z.object({ reason: z.string().max(500).optional() });
const HandoffCreateSchema = z.object({ summary: z.string().max(4000).optional() });
const HandoffResolveSchema = z.object({ resolution: z.enum(['continue', 'closed']).optional() });

function parseBody<T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> {
  const r = s.safeParse(b);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}
function parsePath<T extends z.ZodTypeAny>(s: T, p: unknown): z.infer<T> {
  const r = s.safeParse(p);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}
function parseQuery<T extends z.ZodTypeAny>(s: T, q: unknown): z.infer<T> {
  const r = s.safeParse(q);
  if (!r.success) {
    throw new ValidationError(
      'Invalid query',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/threads';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parseQuery(ListQuery, req.query);
    return ok(await threadService.list(req.workspace!.id, q));
  });

  app.get(`${base}/:threadId`, { preHandler: READ }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    return ok({ thread: await threadService.getById(req.workspace!.id, threadId) });
  });

  app.post(`${base}/:threadId/summarize`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const t = await threadService.getById(req.workspace!.id, threadId);
    const result = await aiTasks.summarizeThread({
      workspaceId: req.workspace!.id,
      campaignId: t.campaignId ?? undefined,
      leadId: t.leadId ?? undefined,
      threadId: t.id,
    });
    return ok({ ai: { actionId: result.action.id, ...result.output } });
  });

  app.post(`${base}/:threadId/draft-reply`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const t = await threadService.getById(req.workspace!.id, threadId);
    if (!t.campaignId || !t.leadId) {
      throw new ConflictError('Thread is missing campaign or lead linkage');
    }
    const result = await aiTasks.classifyReply({
      workspaceId: req.workspace!.id,
      campaignId: t.campaignId,
      leadId: t.leadId,
      threadId: t.id,
    });
    return ok({ ai: { actionId: result.action.id, ...result.output } });
  });

  app.post(`${base}/:threadId/send-reply`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const input = parseBody(SendReplySchema, req.body);
    const t = await threadService.getById(req.workspace!.id, threadId);
    if (!t.gmailAccountId) throw new ConflictError('Thread has no gmail account');
    const lead = t.lead;
    if (!lead) throw new ConflictError('Thread has no lead');
    const r = await sendEmail({
      workspaceId: req.workspace!.id,
      gmailAccountId: t.gmailAccountId,
      to: lead.email,
      subject: input.subject ?? (t.subject ? `Re: ${t.subject}` : 'Re:'),
      body: input.body,
      threadId: t.gmailThreadId,
      campaignId: t.campaignId ?? undefined,
      leadId: t.leadId ?? undefined,
    });
    return ok(r, 'Reply sent');
  });

  app.post(`${base}/:threadId/handoff`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    return ok({ thread: await threadService.handoff(req.workspace!.id, threadId) }, 'Handed off');
  });

  app.post(`${base}/:threadId/stop-sequence`, { preHandler: WRITE }, async (req) => {
    const { threadId } = parsePath(ThreadPath, req.params);
    const body = parseBody(StopSchema, req.body ?? {});
    return ok(
      { thread: await threadService.stopSequence(req.workspace!.id, threadId, body.reason) },
      'Sequence stopped',
    );
  });

  // ---- Handoff queue ----
  const handoffsBase = '/api/workspaces/:workspaceId/handoffs';

  app.get(handoffsBase, { preHandler: READ }, async (req) => {
    return ok({ leads: await threadService.listHandoffs(req.workspace!.id) });
  });

  app.post(`${handoffsBase}/:leadId/create`, { preHandler: WRITE }, async (req, reply) => {
    const { leadId } = parsePath(HandoffPath, req.params);
    const body = parseBody(HandoffCreateSchema, req.body ?? {});
    reply.code(201);
    return ok(
      { lead: await threadService.createHandoff(req.workspace!.id, leadId, body.summary) },
      'Handoff created',
    );
  });

  app.post(`${handoffsBase}/:leadId/resolve`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(HandoffPath, req.params);
    const body = parseBody(HandoffResolveSchema, req.body ?? {});
    return ok(
      { lead: await threadService.resolveHandoff(req.workspace!.id, leadId, body.resolution ?? 'continue') },
      'Handoff resolved',
    );
  });
}
