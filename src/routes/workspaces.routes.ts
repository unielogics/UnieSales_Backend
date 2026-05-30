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

// Optional string fields are .nullable() too — the Settings form sends `null`
// (not `undefined`) for fields the operator left blank.
const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  companyName: z.string().min(1).max(200),
  brandName: z.string().max(120).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  website: z.string().url().nullable().optional(),
  defaultFromEmail: z.string().email().nullable().optional(),
  defaultSenderName: z.string().max(120).nullable().optional(),
  defaultBookingLink: z.string().url().nullable().optional(),
  notificationEmail: z.string().email().nullable().optional(),
  autoReplyEnabled: z.boolean().optional(),
  autoReplyConfidenceThreshold: z.coerce.number().min(0).max(1).optional(),
});

const EmailSampleSchema = z.object({
  subject: z.string().max(300),
  body: z.string().max(10000),
});

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

const BlockedWindowSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(120),
  days: z.array(z.number().int().min(0).max(6)).max(7),
  start: HHMM,
  end: HHMM,
});

const CalendarConfigSchema = z.object({
  timezone: z.string().min(1).max(64),
  workingDays: z.array(z.number().int().min(0).max(6)).max(7),
  workingHours: z.object({ start: HHMM, end: HHMM }),
  meetingDurationMinutes: z.number().int().min(5).max(480),
  slotIntervalMinutes: z.number().int().min(5).max(240),
  minLeadTimeHours: z.number().int().min(0).max(720),
  slotsNextDay: z.number().int().min(0).max(10),
  slotsDayAfter: z.number().int().min(0).max(10),
  blockedWindows: z.array(BlockedWindowSchema).max(50),
});

const UpdateSchema = CreateSchema.partial().extend({
  isActive: z.boolean().optional(),
  handoffRules: z.array(HandoffRuleSchema).max(100).optional(),
  emailFooterHtml: z.string().max(50000).nullable().optional(),
  emailStyleGuide: z.string().max(8000).nullable().optional(),
  emailSamples: z.array(EmailSampleSchema).max(10).nullable().optional(),
  calendarConfig: CalendarConfigSchema.nullable().optional(),
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
