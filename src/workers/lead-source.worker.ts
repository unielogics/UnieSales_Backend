/**
 * Lead-source sync worker. Every 15 minutes it:
 *   - auto-imports any newly connected, column-mapped source (no manual click)
 *   - re-imports google_sheet sources on their configured refresh frequency,
 *     pulling in rows added to the sheet since the last import.
 */
import { loadEnv } from '../config/env';
import { initDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { importAllDue } from '../services/lead-source.service';

const TICK_MS = 15 * 60 * 1000;
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'lead-source' });

let shouldStop = false;

async function main() {
  await loadEnv();
  initDb();
  log.info('lead-source worker starting');

  while (!shouldStop) {
    try {
      const r = await importAllDue();
      if (r.imported > 0 || r.failed > 0) log.info({ r }, 'lead-source sync');
    } catch (err) {
      log.error({ err }, 'tick failed');
    }
    await sleep(TICK_MS);
  }
  await closeDb();
  log.info('lead-source worker stopped');
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
