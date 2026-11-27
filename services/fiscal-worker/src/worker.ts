import { errorMessage, sleep } from './core.js';
import type { HandlerContext, JobHandler, WorkerDeps } from './handlers/types.js';
import type { Job } from './queue.js';

/**
 * Job runner. Each replica polls fms.jobs with SKIP LOCKED claims, runs up to
 * `concurrency` jobs in parallel, retries with backoff and dead-letters at max_attempts.
 */
export class Worker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inflight = new Set<Promise<void>>();
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private lastLeaseCheck = 0;
  /** Last time the poll loop completed an iteration (liveness). */
  lastLoopAt = Date.now();

  constructor(private readonly deps: WorkerDeps, handlers: JobHandler[]) {
    for (const h of handlers) if (deps.config.kinds.includes(h.kind as never)) this.handlers.set(h.kind, h);
  }

  get kinds(): string[] {
    return [...this.handlers.keys()];
  }

  get running(): boolean {
    return this.loop !== null && !this.abort.signal.aborted;
  }

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.deps.log.info({ kinds: this.kinds, concurrency: this.deps.config.concurrency }, 'worker started');
    this.loop = this.run().catch((err) => this.deps.log.fatal({ err: errorMessage(err) }, 'worker loop crashed'));
  }

  /** Stop claiming new jobs; wait for in-flight jobs up to graceMs. */
  async stop(graceMs = this.deps.config.shutdownGraceMs): Promise<void> {
    this.abort.abort();
    await this.loop;
    this.loop = null;
    if (this.inflight.size) {
      this.deps.log.info({ inflight: this.inflight.size }, 'waiting for in-flight jobs');
      const done = Promise.allSettled([...this.inflight]).then(() => true);
      const ok = await Promise.race([done, sleep(graceMs).then(() => false)]);
      if (!ok) this.deps.log.warn({ inflight: this.inflight.size }, 'grace period elapsed; leases will be recovered by other replicas');
    }
    this.deps.log.info('worker stopped');
  }

  private async run(): Promise<void> {
    const { config, queue, log } = this.deps;
    const signal = this.abort.signal;
    while (!signal.aborted) {
      this.lastLoopAt = Date.now();
      try {
        await this.maybeRecoverLeases();
        const free = config.concurrency - this.inflight.size;
        if (free <= 0) {
          await Promise.race([...this.inflight, sleep(config.pollIntervalMs, signal)]);
          continue;
        }
        const jobs = await queue.claim(this.kinds, Math.min(free, config.batchSize), config.workerId);
        for (const job of jobs) this.track(this.process(job));
        if (jobs.length === 0) await sleep(config.pollIntervalMs, signal);
      } catch (err) {
        log.error({ err: errorMessage(err) }, 'poll failed');
        await sleep(Math.max(config.pollIntervalMs, 2000), signal);
      }
    }
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async maybeRecoverLeases(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastLeaseCheck < this.deps.config.leaseCheckIntervalMs) return;
    this.lastLeaseCheck = now;
    const { requeued, dead } = await this.deps.queue.recoverExpiredLeases(this.deps.config.leaseTimeoutMinutes);
    if (requeued) {
      this.deps.metrics.leaseRecoveries.inc({ outcome: 'requeued' }, requeued);
      this.deps.log.warn({ requeued }, 'recovered expired job leases');
    }
    for (const job of dead) {
      this.deps.metrics.leaseRecoveries.inc({ outcome: 'dead' });
      await this.deadLetter(job, job.last_error ?? 'lease expired');
    }
  }

  /** Claim and process one batch (tests / CLI). Returns the number of jobs processed. */
  async runOnce(limit = this.deps.config.batchSize): Promise<number> {
    await this.maybeRecoverLeases(true);
    const jobs = await this.deps.queue.claim(this.kinds, limit, this.deps.config.workerId);
    await Promise.all(jobs.map((j) => this.process(j)));
    return jobs.length;
  }

  /** Process until no job is ready (tests). */
  async drain(maxRounds = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runOnce();
      if (n === 0) break;
      total += n;
    }
    return total;
  }

  private ctx(job: Job): HandlerContext {
    return { ...this.deps, job, log: this.deps.log.child({ job_id: job.id, kind: job.kind, attempt: job.attempts }) };
  }

  private async process(job: Job): Promise<void> {
    const { metrics, queue, config } = this.deps;
    const handler = this.handlers.get(job.kind);
    const ctx = this.ctx(job);
    const end = metrics.jobDuration.startTimer({ kind: job.kind });
    metrics.jobsInflight.inc({ kind: job.kind });
    try {
      if (!handler) throw Object.assign(new Error(`no handler for kind ${job.kind}`), { retryable: false });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`job timed out after ${config.jobTimeoutMs} ms`)), config.jobTimeoutMs);
      });
      try {
        await Promise.race([handler.handle(ctx), timeout]);
      } finally {
        clearTimeout(timer);
      }
      const ok = await queue.complete(job, config.workerId);
      metrics.jobsProcessed.inc({ kind: job.kind, outcome: ok ? 'done' : 'lost' });
      if (!ok) ctx.log.warn('job lease lost before completion');
      else ctx.log.debug('job done');
    } catch (err) {
      try {
        const r = await queue.fail(job, config.workerId, err);
        metrics.jobsProcessed.inc({ kind: job.kind, outcome: r.outcome });
        if (r.outcome === 'retry') ctx.log.warn({ err: errorMessage(err), next_run_at: r.runAt }, 'job failed, will retry');
        else if (r.outcome === 'dead') await this.deadLetter(job, errorMessage(err));
        else ctx.log.warn({ err: errorMessage(err) }, 'job failed but lease was lost');
      } catch (e) {
        ctx.log.error({ err: errorMessage(e), cause: errorMessage(err) }, 'failed to record job failure (lease will expire)');
      }
    } finally {
      end();
      metrics.jobsInflight.dec({ kind: job.kind });
    }
  }

  private async deadLetter(job: Job, error: string): Promise<void> {
    const ctx = this.ctx(job);
    ctx.log.error({ error, attempts: job.attempts, max_attempts: job.max_attempts, payload: job.payload, dedupe_key: job.dedupe_key }, 'job dead-lettered');
    const handler = this.handlers.get(job.kind);
    if (!handler?.onDead) return;
    try {
      await handler.onDead(ctx, error);
    } catch (err) {
      ctx.log.error({ err: errorMessage(err) }, 'dead-letter hook failed');
    }
  }
}
