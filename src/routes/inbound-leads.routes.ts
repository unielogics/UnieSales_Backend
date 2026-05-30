/**
 * Inbound Leads — workspace-scoped routes that surface the leads landing
 * through the public-intake endpoints. Filterable by site, tag, and a
 * coarse "filter" chip (needs_review / booking_ready / handoff_required /
 * closed). Read-only in v1; mutations happen via the existing leads routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError } from '../utils/errors';
import * as inbound from '../services/inbound-leads.service';
import { INTAKE_SITES, SITE_TAGS } from '../config/intake-routing';

const Path = z.object({ workspaceId: z.string().uuid() });

const READ = [requireAuth, requireWorkspaceMembership];

// z.enum needs a non-empty readonly tuple — cast from the const array.
const SiteEnum = z.enum(INTAKE_SITES as unknown as readonly [string, ...string[]]).optional();

const ListQuery = z.object({
  site: SiteEnum,
  tag: z.string().max(60).optional(),
  filter: z.enum(['all', 'needs_review', 'booking_ready', 'handoff_required', 'closed']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  // 'true' | '1' to include sales_training_test rows. Default omitted → false.
  includeTests: z.union([z.literal('true'), z.literal('1')]).optional(),
});

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

function parseQuery<T extends z.ZodTypeAny>(s: T, query: unknown): z.infer<T> {
  const r = s.safeParse(query);
  if (!r.success) {
    throw new ValidationError(
      'Invalid query',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

export async function registerInboundLeadsRoutes(app: FastifyInstance): Promise<void> {
  const base = '/api/workspaces/:workspaceId/inbound-leads';

  app.get(base, { preHandler: READ }, async (req) => {
    parsePath(Path, req.params);
    const q = parseQuery(ListQuery, req.query);
    // Cross-validate: if a tag is supplied, it must belong to the site (or
    // any site if no site is provided).
    if (q.tag && q.site) {
      const allowed = SITE_TAGS[q.site as keyof typeof SITE_TAGS] as readonly string[];
      if (!allowed.includes(q.tag)) {
        throw new ValidationError('Unknown tag for site', [
          { field: 'tag', reason: `${q.tag} not in site ${q.site}` },
        ]);
      }
    }
    const result = await inbound.list(req.workspace!.id, {
      site: q.site as inbound.InboundLeadsFilters['site'],
      tag: q.tag,
      filter: q.filter,
      limit: q.limit,
      offset: q.offset,
      includeTests: q.includeTests != null,
    });
    return ok(result);
  });

  app.get(`${base}/counts`, { preHandler: READ }, async (req) => {
    parsePath(Path, req.params);
    const rows = await inbound.counts(req.workspace!.id);
    return ok({ items: rows });
  });
}
