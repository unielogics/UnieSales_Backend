/**
 * Per-lead activity / notes / tasks endpoints. Powers the Intelligence tab
 * on the lead modal plus the workspace-wide Activity feed.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as activity from '../services/sales-activity.service';
import * as notes from '../services/sales-note.service';
import * as tasks from '../services/sales-task.service';

const WorkspacePath = z.object({ workspaceId: z.string().uuid() });
const LeadPath = WorkspacePath.extend({ leadId: z.string().uuid() });

const ListQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  before: z.string().optional(),
  // Sales/Campaigns isolation — filters via the linked lead's import_origin.
  origin: z.enum(['intake', 'outbound']).optional(),
});

const LeadNoteCreate = z.object({
  kind: z.enum(['manual', 'ai_summary', 'reply_summary', 'meeting_prep', 'objection', 'handoff', 'post_call', 'intake_summary']),
  body: z.string().min(1).max(10000),
  title: z.string().max(200).optional(),
});

const LeadTaskCreate = z.object({
  title: z.string().min(1).max(300),
  type: z.enum(['review_lead', 'call_lead', 'review_ai_draft', 'prepare_demo', 'send_proposal', 'request_missing_info', 'follow_up_manual', 'review_form_submission']),
  priority: z.enum(['low', 'med', 'high']).optional(),
  dueAt: z.string().datetime().optional(),
});

const TaskUpdate = z.object({
  action: z.enum(['complete', 'snooze']),
  untilAt: z.string().datetime().optional(),
});

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = READ;

function parsePath<T extends z.ZodTypeAny>(s: T, params: unknown): z.infer<T> {
  const r = s.safeParse(params);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

function parseBody<T extends z.ZodTypeAny>(s: T, body: unknown): z.infer<T> {
  const r = s.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

function parseQuery<T extends z.ZodTypeAny>(s: T, query: unknown): z.infer<T> {
  const r = s.safeParse(query);
  if (!r.success) {
    throw new ValidationError(
      'Invalid query',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

export async function registerSalesActivityRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId';

  // ---- Per-lead activity feed --------------------------------------------
  app.get(`${base}/leads/:leadId/activities`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const q = parseQuery(ListQuery, req.query);
    const rows = await activity.listForLead(req.workspace!.id, leadId, q);
    return ok({ items: rows });
  });

  // ---- Per-lead notes ----------------------------------------------------
  app.get(`${base}/leads/:leadId/notes`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const q = parseQuery(ListQuery, req.query);
    const rows = await notes.listForLead(req.workspace!.id, leadId, q);
    return ok({ items: rows });
  });

  app.post(`${base}/leads/:leadId/notes`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(LeadNoteCreate, req.body);
    const row = await notes.create({
      workspaceId: req.workspace!.id,
      leadId,
      kind: input.kind,
      body: input.body,
      title: input.title,
      authorUserId: req.user?.id ?? null,
    });
    return ok({ note: row });
  });

  // ---- Per-lead tasks ----------------------------------------------------
  app.get(`${base}/leads/:leadId/tasks`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const rows = await tasks.list(req.workspace!.id, { leadId, status: ['open', 'snoozed'] });
    return ok({ items: rows });
  });

  app.post(`${base}/leads/:leadId/tasks`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(LeadTaskCreate, req.body);
    const row = await tasks.create({
      workspaceId: req.workspace!.id,
      leadId,
      title: input.title,
      type: input.type,
      priority: input.priority,
      dueAt: input.dueAt,
      source: 'manual',
      ownerUserId: req.user?.id ?? null,
    });
    return ok({ task: row });
  });

  // ---- Task state transitions --------------------------------------------
  app.post(`${base}/sales-tasks/:taskId`, { preHandler: WRITE }, async (req) => {
    const params = parsePath(WorkspacePath.extend({ taskId: z.string().uuid() }), req.params);
    const input = parseBody(TaskUpdate, req.body);
    if (input.action === 'complete') {
      const row = await tasks.complete(req.workspace!.id, params.taskId, req.user?.id);
      return ok({ task: row });
    }
    // snooze
    if (!input.untilAt) {
      throw new ValidationError('untilAt required for snooze', [{ field: 'untilAt', reason: 'required' }]);
    }
    const row = await tasks.snooze(req.workspace!.id, params.taskId, input.untilAt, req.user?.id);
    return ok({ task: row });
  });

  // Bulk-complete a batch of tasks — backs multi-select + Ctrl+click in the
  // Sales Tasks (My Queue) view.
  app.post(`${base}/sales-tasks/bulk-complete`, { preHandler: WRITE }, async (req) => {
    parsePath(WorkspacePath, req.params);
    const input = parseBody(
      z.object({ taskIds: z.array(z.string().uuid()).min(1).max(500) }),
      req.body,
    );
    const r = await tasks.bulkComplete(req.workspace!.id, input.taskIds);
    return ok(r, `${r.completed} tasks completed`);
  });

  // ---- Workspace-wide feed (Notes screen) --------------------------------
  app.get(`${base}/sales-activities`, { preHandler: READ }, async (req) => {
    parsePath(WorkspacePath, req.params);
    const q = parseQuery(ListQuery, req.query);
    const rows = await activity.listForWorkspace(req.workspace!.id, q);
    return ok({ items: rows });
  });

  // ---- Workspace-wide task counts (Cockpit) ------------------------------
  const CountsQuery = z.object({
    origin: z.enum(['intake', 'outbound']).optional(),
  });
  app.get(`${base}/sales-tasks/counts`, { preHandler: READ }, async (req) => {
    parsePath(WorkspacePath, req.params);
    const q = parseQuery(CountsQuery, req.query);
    const c = await tasks.countsByStatus(req.workspace!.id, { origin: q.origin });
    return ok(c);
  });

  // ---- Workspace-wide task list (Cockpit "Queued for me" + Tasks page) ---
  const TaskListQuery = z.object({
    status: z.enum(['open', 'completed', 'snoozed']).optional(),
    priority: z.enum(['low', 'med', 'high']).optional(),
    source: z.enum(['manual', 'AI']).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    origin: z.enum(['intake', 'outbound']).optional(),
  });
  app.get(`${base}/sales-tasks`, { preHandler: READ }, async (req) => {
    parsePath(WorkspacePath, req.params);
    const q = parseQuery(TaskListQuery, req.query);
    const rows = await tasks.list(req.workspace!.id, {
      status: q.status ?? 'open',
      limit: q.limit,
      origin: q.origin,
    });
    let filtered = rows;
    if (q.priority) filtered = filtered.filter((t) => t.priority === q.priority);
    if (q.source) filtered = filtered.filter((t) => t.source === q.source);
    return ok({ items: filtered });
  });
}
