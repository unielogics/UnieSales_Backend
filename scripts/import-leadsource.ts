/**
 * One-off: run the lead-source import for a campaign source.
 *   npx tsx scripts/import-leadsource.ts <workspaceId> <campaignId> <sourceId>
 */
import { loadEnv } from '../src/config/env';
import { initDb, closeDb } from '../src/config/db';
import { importNow } from '../src/services/lead-source.service';

async function main() {
  const [workspaceId, campaignId, sourceId] = process.argv.slice(2);
  if (!workspaceId || !campaignId || !sourceId) {
    throw new Error('usage: tsx scripts/import-leadsource.ts <workspaceId> <campaignId> <sourceId>');
  }
  await loadEnv();
  initDb();
  const result = await importNow(workspaceId, campaignId, sourceId);
  console.log('IMPORT RESULT', JSON.stringify(result));
  await closeDb();
}

main().catch((err) => {
  console.error('IMPORT FAILED:', err?.message ?? err);
  console.error(err);
  process.exit(1);
});
