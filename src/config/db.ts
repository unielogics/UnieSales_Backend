import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from './env';

let pool: pg.Pool | null = null;
let db: NodePgDatabase | null = null;

export function initDb(): NodePgDatabase {
  if (db) return db;
  const { DATABASE_URL, NODE_ENV } = env();

  // RDS requires SSL. In v1 accept the AWS-issued cert without explicit CA bundle.
  // Tighten with rds-ca-rsa2048-g1 bundle if compliance demands it.
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: NODE_ENV === 'production' ? 20 : 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[pg pool] unexpected error on idle client', err);
  });

  db = drizzle(pool);
  return db;
}

export function getDb(): NodePgDatabase {
  if (!db) throw new Error('getDb() called before initDb() — call initDb() at boot.');
  return db;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('getPool() called before initDb() — call initDb() at boot.');
  return pool;
}

export async function pingDb(): Promise<boolean> {
  if (!pool) return false;
  const res = await pool.query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
