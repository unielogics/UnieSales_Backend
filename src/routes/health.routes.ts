import type { FastifyInstance } from 'fastify';
import { pingDb } from '../config/db';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (req, reply) => {
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';
    try {
      dbStatus = (await pingDb()) ? 'connected' : 'disconnected';
    } catch (err) {
      req.log.error({ err }, 'health: db ping failed');
    }

    // Health endpoint deliberately bypasses the standard envelope wrapper —
    // ops tools (load balancers, k8s probes) expect a flat body and the spec
    // shape includes top-level status/database fields. The onSend hook in
    // index.ts checks isEnvelope() and leaves this alone because it is already
    // a valid success envelope shape (with extra fields ignored).
    const body = {
      success: dbStatus === 'connected',
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      database: dbStatus,
      timestamp: new Date().toISOString(),
      data: null,
      message: dbStatus === 'connected' ? 'OK' : 'Database unreachable',
      errors: [],
    };

    return reply.status(dbStatus === 'connected' ? 200 : 503).send(body);
  });
}
