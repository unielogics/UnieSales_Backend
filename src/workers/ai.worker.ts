/**
 * AI worker. v1 design: most AI calls are issued inline from API routes (score,
 * generate-email, classify-reply, etc), so the queue is mostly empty in steady
 * state. This worker exists for:
 *   1. Future async jobs queued by other workers (e.g. gmail poller queueing a
 *      classify_reply when a new inbound arrives).
 *   2. Retrying ai_actions rows in `pending` state that weren't completed.
 *
 * For now we just heartbeat and log queue depth. The full processor lands when
 * the gmail worker starts enqueueing pending actions.
 */
import { and, eq, sql } from 'drizzle-orm';
import { loadEnv } from '../config/env';
import { initDb, getDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { aiActions } from '../db/schema/ai-actions';

const TICK_MS = 30 * 1000;
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'ai' });

let shouldStop = false;

async function main() {
  await loadEnv();
  initDb();
  log.info('ai worker starting');

  while (!shouldStop) {
    try {
      const db = getDb();
      const [counts] = await db
        .select({
          pending: sql<number>`sum(case when ${aiActions.status} = 'pending' then 1 else 0 end)::int`,
          processing: sql<number>`sum(case when ${aiActions.status} = 'processing' then 1 else 0 end)::int`,
        })
        .from(aiActions);
      const pending = counts?.pending ?? 0;
      if (pending > 0) log.info({ pending, processing: counts?.processing ?? 0 }, 'ai queue depth');

      // Reap stuck `processing` rows older than 10 minutes (a crashed inline call)
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const stuck = await db
        .update(aiActions)
        .set({ status: 'failed', reason: 'worker reaped: processing > 10m', completedAt: new Date() })
        .where(and(eq(aiActions.status, 'processing'), sql`${aiActions.createdAt} < ${tenMinAgo}`))
        .returning({ id: aiActions.id });
      if (stuck.length > 0) log.warn({ reaped: stuck.length }, 'reaped stuck ai_actions');
    } catch (err) {
      log.error({ err }, 'tick failed');
    }
    await sleep(TICK_MS);
  }
  await closeDb();
  log.info('ai worker stopped');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('SIGINT', () => { shouldStop = true; });
process.on('SIGTERM', () => { shouldStop = true; });

main().catch((err) => {
  log.fatal({ err }, 'fatal');
  process.exit(1);
});
