import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import { approveAction, getAction, listQueue, rejectAction } from '../services/ai.service';

const ListQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const RejectSchema = z.object({ reason: z.string().max(2000).optional() });

const ActionPath = z.object({ workspaceId: z.string().uuid(), actionId: z.string().uuid() });

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

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerAiActionRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/ai-actions';

  app.get(base, { preHandler: READ }, async (req) => {
    const q = parseQuery(ListQuery, req.query);
    return ok({ actions: await listQueue(req.workspace!.id, q) });
  });

  app.get(`${base}/:actionId`, { preHandler: READ }, async (req) => {
    const { actionId } = parsePath(ActionPath, req.params);
    const action = await getAction(req.workspace!.id, actionId);
    if (!action) throw new NotFoundError('Action not found');
    return ok({ action });
  });

  app.post(`${base}/:actionId/approve`, { preHandler: WRITE }, async (req) => {
    const { actionId } = parsePath(ActionPath, req.params);
    return ok({ action: await approveAction(req.workspace!.id, actionId) }, 'Approved');
  });

  app.post(`${base}/:actionId/reject`, { preHandler: WRITE }, async (req) => {
    const { actionId } = parsePath(ActionPath, req.params);
    const body = parseBody(RejectSchema, req.body ?? {});
    return ok({ action: await rejectAction(req.workspace!.id, actionId, body.reason) }, 'Rejected');
  });

  app.post(`${base}/:actionId/regenerate`, { preHandler: WRITE }, async () => {
    // Regenerate is a per-task operation — the caller should re-trigger the
    // upstream endpoint (/leads/:id/score, /leads/:id/generate-email, etc).
    return ok({ regenerated: false }, 'Re-trigger the upstream endpoint (score/generate-email/etc) to regenerate');
  });
}
