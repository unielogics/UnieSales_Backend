import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import * as workspaceService from '../services/workspace.service';

const HandoffRuleSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  tone: z.enum(['info', 'warning', 'danger']).optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  companyName: z.string().min(1).max(200),
  brandName: z.string().max(120).optional(),
  industry: z.string().max(120).optional(),
  website: z.string().url().optional(),
  defaultFromEmail: z.string().email().optional(),
  defaultSenderName: z.string().max(120).optional(),
  defaultBookingLink: z.string().url().optional(),
  notificationEmail: z.string().email().optional(),
  autoReplyEnabled: z.boolean().optional(),
  autoReplyConfidenceThreshold: z.number().min(0).max(1).optional(),
});

const UpdateSchema = CreateSchema.partial().extend({
  isActive: z.boolean().optional(),
  handoffRules: z.array(HandoffRuleSchema).max(100).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  // List workspaces the caller belongs to
  app.get('/api/workspaces', { preHandler: requireAuth }, async (req) => {
    if (!req.user) throw new UnauthorizedError();
    const list = await workspaceService.listForUser(req.user.id);
    return ok({ workspaces: list });
  });

  // Create a workspace; caller becomes owner
  app.post('/api/workspaces', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.user) throw new UnauthorizedError();
    const input = parse(CreateSchema, req.body);
    const ws = await workspaceService.create(
      {
        ...input,
        autoReplyConfidenceThreshold: input.autoReplyConfidenceThreshold?.toFixed(3),
      },
      req.user.id,
    );
    reply.code(201);
    return ok({ workspace: ws }, 'Workspace created');
  });

  // Get one
  app.get(
    '/api/workspaces/:workspaceId',
    { preHandler: [requireAuth, requireWorkspaceMembership] },
    async (req) => {
      const ws = await workspaceService.getById(req.workspace!.id);
      if (!ws) throw new NotFoundError('Workspace not found');
      return ok({ workspace: ws, role: req.workspace!.role });
    },
  );

  // Update (admin or owner)
  app.patch(
    '/api/workspaces/:workspaceId',
    { preHandler: [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')] },
    async (req) => {
      const patch = parse(UpdateSchema, req.body);
      const ws = await workspaceService.update(req.workspace!.id, {
        ...patch,
        autoReplyConfidenceThreshold: patch.autoReplyConfidenceThreshold?.toFixed(3),
      });
      return ok({ workspace: ws }, 'Updated');
    },
  );

  // Dashboard aggregates
  app.get(
    '/api/workspaces/:workspaceId/dashboard',
    { preHandler: [requireAuth, requireWorkspaceMembership] },
    async (req) => {
      const dashboard = await workspaceService.dashboard(req.workspace!.id);
      return ok(dashboard);
    },
  );
}
