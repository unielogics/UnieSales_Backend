import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../utils/errors';
import { verifyCortexHmac } from '../services/intake.service';
import * as salesIntake from '../services/public-sales-intake.service';

const ContactSchema = z.object({
  contactName: z.string().max(200).optional(),
  email: z.string().email().max(320),
  phone: z.string().max(60).optional(),
  company: z.string().max(200).optional(),
  title: z.string().max(120).optional(),
});

const CatalogAuditSchema = z.object({
  tag: z.literal('website_catalog_audit'),
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

function rateLimitConfig(max: number) {
  return { config: { rateLimit: { max, timeWindow: '1 minute' } } };
}

export async function registerPublicSalesIntakeRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (instance) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
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

    instance.post(
      '/api/public/sales-intake/unieconnect-catalog-audit',
      rateLimitConfig(60),
      async (req, reply) => {
        const sigHeader = req.headers['x-uniesales-signature'];
        const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
        const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
        if (!rawBody) {
          req.log.warn('catalog sales intake: rawBody missing');
          reply.code(500);
          return { error: 'server misconfigured' };
        }
        if (!verifyCortexHmac(rawBody, sig)) {
          req.log.warn(
            { ip: clientIpFrom(req), sigPresent: Boolean(sig) },
            'catalog sales intake: invalid HMAC',
          );
          reply.code(401);
          return { error: 'invalid signature' };
        }
        const parsed = CatalogAuditSchema.safeParse(req.body);
        if (!parsed.success) {
          throw new ValidationError(
            'Validation failed',
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), reason: i.message })),
          );
        }
        const result = await salesIntake.submitCatalogAuditSalesIntake(parsed.data);
        reply.code(result.status === 'created' ? 201 : 200);
        return result;
      },
    );
  });
}
