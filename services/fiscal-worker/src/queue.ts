import type pg from 'pg';
import { backoffMs, errorMessage, isRetryable, type Queryable } from './core.js';

export interface Job<P = Record<string, unknown>> {
  id: string;
  kind: string;
  payload: P;
  dedupe_key: string | null;
  status: 'queued' | 'running' | 'done' | 'dead';
  run_at: Date;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export interface EnqueueOptions {
  kind: string;
  payload: unknown;
  dedupeKey?: string | null;
  runAt?: Date | null;
  maxAttempts?: number;
}

export type FailOutcome = { outcome: 'retry'; runAt: Date } | { outcome: 'dead' } | { outcome: 'lost' };

/**
 * Durable job queue over fms.jobs. Claims use FOR UPDATE SKIP LOCKED so any number of
 * worker replicas can poll concurrently without contention or double-processing.
 */
export class JobQueue {
  constructor(
    private readonly db: pg.Pool,
    private readonly opts: { backoffBaseMs: number; backoffMaxMs: number; rand?: () => number },
  ) {}

  /** Insert a job; returns its id, or null if a job with the same dedupe_key already exists. */
  async enqueue(o: EnqueueOptions, client: Queryable = this.db): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO fms.jobs (kind, payload, dedupe_key, run_at, max_attempts)
       VALUES ($1, $2::jsonb, $3, coalesce($4::timestamptz, now()), coalesce($5::int, 20))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [o.kind, JSON.stringify(o.payload), o.dedupeKey ?? null, o.runAt ?? null, o.maxAttempts ?? null],
    );
    return rows[0]?.id ?? null;
  }

  /** Atomically lease up to `limit` ready jobs of the given kinds. Increments attempts. */
  async claim(kinds: readonly string[], limit: number, workerId: string): Promise<Job[]> {
    if (limit <= 0 || kinds.length === 0) return [];
    const { rows } = await this.db.query<Job>(
      `UPDATE fms.jobs j
          SET status = 'running', locked_by = $3, locked_at = now(), attempts = j.attempts + 1
        WHERE j.id IN (
              SELECT id FROM fms.jobs
               WHERE status = 'queued' AND run_at <= now() AND kind = ANY($1)
               ORDER BY run_at
               FOR UPDATE SKIP LOCKED
               LIMIT $2)
       RETURNING j.*`,
      [kinds, limit, workerId],
    );
    return rows;
  }

  /** Mark a leased job done. Returns false if the lease was lost (recovered by another worker). */
  async complete(job: Job, workerId: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE fms.jobs SET status = 'done', locked_by = NULL, locked_at = NULL, last_error = NULL
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [job.id, workerId],
    );
    return r.rowCount === 1;
  }

  /**
   * Record a failure: re-queue with exponential backoff + jitter, or dead-letter when the
   * error is non-retryable or max_attempts is reached.
   */
  async fail(job: Job, workerId: string, err: unknown): Promise<FailOutcome> {
    const msg = errorMessage(err).slice(0, 4000);
    const dead = !isRetryable(err) || job.attempts >= job.max_attempts;
    if (dead) {
      const r = await this.db.query(
        `UPDATE fms.jobs SET status = 'dead', locked_by = NULL, locked_at = NULL, last_error = $3
          WHERE id = $1 AND status = 'running' AND locked_by = $2`,
        [job.id, workerId, msg],
      );
      return r.rowCount === 1 ? { outcome: 'dead' } : { outcome: 'lost' };
    }
    const delay = backoffMs(job.attempts, this.opts.backoffBaseMs, this.opts.backoffMaxMs, this.opts.rand);
    const { rows } = await this.db.query<{ run_at: Date }>(
      `UPDATE fms.jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, last_error = $3,
              run_at = now() + make_interval(secs => $4::double precision / 1000)
        WHERE id = $1 AND status = 'running' AND locked_by = $2
        RETURNING run_at`,
      [job.id, workerId, msg, delay],
    );
    return rows[0] ? { outcome: 'retry', runAt: rows[0].run_at } : { outcome: 'lost' };
  }

  /**
   * Lease timeout recovery: jobs stuck in 'running' (worker crashed / partitioned) longer than
   * `minutes` are re-queued, or dead-lettered if they already used all attempts.
   * Returns the dead-lettered jobs so callers can run dead-letter hooks.
   */
  async recoverExpiredLeases(minutes: number): Promise<{ requeued: number; dead: Job[] }> {
    const { rows } = await this.db.query<Job & { recovered_to: string }>(
      `UPDATE fms.jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              last_error = coalesce(last_error || ' | ', '') || 'lease expired (worker ' || coalesce(locked_by, '?') || ')',
              locked_by = NULL, locked_at = NULL, run_at = now()
        WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)
       RETURNING *`,
      [minutes],
    );
    return { requeued: rows.filter((r) => r.status === 'queued').length, dead: rows.filter((r) => r.status === 'dead') };
  }

  /** Queue depth by kind/status (metrics). */
  async depth(): Promise<Array<{ kind: string; status: string; count: number }>> {
    const { rows } = await this.db.query<{ kind: string; status: string; count: string }>(
      `SELECT kind, status, count(*)::text AS count FROM fms.jobs WHERE status IN ('queued','running','dead') GROUP BY kind, status`,
    );
    return rows.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.count) }));
  }
}
