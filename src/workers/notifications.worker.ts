import { loadEnv } from '../config/env';
import { initDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { scanMeetingReminders } from '../services/meeting-reminder.service';
import { scanPostCallOutcomes } from '../services/calendar.service';

const TICK_MS = 5 * 60 * 1000; // 5 minutes — drives meeting reminder scans
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'notifications' });

let shouldStop = false;

async function main() {
  await loadEnv();
  initDb();
  log.info('notifications worker starting');

  while (!shouldStop) {
    try {
      const meetings = await scanMeetingReminders();
      if (meetings.guest24h || meetings.guest1h || meetings.operator30m) {
        log.info(meetings, 'meeting reminders sent');
      }
      const postCall = await scanPostCallOutcomes();
      if (postCall) {
        log.info({ postCall }, 'post-call outcome prompts queued');
      }
    } catch (err) {
      log.error({ err }, 'notifications scan failed');
    }

    await sleep(TICK_MS);
  }

  await closeDb();
  log.info('notifications worker stopped');
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
