import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as leadService from '../services/lead.service';
import * as suppressionService from '../services/suppression.service';
import { LEAD_STATUSES, type LeadStatus } from '../db/schema/leads';

const WorkspacePath = z.object({ workspaceId: z.string().uuid() });
const LeadPath = WorkspacePath.extend({ leadId: z.string().uuid() });

const ListQuery = z.object({
  campaignId: z.string().uuid().optional(),
  status: z.string().optional(), // comma-separated allowed
  lifecycleStatus: z.enum(['active', 'paused', 'closed']).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  orderBy: z.enum(['created_at', 'updated_at', 'last_engagement_at', 'lead_score']).optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
});

const CreateSchema = z.object({
  email: z.string().email().max(254),
  campaignId: z.string().uuid().optional(),
  companyName: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  website: z.string().max(500).optional(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().max(500).optional(),
  segment: z.string().max(120).optional(),
  source: z.string().max(120).optional(),
  sourceNotes: z.string().optional(),
  status: z.string().optional(),
});

const UpdateSchema = z.object({
  campaignId: z.string().uuid().optional(),
  companyName: z.string().max(200).nullable().optional(),
  contactName: z.string().max(200).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  linkedinUrl: z.string().max(500).nullable().optional(),
  segment: z.string().max(120).nullable().optional(),
  status: z.string().optional(),
  leadScore: z.number().int().min(0).max(100).optional(),
  leadScoreReason: z.string().max(2000).optional(),
  painAngle: z.string().max(2000).optional(),
  personalization: z.string().max(4000).optional(),
  aiOwner: z.boolean().optional(),
});

const BulkSchema = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(500),
  patch: UpdateSchema,
});

const PauseSchema = z.object({ pausedUntil: z.string().datetime().optional() });
const CloseSchema = z.object({
  closeReason: z.string().min(1).max(500),
  status: z.string().optional(),
});
const SuppressSchema = z.object({ reason: z.string().max(500).optional() });

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

function parseStatusFilter(s?: string): LeadStatus | LeadStatus[] | undefined {
  if (!s) return undefined;
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  for (const p of parts) {
    if (!(LEAD_STATUSES as readonly string[]).includes(p)) {
      throw new ValidationError('Invalid status filter', [{ field: 'status', reason: `'${p}' is not a valid status` }]);
    }
  }
  return parts.length === 1 ? (parts[0] as LeadStatus) : (parts as LeadStatus[]);
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerLeadRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/leads';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parseQuery(ListQuery, req.query);
    return ok(
      await leadService.list(req.workspace!.id, {
        ...q,
        status: parseStatusFilter(q.status),
      }),
    );
  });

  app.post(base, { preHandler: WRITE }, async (req, reply) => {
    const input = parseBody(CreateSchema, req.body);
    const lead = await leadService.create(req.workspace!.id, {
      ...input,
      status: input.status as LeadStatus | undefined,
    });
    reply.code(201);
    return ok({ lead }, 'Lead created');
  });

  app.post(`${base}/bulk-update`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(BulkSchema, req.body);
    const r = await leadService.bulkUpdate(req.workspace!.id, {
      leadIds: input.leadIds,
      patch: { ...input.patch, status: input.patch.status as LeadStatus | undefined },
    });
    return ok(r, `${r.updated} leads updated`);
  });

  app.get(`${base}/:leadId`, { preHandler: READ }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    return ok({ lead: await leadService.getById(req.workspace!.id, leadId) });
  });

  app.patch(`${base}/:leadId`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const patch = parseBody(UpdateSchema, req.body);
    const lead = await leadService.update(req.workspace!.id, leadId, {
      ...patch,
      status: patch.status as LeadStatus | undefined,
    });
    return ok({ lead }, 'Updated');
  });

  app.delete(`${base}/:leadId`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    await leadService.remove(req.workspace!.id, leadId);
    return ok({ deleted: true }, 'Lead deleted');
  });

  app.post(`${base}/:leadId/pause`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(PauseSchema, req.body ?? {});
    const lead = await leadService.pause(
      req.workspace!.id,
      leadId,
      input.pausedUntil ? new Date(input.pausedUntil) : undefined,
    );
    return ok({ lead }, 'Lead paused');
  });

  app.post(`${base}/:leadId/close`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(CloseSchema, req.body);
    const lead = await leadService.close(
      req.workspace!.id,
      leadId,
      input.closeReason,
      (input.status ?? 'closed_manual') as LeadStatus,
    );
    return ok({ lead }, 'Lead closed');
  });

  app.post(`${base}/:leadId/suppress`, { preHandler: WRITE }, async (req) => {
    const { leadId } = parsePath(LeadPath, req.params);
    const input = parseBody(SuppressSchema, req.body ?? {});
    const r = await leadService.suppress(req.workspace!.id, leadId, input.reason);
    return ok(r, 'Lead and email suppressed');
  });

  // ---- AI / Gmail stubs — wired up in Phase 9 + Phase 8 ----
  app.post(`${base}/:leadId/score`, { preHandler: WRITE }, async () => {
    return ok({ scored: false }, 'AI scoring wired up in Phase 9');
  });
  app.post(`${base}/:leadId/generate-email`, { preHandler: WRITE }, async () => {
    return ok({ generated: false }, 'AI email generation wired up in Phase 9');
  });
  app.post(`${base}/:leadId/send-next`, { preHandler: WRITE }, async () => {
    return ok({ sent: false }, 'Outbound send wired up in Phase 8');
  });

  // ---- Workspace-level suppression list ----
  app.get('/api/workspaces/:workspaceId/suppression', { preHandler: READ }, async (req) => {
    return ok({ suppression: await suppressionService.list(req.workspace!.id) });
  });

  app.post('/api/workspaces/:workspaceId/suppression', { preHandler: WRITE }, async (req, reply) => {
    const schema = z.object({
      email: z.string().email().max(254),
      reason: z.string().max(500).optional(),
    });
    const input = parseBody(schema, req.body);
    const r = await suppressionService.suppressEmailAndCloseLeads(req.workspace!.id, input.email, input.reason);
    reply.code(201);
    return ok(r, 'Email suppressed');
  });
}
