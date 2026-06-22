import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { loadEnv } from './config/env';
import { pinoOptions } from './config/logger';
import { closeDb, initDb, pingDb } from './config/db';
import { registerErrorHandler } from './middleware/error-handler';
import { registerHealthRoutes } from './routes/health.routes';
import { registerAuthRoutes } from './routes/auth.routes';
import { registerWorkspaceRoutes } from './routes/workspaces.routes';
import { registerCampaignRoutes } from './routes/campaigns.routes';
import { registerCampaignSetupRoutes } from './routes/campaign-setup.routes';
import { registerKnowledgeRoutes } from './routes/knowledge.routes';
import { registerLeadSourceRoutes } from './routes/lead-sources.routes';
import { registerLeadRoutes } from './routes/leads.routes';
import { registerGmailRoutes } from './routes/gmail.routes';
import { registerDriveRoutes } from './routes/drive.routes';
import { registerAiActionRoutes } from './routes/ai-actions.routes';
import { registerCampaignTrainingRoutes } from './routes/campaign-training.routes';
import { registerThreadRoutes } from './routes/threads.routes';
import { registerHandoffRoutes } from './routes/handoff.routes';
import { registerCalendarRoutes } from './routes/calendar.routes';
import { registerFollowupRoutes } from './routes/followups.routes';
import { registerDomainHealthRoutes } from './routes/domain-health.routes';
import { registerTwilioRoutes } from './routes/twilio.routes';
import { registerPublicIntakeRoutes } from './routes/public-intake.routes';
import { registerInboundLeadsRoutes } from './routes/inbound-leads.routes';
import { registerSalesActivityRoutes } from './routes/sales-activity.routes';
import { registerSalesTrainingRoutes } from './routes/sales-training.routes';
import { registerBookingPageRoutes } from './routes/booking-pages.routes';
import { registerNotificationRoutes } from './routes/notifications.routes';
import { registerNotificationSettingsRoutes } from './routes/notification-settings.routes';
import { isAllowedIntakeOrigin } from './config/intake-routing';
import { isEnvelope, ok } from './services/response.service';
// Side-effect import: augments FastifyRequest with user + workspace
import './types/api';

async function main(): Promise<void> {
  const e = await loadEnv();

  initDb();

  const app = Fastify({
    logger: pinoOptions(e.LOG_LEVEL),
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    bodyLimit: 50 * 1024 * 1024, // 50MB — knowledge uploads
  });

  // Helmet — sane HTTP security defaults
  await app.register(helmet, {
    contentSecurityPolicy: false, // backend is an API; CSP is the frontend's concern
  });

  // CORS allowlist. We use an origin callback (not a static list) so we can
  // accept Amplify preview subdomains (*.amplifyapp.com) for the three public
  // intake sites without enumerating every preview URL. The callback consults:
  //   1) The configured CORS_ORIGINS env list (exact match, app + admin UIs)
  //   2) The intake-routing allowlist (exact hosts + amplifyapp.com suffix)
  // Requests with no Origin header (e.g. server-to-server) pass through —
  // CORS only matters for browsers.
  const corsOrigins = new Set(
    e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).concat(e.FRONTEND_URL),
  );
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.has(origin)) return cb(null, true);
      if (isAllowedIntakeOrigin(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  });

  // Twilio webhooks POST application/x-www-form-urlencoded — Fastify needs
  // this parser to populate req.body for them.
  await app.register(formbody);

  // Global rate limit: 600 req/min per IP. Tune later if abusive clients appear.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
  });

  // Slow query log: warn on any handler taking longer than 1s.
  app.addHook('onResponse', async (req, reply) => {
    const ms = reply.elapsedTime;
    if (ms > 1000) {
      req.log.warn({ ms: Math.round(ms), path: req.url, status: reply.statusCode }, 'slow request');
    }
  });

  registerErrorHandler(app);

  // Auto-wrap 2xx JSON responses in the standard envelope unless the handler
  // already returned one. Skips non-JSON and error responses.
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400) return payload;
    const ct = reply.getHeader('content-type');
    if (typeof ct === 'string' && !ct.includes('application/json')) return payload;
    if (typeof payload !== 'string') return payload;
    try {
      const parsed = JSON.parse(payload);
      if (isEnvelope(parsed)) return payload;
      return JSON.stringify(ok(parsed));
    } catch {
      return payload;
    }
  });

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerWorkspaceRoutes(app);
  await registerCampaignRoutes(app);
  await registerCampaignSetupRoutes(app);
  await registerKnowledgeRoutes(app);
  await registerLeadSourceRoutes(app);
  await registerLeadRoutes(app);
  await registerGmailRoutes(app);
  await registerDriveRoutes(app);
  await registerAiActionRoutes(app);
  await registerCampaignTrainingRoutes(app);
  await registerThreadRoutes(app);
  await registerHandoffRoutes(app);
  await registerCalendarRoutes(app);
  await registerFollowupRoutes(app);
  await registerDomainHealthRoutes(app);
  await registerTwilioRoutes(app);
  await registerPublicIntakeRoutes(app);
  await registerInboundLeadsRoutes(app);
  await registerSalesActivityRoutes(app);
  await registerSalesTrainingRoutes(app);
  await registerBookingPageRoutes(app);
  await registerNotificationRoutes(app);
  await registerNotificationSettingsRoutes(app);

  app.get('/', async () => ok({ name: 'uniesales-api', version: '0.1.0' }));

  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  // Sanity-ping the DB at boot so we fail fast if RDS is misconfigured.
  try {
    const dbOk = await pingDb();
    if (!dbOk) app.log.warn('boot: database ping returned false — continuing');
  } catch (err) {
    app.log.error({ err }, 'boot: could not connect to database');
    if (e.NODE_ENV === 'production') {
      throw err;
    }
  }

  await app.listen({ host: '0.0.0.0', port: e.PORT });
  app.log.info({ port: e.PORT, env: e.NODE_ENV }, 'uniesales-api listening');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', err);
  process.exit(1);
});
