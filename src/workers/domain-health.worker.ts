import { loadEnv } from '../config/env';
import { initDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { checkAllActive } from '../services/domain-health.service';

const TICK_MS = 6 * 60 * 60 * 1000; // 6 hours
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'domain-health' });

let shouldStop = false;

async function main() {
  await loadEnv();
  initDb();
  log.info('domain-health worker starting');

  while (!shouldStop) {
    try {
      const stats = await checkAllActive();
      log.info({ stats }, 'domain-health tick');
    } catch (err) {
      log.error({ err }, 'domain-health tick failed');
    }
    await sleep(TICK_MS);
  }
  await closeDb();
  log.info('domain-health worker stopped');
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
