/**
 * Apply Drizzle migrations against DATABASE_URL.
 * Phase 0: no migrations yet; this script will be a no-op until schema files exist.
 * Phase 1: migrations folder will be populated by `drizzle-kit generate`.
 */
import { loadEnv } from '../src/config/env';
import { initDb, getPool, closeDb } from '../src/config/db';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import fs from 'node:fs';
import path from 'node:path';

async function main(): Promise<void> {
  await loadEnv();
  initDb();

  const migrationsFolder = path.resolve(process.cwd(), 'src/db/migrations');
  if (!fs.existsSync(migrationsFolder) || fs.readdirSync(migrationsFolder).length === 0) {
    console.log('[migrate] no migration files yet — nothing to apply');
    await closeDb();
    return;
  }

  const db = drizzle(getPool());
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('[migrate] done');
  await closeDb();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
