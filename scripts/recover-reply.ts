/**
 * One-off recovery: run the autonomous reply pipeline against an already-synced
 * inbound reply (one that landed before processInboundReply existed).
 *
 *   npx tsx scripts/recover-reply.ts <emailThreadId>
 */
import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env';
import { initDb, getDb, closeDb } from '../src/config/db';
import { emailThreads } from '../src/db/schema/email-threads';
import { processInboundReply } from '../src/services/reply.service';

async function main() {
  const threadId = process.argv[2];
  if (!threadId) throw new Error('usage: tsx scripts/recover-reply.ts <emailThreadId>');

  await loadEnv();
  initDb();

  const db = getDb();
  const rows = await db.select().from(emailThreads).where(eq(emailThreads.id, threadId)).limit(1);
  const t = rows[0];
  if (!t) throw new Error(`thread ${threadId} not found`);
  if (!t.leadId || !t.campaignId) throw new Error('thread is missing lead/campaign linkage');

  const res = await processInboundReply({
    workspaceId: t.workspaceId,
    threadId: t.id,
    leadId: t.leadId,
    campaignId: t.campaignId,
  });
  console.log('RECOVER RESULT', JSON.stringify(res));
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
