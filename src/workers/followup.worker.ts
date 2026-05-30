import { loadEnv } from '../config/env';
import { initDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { runFollowups } from '../services/followup.service';

const TICK_MS = 10 * 60 * 1000; // 10 minutes
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'followup' });

let shouldStop = false;

async function main() {
  await loadEnv();
  initDb();
  log.info('followup worker starting');

  while (!shouldStop) {
    try {
      const stats = await runFollowups({ limit: 50 });
      if (stats.scanned > 0 || stats.coldQueued > 0) log.info({ stats }, 'followup tick');
    } catch (err) {
      log.error({ err }, 'followup tick failed');
    }
    await sleep(TICK_MS);
  }
  await closeDb();
  log.info('followup worker stopped');
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
