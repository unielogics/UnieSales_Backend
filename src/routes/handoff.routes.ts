import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as handoffService from '../services/handoff.service';
import { HANDOFF_STATUSES } from '../db/schema/handoffs';

const ListQuery = z.object({
  status: z.enum(HANDOFF_STATUSES).optional(),
  // Sales/Campaigns isolation. Filters handoffs by the linked lead's
  // import_origin: 'intake' = Sales mode only, 'outbound' = Campaigns mode only.
  origin: z.enum(['intake', 'outbound']).optional(),
});

const HandoffPath = z.object({
  workspaceId: z.string().uuid(),
  handoffId: z.string().uuid(),
});

const CreateSchema = z.object({
  leadId: z.string().uuid(),
  campaignId: z.string().uuid().nullable().optional(),
  emailThreadId: z.string().uuid().nullable().optional(),
  reason: z.string().max(4000).optional(),
  notes: z.string().max(8000).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  assignee: z.string().email().nullable().optional(),
});

const UpdateSchema = z.object({
  status: z.enum(HANDOFF_STATUSES).optional(),
  reason: z.string().max(4000).nullable().optional(),
  notes: z.string().max(8000).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  assignee: z.string().email().nullable().optional(),
});

const ResolveSchema = z.object({
  resolution: z.string().max(500).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, label: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError(
      label,
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerHandoffRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/handoffs';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parse(ListQuery, req.query, 'Invalid query');
    const handoffs = await handoffService.list(req.workspace!.id, {
      status: q.status,
      origin: q.origin,
    });
    return ok({ handoffs });
  });

  app.post(base, { preHandler: WRITE }, async (req, reply) => {
    const input = parse(CreateSchema, req.body, 'Validation failed');
    const handoff = await handoffService.create(req.workspace!.id, input);
    reply.code(201);
    return ok({ handoff }, 'Handoff created');
  });

  app.patch(`${base}/:handoffId`, { preHandler: WRITE }, async (req) => {
    const { handoffId } = parse(HandoffPath, req.params, 'Invalid path');
    const patch = parse(UpdateSchema, req.body, 'Validation failed');
    const handoff = await handoffService.update(req.workspace!.id, handoffId, patch);
    return ok({ handoff }, 'Updated');
  });

  app.post(`${base}/:handoffId/resolve`, { preHandler: WRITE }, async (req) => {
    const { handoffId } = parse(HandoffPath, req.params, 'Invalid path');
    const body = parse(ResolveSchema, req.body ?? {}, 'Validation failed');
    const handoff = await handoffService.resolve(
      req.workspace!.id,
      handoffId,
      body.resolution ?? 'continue',
    );
    return ok({ handoff }, 'Handoff resolved');
  });
}
