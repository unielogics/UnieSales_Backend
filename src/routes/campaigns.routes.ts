import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as campaignService from '../services/campaign.service';

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  campaignType: z.string().max(120).optional(),
  targetAudience: z.string().optional(),
  offer: z.string().optional(),
  goalSummary: z.string().optional(),
  primaryCta: z.string().max(500).optional(),
  aiPositioning: z.string().optional(),
  aiRules: z.string().optional(),
  safeAutoReplyRules: z.unknown().optional(),
  handoffRules: z.unknown().optional(),
  maxFollowups: z.number().int().min(0).max(20).optional(),
  followupSchedule: z.unknown().optional(),
  dailySendLimit: z.number().int().positive().max(1000).optional(),
  sendWindowStart: z.string().regex(/^[0-2]\d:[0-5]\d$/, 'HH:MM 24h').optional(),
  sendWindowEnd: z.string().regex(/^[0-2]\d:[0-5]\d$/, 'HH:MM 24h').optional(),
  weekdaysOnly: z.boolean().optional(),
  handoffEmail: z.string().email().nullable().optional(),
  gmailAccountId: z.string().uuid().optional(),
});

const UpdateSchema = CreateSchema.partial();

const CampaignParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
});

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

function parseCampaignParams(params: unknown): { workspaceId: string; campaignId: string } {
  const r = CampaignParamsSchema.safeParse(params);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const SCOPED_PREHANDLERS = [requireAuth, requireWorkspaceMembership];
const ADMIN_SCOPED_PREHANDLERS = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

export async function registerCampaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/workspaces/:workspaceId/campaigns', { preHandler: SCOPED_PREHANDLERS }, async (req) => {
    const items = await campaignService.list(req.workspace!.id);
    return ok({ campaigns: items });
  });

  app.post(
    '/api/workspaces/:workspaceId/campaigns',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req, reply) => {
      const input = parseBody(CreateSchema, req.body);
      const campaign = await campaignService.create(req.workspace!.id, input);
      reply.code(201);
      return ok({ campaign }, 'Campaign created');
    },
  );

  app.get('/api/workspaces/:workspaceId/campaigns/:campaignId', { preHandler: SCOPED_PREHANDLERS }, async (req) => {
    const { campaignId } = parseCampaignParams(req.params);
    const campaign = await campaignService.getByIdOrThrow(req.workspace!.id, campaignId);
    return ok({ campaign });
  });

  app.patch(
    '/api/workspaces/:workspaceId/campaigns/:campaignId',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const patch = parseBody(UpdateSchema, req.body);
      const campaign = await campaignService.update(req.workspace!.id, campaignId, patch);
      return ok({ campaign }, 'Updated');
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/activate',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const result = await campaignService.activate(req.workspace!.id, campaignId);
      return ok(result, 'Campaign activated');
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/pause',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const campaign = await campaignService.pause(req.workspace!.id, campaignId);
      return ok({ campaign }, 'Campaign paused');
    },
  );

  app.post(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/archive',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const campaign = await campaignService.archive(req.workspace!.id, campaignId);
      return ok({ campaign }, 'Campaign archived');
    },
  );

  // Run 5 synthetic reply scenarios through the playbook to preview AI behaviour
  app.post(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/test',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const { runTest } = await import('../services/campaign-test.service');
      const r = await runTest({ workspaceId: req.workspace!.id, campaignId });
      return ok(r);
    },
  );
}
