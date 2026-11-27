import type { Logger } from 'pino';
import type { Pool } from './db.js';

/** Delete outbox rows the cloud accepted more than `days` ago (default 30). Unsent rows are never deleted. */
export async function pruneOutbox(pool: Pool, days: number): Promise<number> {
  const r = await pool.query(
    `DELETE FROM edge.outbox WHERE sent_at IS NOT NULL AND sent_at < now() - make_interval(days => $1)`,
    [days],
  );
  return r.rowCount ?? 0;
}

export class RetentionJob {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly pool: Pool, private readonly days: number, private readonly intervalMs: number, private readonly log: Logger) {}

  async runOnce(): Promise<number> {
    const n = await pruneOutbox(this.pool, this.days);
    if (n) this.log.info({ deleted: n, days: this.days }, 'pruned sent outbox rows');
    return n;
  }

  start(): void {
    const run = () => void this.runOnce().catch((e) => this.log.warn({ err: e }, 'retention job failed'));
    setTimeout(run, 10_000).unref();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
