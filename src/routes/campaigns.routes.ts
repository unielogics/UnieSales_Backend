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
  smsConfig: z
    .object({
      channelMode: z.enum(['auto', 'email_only', 'sms_only']).optional(),
      quietHoursStart: z.string().regex(/^[0-2]\d:[0-5]\d$/, 'HH:MM 24h').optional(),
      quietHoursEnd: z.string().regex(/^[0-2]\d:[0-5]\d$/, 'HH:MM 24h').optional(),
    })
    .nullable()
    .optional(),
});

// scheduledStartAt is update-only — it's coerced from ISO string → Date in
// the PATCH handler. Adding it to CreateSchema would let new campaigns ship
// with a string where a Date is expected.
const UpdateSchema = CreateSchema.partial().extend({
  scheduledStartAt: z.string().nullable().optional(),
});

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
      const raw = parseBody(UpdateSchema, req.body);
      // Coerce scheduledStartAt from ISO string → Date (null is preserved).
      const patch: Record<string, unknown> = { ...raw };
      if (typeof raw.scheduledStartAt === 'string') {
        const d = new Date(raw.scheduledStartAt);
        if (Number.isNaN(d.getTime())) {
          throw new ValidationError('Invalid scheduledStartAt', [
            { field: 'scheduledStartAt', reason: 'must be an ISO 8601 datetime' },
          ]);
        }
        patch.scheduledStartAt = d;
      }
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

  // --- Step 11: Send test emails & Activate (Playground) ---
  //
  // Test sends are isolated: they create / reuse a lead with
  // source='playground_test', send through the full AI pipeline, and never
  // mutate campaign status. Activation is the separate POST /activate route
  // and remains the only path that flips a campaign to live sending.

  const PlaygroundSendSchema = z.object({
    // Required recipient address for this test send. Renamed in the request
    // body to make intent obvious; mapped to the service's `email` field.
    recipientEmail: z.string().email(),
    contactName: z.string().max(200).optional(),
    companyName: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    sourceNotes: z.string().max(2000).optional(),
    gmailAccountId: z.string().uuid().optional(),
    subjectOverride: z.string().max(200).optional(),
    bodyOverride: z.string().max(5000).optional(),
  });

  app.post(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/playground/send',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const { recipientEmail, ...rest } = parseBody(PlaygroundSendSchema, req.body);
      const { runPlaygroundSend } = await import('../services/campaign-playground.service');
      const r = await runPlaygroundSend({
        workspaceId: req.workspace!.id,
        campaignId,
        email: recipientEmail,
        ...rest,
      });
      return ok(r, 'Test email sent');
    },
  );

  app.get(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/playground/leads',
    { preHandler: SCOPED_PREHANDLERS },
    async (req) => {
      const { campaignId } = parseCampaignParams(req.params);
      const { listPlaygroundLeads, getPrereqStatus } = await import('../services/campaign-playground.service');
      const [leads, prereq] = await Promise.all([
        listPlaygroundLeads(req.workspace!.id, campaignId),
        getPrereqStatus(req.workspace!.id, campaignId),
      ]);
      return ok({ leads, prereq });
    },
  );

  // Wipe a warm-up lead's prior email + re-send (re-trigger the AI).
  const PlaygroundLeadParams = z.object({
    workspaceId: z.string().uuid(),
    campaignId: z.string().uuid(),
    leadId: z.string().uuid(),
  });
  app.post(
    '/api/workspaces/:workspaceId/campaigns/:campaignId/playground/leads/:leadId/restart',
    { preHandler: ADMIN_SCOPED_PREHANDLERS },
    async (req) => {
      const r = PlaygroundLeadParams.safeParse(req.params);
      if (!r.success) {
        throw new ValidationError(
          'Invalid path',
          r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
        );
      }
      const { restartPlaygroundSend } = await import('../services/campaign-playground.service');
      const result = await restartPlaygroundSend({
        workspaceId: req.workspace!.id,
        campaignId: r.data.campaignId,
        leadId: r.data.leadId,
      });
      return ok(result, 'Warm-up restarted');
    },
  );
}
