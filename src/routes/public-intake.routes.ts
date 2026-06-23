/**
 * Public intake — three site-scoped POST endpoints. PUBLIC (no auth).
 *
 *   POST /api/public/intake/uniewms     (browser; CORS-allowed; rate-limited; honeypot)
 *   POST /api/public/intake/unielogics  (browser; same)
 *   POST /api/public/intake/uniecortex  (server-to-server; HMAC-signed)
 *
 * Each route is the single integration point for one site. The site is
 * derived from the URL; the `tag` body field selects which form on that site
 * fired (e.g. `talk_to_sales` vs `warehouse_review` for uniewms). The body
 * envelope is fixed; the per-form payload arrives in `body.fields` and lands
 * verbatim in `leads.custom_fields` for AI consumption.
 *
 * For the uniecortex route we need access to the raw request body to verify
 * the HMAC. We register a per-plugin JSON parser that captures it on
 * `(req as any).rawBody` — limited to this plugin scope so the rest of the
 * API's JSON parsing is unchanged.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ValidationError, ConflictError } from '../utils/errors';
import * as intake from '../services/intake.service';
import { SITE_TAGS, type IntakeSite } from '../config/intake-routing';

const ContactSchema = z.object({
  contactName: z.string().max(200).optional(),
  email: z.string().email().max(320),
  phone: z.string().max(60).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(120).optional(),
});

function buildBrowserSchema(site: 'uniewms' | 'unielogics') {
  return z.object({
    // z.enum() needs a non-empty readonly tuple — cast from the per-site list.
    tag: z.enum(SITE_TAGS[site] as unknown as readonly [string, ...string[]]),
    page_url: z.string().url().max(2000),
    contact: ContactSchema,
    fields: z.record(z.unknown()).optional().default({}),
    meta: z.record(z.unknown()).optional().default({}),
    // Honeypot: a real browser-rendered field hidden via CSS that legitimate
    // users never fill in. If set, we short-circuit to a silent 200 — never
    // give bots an error signal.
    hp_email: z.string().optional(),
  });
}

const CortexSchema = z.object({
  tag: z.enum(SITE_TAGS.uniecortex as unknown as readonly [string, ...string[]]),
  page_url: z.string().url().max(2000),
  contact: ContactSchema,
  fields: z.record(z.unknown()).optional().default({}),
  meta: z.record(z.unknown()).optional().default({}),
});

function clientIpFrom(req: FastifyRequest): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0]!.trim();
  return req.ip;
}

function userAgentFrom(req: FastifyRequest): string | undefined {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 500) : undefined;
}

/**
 * Per-route rate-limit override. 5/min/IP for browser endpoints — a deliberate
 * launch ceiling that won't block office networks or operator QA traffic;
 * tighten later if real abuse appears. The cortex endpoint gets 60/min since
 * it's a single trusted upstream.
 */
function rateLimitConfig(max: number) {
  return { config: { rateLimit: { max, timeWindow: '1 minute' } } };
}

function verifySignedCortexRequest(req: FastifyRequest, reply: { code: (statusCode: number) => unknown }): boolean {
  const sigHeader = req.headers['x-uniesales-signature'];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    req.log.warn('cortex intake: rawBody missing — content-type parser misconfigured');
    reply.code(500);
    return false;
  }
  if (!intake.verifyCortexHmac(rawBody, sig)) {
    req.log.warn(
      { ip: clientIpFrom(req), sigPresent: !!sig },
      'cortex intake: invalid HMAC',
    );
    reply.code(401);
    return false;
  }
  return true;
}

export async function registerPublicIntakeRoutes(app: FastifyInstance): Promise<void> {
  // Scope the raw-body content parser to this plugin so we don't disturb
  // JSON parsing elsewhere in the API.
  await app.register(async (instance) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        // Capture raw bytes for HMAC verification on the cortex route.
        // Stored on the request object via a typed augmentation below.
        (req as unknown as { rawBody?: Buffer }).rawBody = body as Buffer;
        const text = (body as Buffer).toString('utf-8');
        if (!text.trim()) return done(null, {});
        try {
          done(null, JSON.parse(text));
        } catch (err) {
          done(err as Error);
        }
      },
    );

    // ---- uniewms — browser endpoint ----
    instance.post(
      '/api/public/intake/uniewms',
      rateLimitConfig(5),
      async (req, reply) => {
        const parsed = buildBrowserSchema('uniewms').safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            'Validation failed',
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
          );
        }
        if (parsed.data.hp_email && parsed.data.hp_email.trim() !== '') {
          req.log.warn(
            { ip: clientIpFrom(req), tag: parsed.data.tag },
            'intake.honeypot_triggered',
          );
          return { lead_id: null, status: 'ok' };
        }
        const result = await intake.submit({
          site: 'uniewms',
          body: parsed.data,
          clientIp: clientIpFrom(req),
          userAgent: userAgentFrom(req),
        });
        reply.code(201);
        return result;
      },
    );

    // ---- unielogics — browser endpoint ----
    instance.post(
      '/api/public/intake/unielogics',
      rateLimitConfig(5),
      async (req, reply) => {
        const parsed = buildBrowserSchema('unielogics').safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            'Validation failed',
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
          );
        }
        if (parsed.data.hp_email && parsed.data.hp_email.trim() !== '') {
          req.log.warn(
            { ip: clientIpFrom(req), tag: parsed.data.tag },
            'intake.honeypot_triggered',
          );
          return { lead_id: null, status: 'ok' };
        }
        const result = await intake.submit({
          site: 'unielogics',
          body: parsed.data,
          clientIp: clientIpFrom(req),
          userAgent: userAgentFrom(req),
        });
        reply.code(201);
        return result;
      },
    );

    // ---- uniecortex — server-to-server endpoint (HMAC-signed) ----
    instance.post(
      '/api/public/intake/uniecortex',
      rateLimitConfig(60),
      async (req, reply) => {
        if (!verifySignedCortexRequest(req, reply)) return { error: reply.statusCode === 401 ? 'invalid signature' : 'server misconfigured' };
        const parsed = CortexSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            'Validation failed',
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
          );
        }
        const result = await intake.submit({
          site: 'uniecortex',
          body: parsed.data,
          clientIp: clientIpFrom(req),
          userAgent: userAgentFrom(req),
        });
        reply.code(201);
        return result;
      },
    );
  });
}

// Augment FastifyRequest typing so downstream handlers can read rawBody when
// the per-plugin parser ran. Not exported; the public API is just the routes.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

// Avoid "unused" lint on the type-narrowed IntakeSite import — keeps the
// per-site enum mapping pinned to the type the service expects.
type _SiteEnsure = IntakeSite;
void (null as unknown as _SiteEnsure);
