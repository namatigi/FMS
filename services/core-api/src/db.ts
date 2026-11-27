import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// NUMERIC -> number, BIGINT -> number (counts/ids well below 2^53), DATE -> 'YYYY-MM-DD'.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

export interface Db {
  primary: pg.Pool;
  /** Read pool (DATABASE_URL_RO), falls back to primary. */
  ro: pg.Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, databaseUrlRo: string | null): Db {
  const primary = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.PG_POOL_MAX ?? 20), application_name: 'core-api' });
  const ro = databaseUrlRo
    ? new pg.Pool({ connectionString: databaseUrlRo, max: Number(process.env.PG_POOL_RO_MAX ?? 20), application_name: 'core-api-ro' })
    : primary;
  for (const p of new Set([primary, ro])) p.on('error', () => { /* idle client error: pool discards the client */ });
  let closed = false;
  return {
    primary,
    ro,
    async close() {
      if (closed) return;
      closed = true;
      await primary.end();
      if (ro !== primary) await ro.end();
    },
  };
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATION_LOCK = 727273;

export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'migrations');
}

/** Apply services/core-api/migrations/*.sql once each, serialised by an advisory lock. */
export async function runMigrations(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await c.query(`CREATE TABLE IF NOT EXISTS fms.core_api_migrations (
        name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await c.query<{ name: string }>('SELECT name FROM fms.core_api_migrations');
    const done = new Set(rows.map((r) => r.name));
    const dir = migrationsDir();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO fms.core_api_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
        log(`applied core-api migration ${f}`);
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    c.release();
  }
  return applied;
}
