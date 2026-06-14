import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership, requireWorkspaceRole } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as costs from '../services/cost.service';

const READ = [requireAuth, requireWorkspaceMembership];
const WRITE = [requireAuth, requireWorkspaceMembership, requireWorkspaceRole('admin')];

const Query = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  campaignId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  provider: z.string().optional(),
  category: z.string().optional(),
  costSource: z.enum(['exact', 'estimated', 'manual_rate']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const RatePatch = z.object({
  provider: z.string().min(1).max(80),
  service: z.string().min(1).max(120),
  category: z.string().min(1).max(80),
  actionType: z.string().max(120).nullable().optional(),
  unit: z.string().min(1).max(80),
  unitCostUsd: z.number().min(0),
});

function parseQuery(q: unknown): z.infer<typeof Query> {
  const r = Query.safeParse(q);
  if (!r.success) {
    throw new ValidationError(
      'Invalid query',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

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

function filters(q: z.infer<typeof Query>) {
  return {
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    campaignId: q.campaignId,
    leadId: q.leadId,
    provider: q.provider,
    category: q.category,
    costSource: q.costSource,
  };
}

export async function registerCostRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/cost';

  app.get(`${base}/summary`, { preHandler: READ }, async (req) => {
    const q = parseQuery(req.query);
    return ok(await costs.getSummary(req.workspace!.id, filters(q)));
  });

  app.get(`${base}/campaigns`, { preHandler: READ }, async (req) => {
    const q = parseQuery(req.query);
    return ok({ campaigns: await costs.getCampaignCosts(req.workspace!.id, filters(q)) });
  });

  app.get(`${base}/leads`, { preHandler: READ }, async (req) => {
    const q = parseQuery(req.query);
    return ok({ leads: await costs.getLeadCosts(req.workspace!.id, filters(q)) });
  });

  app.get(`${base}/events`, { preHandler: READ }, async (req) => {
    const q = parseQuery(req.query);
    return ok({ events: await costs.listEvents(req.workspace!.id, { ...filters(q), limit: q.limit, offset: q.offset }) });
  });

  app.get(`${base}/rates`, { preHandler: READ }, async (req) => {
    return ok({ rates: await costs.listRates(req.workspace!.id) });
  });

  app.patch(`${base}/rates`, { preHandler: WRITE }, async (req) => {
    const body = parseBody(RatePatch, req.body);
    return ok({ rate: await costs.updateRate(req.workspace!.id, body) }, 'Rate updated');
  });

  app.post(`${base}/backfill`, { preHandler: WRITE }, async (req) => {
    return ok(await costs.backfillWorkspaceCosts(req.workspace!.id), 'Cost ledger backfilled');
  });
}
