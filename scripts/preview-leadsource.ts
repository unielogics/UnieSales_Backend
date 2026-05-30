/**
 * One-off: preview a lead-source sheet — show columns + first rows.
 *   npx tsx scripts/preview-leadsource.ts <workspaceId> <campaignId> <sourceId>
 */
import { loadEnv } from '../src/config/env';
import { initDb, closeDb } from '../src/config/db';
import { preview } from '../src/services/lead-source.service';

async function main() {
  const [workspaceId, campaignId, sourceId] = process.argv.slice(2);
  await loadEnv();
  initDb();
  const r = await preview(workspaceId!, campaignId!, sourceId!, 3);
  console.log('TOTAL_ROWS', r.totalRows);
  console.log('COLUMNS', JSON.stringify(r.columns));
  console.log('ROWS', JSON.stringify(r.rows, null, 2));
  await closeDb();
}

main().catch((err) => {
  console.error('PREVIEW FAILED:', err?.message ?? err);
  process.exit(1);
});
