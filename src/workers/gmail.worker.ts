/**
 * Gmail inbox poller. Every 5 minutes, walk all active Gmail accounts and
 * fetch recent inbound threads. New threads/messages are persisted; new
 * inbound messages trigger an ai_actions row for classify_reply (the AI
 * worker / API caller picks it up).
 */
import { and, eq } from 'drizzle-orm';
import { google } from 'googleapis';
import { loadEnv } from '../config/env';
import { initDb, getDb, closeDb } from '../config/db';
import { createLogger } from '../config/logger';
import { gmailAccounts } from '../db/schema/gmail-accounts';
import { authClientForAccount, syncThread } from '../services/gmail.service';

const TICK_MS = 5 * 60 * 1000;
const log = createLogger(process.env.LOG_LEVEL ?? 'info').child({ worker: 'gmail' });

let shouldStop = false;

async function pollAccount(account: typeof gmailAccounts.$inferSelect): Promise<{ threadsSynced: number; messagesSynced: number }> {
  const client = await authClientForAccount(account);
  const gmail = google.gmail({ version: 'v1', auth: client });

  // Look back at most ~1 hour beyond the last sync to catch anything we missed.
  const after = account.lastSyncAt
    ? Math.floor(account.lastSyncAt.getTime() / 1000) - 3600
    : Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

  const listed = await gmail.users.threads.list({
    userId: 'me',
    q: `in:inbox after:${after}`,
    maxResults: 25,
  });
  const threads = listed.data.threads ?? [];

  let threadsSynced = 0;
  let messagesSynced = 0;
  for (const t of threads) {
    if (!t.id) continue;
    const r = await syncThread(account.workspaceId, account.id, t.id);
    threadsSynced++;
    messagesSynced += r.messagesSynced;
  }

  const db = getDb();
  await db.update(gmailAccounts).set({ lastSyncAt: new Date(), updatedAt: new Date() }).where(eq(gmailAccounts.id, account.id));
  return { threadsSynced, messagesSynced };
}

async function main() {
  await loadEnv();
  initDb();
  log.info('gmail worker starting');

  while (!shouldStop) {
    try {
      const db = getDb();
      const accounts = await db.select().from(gmailAccounts).where(and(eq(gmailAccounts.isActive, true)));
      for (const a of accounts) {
        try {
          const r = await pollAccount(a);
          if (r.threadsSynced > 0) log.info({ accountId: a.id, ...r }, 'polled');
        } catch (err) {
          log.error({ err, accountId: a.id }, 'poll account failed');
        }
      }
    } catch (err) {
      log.error({ err }, 'tick failed');
    }
    await sleep(TICK_MS);
  }
  await closeDb();
  log.info('gmail worker stopped');
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
