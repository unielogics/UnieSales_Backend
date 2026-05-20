import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/db';
import { workspaces } from '../db/schema/workspaces';
import { workspaceMembers, type WorkspaceRole } from '../db/schema/workspace-members';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';

const ParamsSchema = z.object({
  workspaceId: z.string().uuid('workspaceId must be a UUID'),
});

/**
 * preHandler that runs after requireAuth. It parses :workspaceId from path,
 * verifies the workspace exists and is active, verifies req.user is a member,
 * and attaches req.workspace = { id, role }.
 */
export const requireWorkspaceMembership: preHandlerHookHandler = async (req: FastifyRequest) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');

  const parsed = ParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new ValidationError(
      'Invalid workspace path',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  const { workspaceId } = parsed.data;

  const db = getDb();
  const wsRows = await db
    .select({ id: workspaces.id, isActive: workspaces.isActive })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const ws = wsRows[0];
  if (!ws) throw new NotFoundError('Workspace not found');
  if (!ws.isActive) throw new ForbiddenError('Workspace is not active');

  const memberRows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, req.user.id)))
    .limit(1);
  const member = memberRows[0];
  if (!member) throw new ForbiddenError('You do not have access to this workspace');

  req.workspace = { id: workspaceId, role: member.role as WorkspaceRole };
};

/**
 * Higher-order preHandler that enforces a minimum role. Apply after
 * requireWorkspaceMembership. owner > admin > viewer.
 */
const ROLE_LEVEL: Record<WorkspaceRole, number> = { owner: 3, admin: 2, viewer: 1 };

export function requireWorkspaceRole(minimum: WorkspaceRole): preHandlerHookHandler {
  return async (req) => {
    if (!req.workspace) throw new ForbiddenError('Workspace context missing');
    if (ROLE_LEVEL[req.workspace.role] < ROLE_LEVEL[minimum]) {
      throw new ForbiddenError(`Requires role >= ${minimum}`);
    }
  };
}
