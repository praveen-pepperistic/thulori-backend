import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as 'YYYY-MM-DD' strings and BIGINT counts as numbers.
pg.types.setTypeParser(1082, v => v);
pg.types.setTypeParser(20, v => Number(v));

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    const c = config();
    pool = new pg.Pool({
      connectionString: c.DATABASE_URL,
      ssl: c.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], client: Queryable = db()): Promise<T[]> {
  const r = await client.query<T>(sql, params);
  return r.rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], client: Queryable = db()): Promise<T | null> {
  const rows = await q<T>(sql, params, client);
  return rows[0] ?? null;
}

/** Run fn inside a transaction; rolls back on any error. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb() { if (pool) { await pool.end(); pool = null; } }
