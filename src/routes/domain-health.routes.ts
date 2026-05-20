import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as dh from '../services/domain-health.service';

const CheckSchema = z.object({
  domain: z.string().min(3).max(253),
  gmailAccountId: z.string().uuid().optional(),
  dkimSelector: z.string().min(1).max(120).optional(),
});

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

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerDomainHealthRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/domain-health';

  app.get(base, { preHandler: READ }, async (req) => {
    return ok({ checks: await dh.latestForWorkspace(req.workspace!.id) });
  });

  app.post(`${base}/check`, { preHandler: WRITE }, async (req) => {
    const input = parseBody(CheckSchema, req.body);
    const row = await dh.checkAndPersist({
      workspaceId: req.workspace!.id,
      domain: input.domain,
      gmailAccountId: input.gmailAccountId,
      dkimSelector: input.dkimSelector,
    });
    return ok({ check: row }, 'Domain checked');
  });
}
