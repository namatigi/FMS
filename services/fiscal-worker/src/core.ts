import pg from 'pg';
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, base: Record<string, unknown> = {}): Logger {
  return pino({ level, base: { service: 'fiscal-worker', ...base }, timestamp: pino.stdTimeFunctions.isoTime });
}

// BIGINT → string (default), NUMERIC → string (default; converted explicitly where needed).
export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: 'fms-fiscal-worker' });
}

export type Queryable = Pick<pg.Pool | pg.PoolClient | pg.Client, 'query'>;

/** Run fn inside a transaction on a pooled client. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** Error carrying an explicit retry decision for the job runner. */
export class JobError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code?: string) {
    super(message);
    this.name = 'JobError';
  }
}

/** Non-retryable: the job is dead-lettered immediately. */
export const permanent = (message: string, code?: string) => new JobError(message, false, code);

/**
 * Retry decision for any thrown value. Errors exposing a boolean `retryable`
 * (JobError, @fms/shared FiscalError) are honoured; anything else is retried.
 * Duck-typed so it works across duplicated module instances.
 */
export function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && typeof (err as { retryable?: unknown }).retryable === 'boolean') {
    return (err as { retryable: boolean }).retryable;
  }
  return true;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return (err as Error & { code?: string }).code ? `${err.message} [${(err as { code?: string }).code}]` : err.message;
  return String(err);
}

/**
 * Exponential backoff with "equal jitter": half of the exponential delay is fixed,
 * the other half random, capped at maxMs. attempt is 1-based.
 */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, rand: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (rand() * exp) / 2);
}

/** Small payload validation helpers (throw non-retryable errors). */
export const req = {
  str(o: Record<string, unknown>, k: string): string {
    const v = o[k];
    if (typeof v !== 'string' || !v) throw permanent(`payload.${k} must be a non-empty string`, 'BAD_PAYLOAD');
    return v;
  },
  int(o: Record<string, unknown>, k: string): number {
    const v = typeof o[k] === 'string' ? Number(o[k]) : o[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) throw permanent(`payload.${k} must be an integer`, 'BAD_PAYLOAD');
    return v;
  },
  date(o: Record<string, unknown>, k: string): string {
    const v = req.str(o, k);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw permanent(`payload.${k} must be YYYY-MM-DD`, 'BAD_PAYLOAD');
    return v;
  },
  uuid(o: Record<string, unknown>, k: string): string {
    const v = req.str(o, k);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw permanent(`payload.${k} must be a UUID`, 'BAD_PAYLOAD');
    return v;
  },
  timestamp(o: Record<string, unknown>, k: string): string {
    const v = req.str(o, k);
    if (Number.isNaN(Date.parse(v))) throw permanent(`payload.${k} must be an ISO-8601 timestamp`, 'BAD_PAYLOAD');
    return v;
  },
};

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Local calendar date (YYYY-MM-DD) and time of an instant in a time zone. */
export function zonedNow(timeZone: string, at = new Date()): { date: string; hour: number; minute: number } {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Interruptible sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
