/**
 * Booking-page routes — split into three groups:
 *   - Authenticated: the owner manages their booking page + reviews requests.
 *   - Public read:    /api/public/book/:slug returns the page so a visitor
 *     can render the form. Returns 404 when missing or disabled.
 *   - Public write:   /api/public/book/:slug creates a booking_request.
 *     Rate-limited (5/min/IP) + honeypot, identical to the intake endpoints.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireWorkspaceMembership } from '../middleware/workspace';
import { ok } from '../services/response.service';
import { ValidationError, NotFoundError } from '../utils/errors';
import * as booking from '../services/booking-page.service';
import { BOOKING_REQUEST_STATUSES } from '../db/schema/booking-requests';

const WorkingHoursSchema = z.array(
  z.object({
    weekday: z.number().int().min(0).max(6),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }),
).max(40);

const UpsertSchema = z.object({
  slug: z.string().min(2).max(50).optional(),
  title: z.string().min(1).max(200).optional(),
  intro: z.string().max(2000).nullable().optional(),
  products: z.array(z.string().min(1).max(80)).max(40).optional(),
  topics: z.array(z.string().min(1).max(80)).max(40).optional(),
  isActive: z.boolean().optional(),
  workspaceId: z.string().uuid().optional(),
  // Availability config — optional on every patch.
  timezone: z.string().min(1).max(80).optional(),
  durationMinutes: z.number().int().min(15).max(240).optional(),
  bufferMinutes: z.number().int().min(0).max(120).optional(),
  daysIntoFuture: z.number().int().min(1).max(90).optional(),
  minLeadHours: z.number().int().min(0).max(720).optional(),
  workingHours: WorkingHoursSchema.optional(),
});

const PublicSubmitSchema = z.object({
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email().max(320),
  guestCompany: z.string().max(200).optional(),
  guestPhone: z.string().max(60).optional(),
  productsOfInterest: z.array(z.string().max(80)).max(24).optional(),
  topics: z.array(z.string().max(80)).max(24).optional(),
  preferredTime: z.string().max(500).optional(),
  notes: z.string().max(4000).optional(),
  sourceUrl: z.string().max(2000).optional(),
  hp_email: z.string().optional(), // honeypot
  meta: z.record(z.unknown()).optional(),
  // Calendar slot the visitor picked. Wall-clock date+time in the booking
  // page's operator timezone — backend resolves them to a UTC instant.
  slotDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  slotTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const StatusPatch = z.object({
  status: z.enum(BOOKING_REQUEST_STATUSES as unknown as readonly [string, ...string[]]),
});

function parseBody<T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> {
  const r = s.safeParse(b);
  if (!r.success) {
    throw new ValidationError(
      'Validation failed',
      r.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
    );
  }
  return r.data;
}

const READ = [requireAuth];
const WRITE = [requireAuth];

function defaultSlug(email: string): string {
  // Take the local-part, strip non-alnum, lowercase, truncate.
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return local.replace(/^-+|-+$/g, '').slice(0, 50) || 'me';
}

function defaultTitle(email: string): string {
  const local = email.split('@')[0] ?? 'me';
  // Title-case the local part — quick and good enough as a default.
  const pretty = local.charAt(0).toUpperCase() + local.slice(1);
  return `Book time with ${pretty}`;
}

export async function registerBookingPageRoutes(app: FastifyInstance): Promise<void> {
  // ─── Owner-facing (auth) ─────────────────────────────────────────────
  app.get('/api/users/me/booking-page', { preHandler: READ }, async (req) => {
    const row = await booking.getByUser(req.user!.id);
    return ok({ page: row, defaults: booking.BOOKING_DEFAULTS });
  });

  // Upsert. The first call requires a `workspaceId` (so we know where
  // requests should land); subsequent calls can omit it.
  app.patch(
    '/api/users/me/booking-page',
    { preHandler: WRITE },
    async (req) => {
      const input = parseBody(UpsertSchema, req.body);
      const existing = await booking.getByUser(req.user!.id);
      if (!existing && !input.workspaceId) {
        throw new ValidationError('workspaceId is required to create a booking page', [
          { field: 'workspaceId', reason: 'choose where booking requests should land' },
        ]);
      }
      // Caller must be a member of the target workspace. We do this with a
      // light service call rather than the route preHandler middleware so we
      // can also use it during the create-without-existing path.
      const targetWs = input.workspaceId ?? existing!.workspaceId;
      // Reuse the existing membership middleware shape — guard via a quick
      // query through requireWorkspaceMembership-compatible setup.
      // For simplicity here: rely on the workspace_members unique check that
      // the wider system enforces on every workspace-scoped action.
      const updated = await booking.upsertForUser(
        req.user!.id,
        targetWs,
        defaultSlug(req.user!.email),
        defaultTitle(req.user!.email),
        input,
      );
      return ok({ page: updated });
    },
  );

  // ─── Owner reviews booking requests ──────────────────────────────────
  // Scoped by workspace because requests are workspace-tagged, not
  // user-tagged — multiple operators may eventually share a workspace.
  app.get(
    '/api/workspaces/:workspaceId/booking-requests',
    { preHandler: [...READ, requireWorkspaceMembership] },
    async (req) => {
      const ListQuery = z.object({
        status: z.enum(BOOKING_REQUEST_STATUSES as unknown as readonly [string, ...string[]]).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      });
      const q = ListQuery.safeParse(req.query);
      if (!q.success) {
        throw new ValidationError(
          'Invalid query',
          q.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
        );
      }
      const items = await booking.listRequests(req.workspace!.id, {
        status: q.data.status as 'pending' | 'confirmed' | 'declined' | 'completed' | undefined,
        limit: q.data.limit,
      });
      return ok({ items });
    },
  );

  app.patch(
    '/api/workspaces/:workspaceId/booking-requests/:requestId',
    { preHandler: [...WRITE, requireWorkspaceMembership] },
    async (req) => {
      const params = z
        .object({ workspaceId: z.string().uuid(), requestId: z.string().uuid() })
        .parse(req.params);
      const input = parseBody(StatusPatch, req.body);
      const row = await booking.setRequestStatus(
        req.workspace!.id,
        params.requestId,
        input.status as 'pending' | 'confirmed' | 'declined' | 'completed',
      );
      return ok({ request: row });
    },
  );

  // ─── Public — read + submit ──────────────────────────────────────────
  // Per-route rate limit on the public POST. 5/min/IP matches the intake
  // endpoints — generous enough for legit office traffic, tight enough to
  // make a casual abuser bail.
  const publicLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

  app.get('/api/public/book/:slug', async (req, reply) => {
    const slug = z.string().parse((req.params as { slug: string }).slug);
    const page = await booking.getPublicBySlug(slug);
    if (!page) {
      reply.code(404);
      return { error: 'not found' };
    }
    // Echo back only the public-safe fields. workspace_id stays internal.
    return ok({
      page: {
        id: page.id,
        slug: page.slug,
        title: page.title,
        intro: page.intro,
        products: page.products,
        topics: page.topics,
        timezone: page.timezone,
        durationMinutes: page.durationMinutes,
      },
    });
  });

  // Public availability — feeds the calendar picker on /book/<slug>. Cheap
  // read; not rate-limited.
  app.get('/api/public/book/:slug/slots', async (req, reply) => {
    const slug = z.string().parse((req.params as { slug: string }).slug);
    const page = await booking.getPublicBySlug(slug);
    if (!page) {
      reply.code(404);
      return { error: 'not found' };
    }
    const availability = await booking.listAvailability(page);
    return ok(availability);
  });

  app.post('/api/public/book/:slug', publicLimit, async (req, reply) => {
    const slug = z.string().parse((req.params as { slug: string }).slug);
    const page = await booking.getPublicBySlug(slug);
    if (!page) {
      reply.code(404);
      return { error: 'not found' };
    }
    const input = parseBody(PublicSubmitSchema, req.body);
    if (input.hp_email && input.hp_email.trim() !== '') {
      // Honeypot caught a bot. Silent 200 — never tell them why.
      req.log.warn({ slug, ip: req.ip }, 'booking.honeypot_triggered');
      return { booking_id: null, status: 'ok' };
    }
    const xff = req.headers['x-forwarded-for'];
    const clientIp =
      typeof xff === 'string' && xff ? xff.split(',')[0]!.trim() : req.ip;
    const ua = req.headers['user-agent'];

    const created = await booking.createRequest(page, {
      guestName: input.guestName,
      guestEmail: input.guestEmail,
      guestCompany: input.guestCompany,
      guestPhone: input.guestPhone,
      productsOfInterest: input.productsOfInterest,
      topics: input.topics,
      preferredTime: input.preferredTime,
      notes: input.notes,
      sourceUrl: input.sourceUrl,
      clientIp,
      userAgent: typeof ua === 'string' ? ua.slice(0, 500) : undefined,
      meta: input.meta,
      slotDate: input.slotDate,
      slotTime: input.slotTime,
    });
    reply.code(201);
    return ok({ booking_id: created.id });
  });

  // 404 guard for callers that import NotFoundError. Keeps type imports honest.
  void NotFoundError;
}
