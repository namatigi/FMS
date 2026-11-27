import type pg from 'pg';
import type { FiscalClient, ReceiptPrinter } from '@fms/shared';
import type { WorkerConfig } from '../config.js';
import type { Logger } from '../core.js';
import type { Metrics } from '../metrics.js';
import type { Notifier } from '../notifiers.js';
import type { Job, JobQueue } from '../queue.js';
import type { ObjectStorage } from '../storage.js';

export interface WorkerDeps {
  db: pg.Pool;
  queue: JobQueue;
  config: WorkerConfig;
  log: Logger;
  metrics: Metrics;
  /** VSDC client for a seller TPIN + branch. */
  fiscalClientFor(tpin: string, bhfId: string): FiscalClient;
  notifiers: Notifier[];
  storage: ObjectStorage;
  /** Optional digital receipt archive (fiscal-printer file driver). */
  receiptArchive: ReceiptPrinter | null;
  fetchImpl: typeof fetch;
}

export interface HandlerContext extends WorkerDeps {
  job: Job;
  log: Logger;
}

export interface JobHandler {
  kind: string;
  handle(ctx: HandlerContext): Promise<void>;
  /** Called once when a job is dead-lettered (non-retryable error or max_attempts reached). */
  onDead?(ctx: HandlerContext, error: string): Promise<void>;
}
