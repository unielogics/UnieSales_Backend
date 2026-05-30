/**
 * Per-campaign AI Behavior cards — read + edit + approve.
 *
 * Frontend uses these to render the new "AI Behavior" step in the campaign
 * builder. The runtime services read the same data when deciding what to do
 * with a lead.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as behavior from '../services/campaign-ai-behavior.service';
import { AI_BEHAVIOR_CARD_KEYS } from '../db/schema/campaign-ai-behavior';

const Path = z.object({
  workspaceId: z.string().uuid(),
  campaignId: z.string().uuid(),
});

const CardKeyEnum = z.enum(
  AI_BEHAVIOR_CARD_KEYS as unknown as readonly [string, ...string[]],
);

const PatchCard = z.object({
  key: CardKeyEnum,
  status: z.enum(['draft', 'needs_setup', 'approved']).optional(),
  summary: z.string().max(4000).optional(),
  rule_payload: z.record(z.unknown()).optional(),
});

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

function parsePath<T extends z.ZodTypeAny>(s: T, params: unknown): z.infer<T> {
  const r = s.safeParse(params);
  if (!r.success) {
    throw new ValidationError(
      'Invalid path',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

function parseBody<T extends z.ZodTypeAny>(s: T, body: unknown): z.infer<T> {
  const r = s.safeParse(body);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

export async function registerAiBehaviorRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/campaigns/:campaignId/ai-behavior';

  app.get(base, { preHandler: READ }, async (req) => {
    const { campaignId } = parsePath(Path, req.params);
    const row = await behavior.getByCampaign(req.workspace!.id, campaignId);
    return ok({
      behavior: row,
      autoSendReady: behavior.isAutoSendReady(row),
    });
  });

  // PATCH one card. Body: { key, status?, summary?, rule_payload? }.
  app.patch(base, { preHandler: WRITE }, async (req) => {
    const { campaignId } = parsePath(Path, req.params);
    const input = parseBody(PatchCard, req.body);
    const row = await behavior.upsertCard(req.workspace!.id, campaignId, {
      key: input.key as typeof AI_BEHAVIOR_CARD_KEYS[number],
      status: input.status,
      summary: input.summary,
      rule_payload: input.rule_payload,
      approved_by: req.user?.id ?? null,
    });
    return ok({
      behavior: row,
      autoSendReady: behavior.isAutoSendReady(row),
    });
  });
}
