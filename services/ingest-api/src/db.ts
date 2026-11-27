import pg from 'pg';
import type { Config } from './config.js';

// Return NUMERIC as JS numbers (volumes/amounts fit comfortably in a double) and int8 as numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)) as unknown as number);
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)) as unknown as number);

export function createPool(cfg: Config): pg.Pool {
  return new pg.Pool({
    connectionString: cfg.databaseUrl,
    max: cfg.pgPoolMax,
    idleTimeoutMillis: cfg.pgIdleTimeoutMs,
    connectionTimeoutMillis: 5000,
    statement_timeout: cfg.pgStatementTimeoutMs,
    application_name: 'fms-ingest-api',
  });
}

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** SQLSTATEs that indicate a transient condition: retry later, do not treat the data as bad. */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (!code) {
    // connection-level errors from node-postgres carry no SQLSTATE
    return /ECONN|ETIMEDOUT|EPIPE|timeout|Connection terminated/i.test(String((err as Error)?.message ?? err));
  }
  return (
    code.startsWith('08') || // connection exception
    code.startsWith('40') || // transaction rollback (serialization, deadlock)
    code.startsWith('53') || // insufficient resources
    code.startsWith('57') || // operator intervention (query_canceled = statement_timeout, admin shutdown)
    code === '55P03' // lock_not_available
  );
}

export function isRetryableTxError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '40P01' || code === '40001';
}

/** Run fn inside a transaction; retries deadlock/serialization failures once. */
export async function withTx<T>(pool: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      if (attempt < 2 && isRetryableTxError(err)) continue;
      throw err;
    } finally {
      c.release();
    }
  }
}
