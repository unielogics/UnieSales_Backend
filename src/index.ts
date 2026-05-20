import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnv } from './config/env.js';
import { pinoOptions } from './config/logger.js';
import { closeDb, initDb, pingDb } from './config/db.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { isEnvelope, ok } from './services/response.service.js';

async function main(): Promise<void> {
  const e = await loadEnv();

  initDb();

  const app = Fastify({
    logger: pinoOptions(e.LOG_LEVEL),
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    bodyLimit: 50 * 1024 * 1024, // 50MB — knowledge uploads
  });

  const corsOrigins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : [e.FRONTEND_URL],
    credentials: true,
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
