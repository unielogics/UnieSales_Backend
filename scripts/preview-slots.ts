/**
 * One-off: preview the open meeting slots the AI would offer for a workspace.
 *   npx tsx scripts/preview-slots.ts <workspaceId>
 */
import { loadEnv } from '../src/config/env';
import { initDb, closeDb } from '../src/config/db';
import { computeAvailableSlots, getCalendarConfig } from '../src/services/calendar.service';

async function main() {
  const workspaceId = process.argv[2];
  if (!workspaceId) throw new Error('usage: tsx scripts/preview-slots.ts <workspaceId>');
  await loadEnv();
  initDb();
  const cfg = await getCalendarConfig(workspaceId);
  console.log('CONFIG', JSON.stringify(cfg));
  const r = await computeAvailableSlots(workspaceId);
  console.log('SLOTS', JSON.stringify(r.slots.map((s) => s.label), null, 2));
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
