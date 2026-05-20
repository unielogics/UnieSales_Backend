import type { WorkspaceRole } from '../db/schema/workspace-members';

/**
 * Fastify module augmentation: attach req.user (after auth middleware) and
 * req.workspace (after workspace middleware) so downstream handlers get
 * typed access.
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    workspace?: WorkspaceContext;
  }
}

export interface AuthedUser {
  id: string;
  email: string;
}

export interface WorkspaceContext {
  id: string;
  role: WorkspaceRole;
}

export interface JwtPayload {
  sub: string; // user id
  email: string;
  iat?: number;
  exp?: number;
}
