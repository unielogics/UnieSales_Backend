import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { runFollowups } from '../services/followup.service';

const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerFollowupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/workspaces/:workspaceId/followups/run', { preHandler: WRITE }, async (req) => {
    return ok(await runFollowups({ workspaceId: req.workspace!.id, limit: 100 }), 'Followups run');
  });

  // Cross-workspace runner: requires authenticated user; intended for internal cron / worker.
  app.post('/api/followups/run-all', { preHandler: requireAuth }, async () => {
    return ok(await runFollowups({ limit: 500 }), 'Followups run across all workspaces');
  });
}
