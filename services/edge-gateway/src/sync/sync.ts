/**
 * Cloud sync: drains edge.outbox in seq order to POST ${CLOUD_INGEST_URL}/ingest/v1/edge/batches.
 *
 *  - batches of <= SYNC_BATCH_MAX_RECORDS records and <= SYNC_BATCH_MAX_BYTES of JSON, gzip encoded
 *  - accepted seqs -> sent_at = now(); rejected non-retryable -> parked (operator attention, UI);
 *    rejected retryable or unanswered -> attempts + 1, resent in a later batch
 *  - transport failures back off exponentially with full jitter
 *  - at-least-once: the cloud writes idempotently on natural keys, so resending is harmless
 *  - heartbeat record every HEARTBEAT_INTERVAL_MS (only the newest unsent heartbeat is kept)
 */
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import type { EdgeBatch, EdgeBatchResponse, GatewayHeartbeatRecord, TelemetryRecord } from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig } from '../config.js';
import type { Pool } from '../db.js';
import type { Metrics } from '../metrics.js';
import type { CommandProcessor } from './commands.js';

const gzip = promisify(gzipCb);

export interface SyncState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  connected: boolean;
  lastBatchId: string | null;
}

type OutboxRow = { seq: number; kind: TelemetryRecord['kind']; data: TelemetryRecord['data']; attempts: number };

export class SyncLoop {
  readonly state: SyncState = {
    lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, connected: false, lastBatchId: null,
  };
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private readonly endpoint: string | null;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: GatewayConfig,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly commands: CommandProcessor,
    private readonly isActive: () => boolean = () => true,
    private readonly onlineControllers: () => Promise<string[]> = async () => [],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = cfg.cloud.ingestUrl ? `${cfg.cloud.ingestUrl.replace(/\/+$/, '')}/ingest/v1/edge/batches` : null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.endpoint) this.log.warn('CLOUD_INGEST_URL not set: cloud sync disabled, outbox will accumulate');
    this.hbTimer = setInterval(() => void this.emitHeartbeat().catch((e) => this.log.warn({ err: e }, 'heartbeat failed')), this.cfg.cloud.heartbeatMs);
    this.hbTimer.unref();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.timer = null;
    this.hbTimer = null;
    await this.inFlight;
  }

  kick(): void {
    if (!this.stopped && this.timer && this.state.consecutiveFailures === 0) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.loop();
    }, ms);
    this.timer.unref?.();
  }

  private backoff(): number {
    const exp = Math.min(this.cfg.cloud.backoffMaxMs, this.cfg.cloud.backoffBaseMs * 2 ** Math.min(20, Math.max(0, this.state.consecutiveFailures - 1)));
    return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
  }

  private async loop(): Promise<void> {
    let next = this.cfg.cloud.intervalMs;
    try {
      if (this.endpoint && this.isActive()) {
        const r = await this.syncOnce();
        if (r.error) next = this.backoff();
        else if (r.sent > 0) next = 0; // keep draining
      }
    } catch (e) {
      this.log.error({ err: e }, 'sync iteration failed');
      next = this.backoff();
    }
    this.schedule(next);
  }

  async heartbeat(): Promise<GatewayHeartbeatRecord> {
    const r = await this.pool.query<{ backlog: number; fiscal_backlog: number }>(
      `SELECT (SELECT count(*) FROM edge.outbox WHERE sent_at IS NULL AND parked_at IS NULL)::int AS backlog,
              (SELECT count(*) FROM edge.fiscal_receipts WHERE status IN ('pending','signed'))::int AS fiscal_backlog`,
    );
    let disk: number | null = null;
    try {
      const s = await statfs(process.cwd());
      disk = Math.round((s.bavail * s.bsize) / (1024 * 1024));
    } catch {
      disk = null;
    }
    return {
      gateway_version: this.cfg.version,
      backlog: r.rows[0].backlog,
      fiscal_backlog: r.rows[0].fiscal_backlog,
      controllers_online: await this.onlineControllers(),
      disk_free_mb: disk,
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Queue a heartbeat record (replacing an older unsent one so outages do not pile them up). */
  async emitHeartbeat(): Promise<void> {
    if (!this.isActive()) return;
    const hb = await this.heartbeat();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DELETE FROM edge.outbox WHERE kind = 'heartbeat' AND sent_at IS NULL`);
      await c.query(`INSERT INTO edge.outbox(kind, data) VALUES ('heartbeat', $1)`, [JSON.stringify(hb)]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    this.kick();
  }

  private async readBatch(): Promise<OutboxRow[]> {
    const r = await this.pool.query<OutboxRow>(
      `SELECT seq, kind, data, attempts FROM edge.outbox WHERE sent_at IS NULL AND parked_at IS NULL ORDER BY seq LIMIT $1`,
      [this.cfg.cloud.batchMaxRecords],
    );
    const out: OutboxRow[] = [];
    let bytes = 200;
    for (const row of r.rows) {
      const size = Buffer.byteLength(JSON.stringify(row.data)) + 40;
      if (out.length > 0 && bytes + size > this.cfg.cloud.batchMaxBytes) break;
      out.push(row);
      bytes += size;
    }
    return out;
  }

  /** Send one batch. Returns number of records sent (0 = nothing to do). */
  async syncOnce(): Promise<{ sent: number; accepted: number; rejected: number; error?: string }> {
    if (!this.endpoint) return { sent: 0, accepted: 0, rejected: 0 };
    const rows = await this.readBatch();
    if (!rows.length) {
      // Nothing to send still proves nothing about connectivity; keep the last state.
      return { sent: 0, accepted: 0, rejected: 0 };
    }
    const batch: EdgeBatch = {
      gateway_code: this.cfg.cloud.gatewayCode,
      station_code: this.cfg.station.code,
      batch_id: randomUUID(),
      sent_at: new Date().toISOString(),
      records: rows.map((r) => ({ seq: r.seq, kind: r.kind, data: r.data }) as EdgeBatch['records'][number]),
    };
    const json = JSON.stringify(batch);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.cfg.cloud.gatewayKey}`,
      'x-gateway-code': this.cfg.cloud.gatewayCode,
      'x-batch-id': batch.batch_id,
    };
    let body: string | Uint8Array = json;
    if (this.cfg.cloud.gzip) {
      body = await gzip(json);
      headers['content-encoding'] = 'gzip';
    }
    this.state.lastAttemptAt = new Date().toISOString();
    this.state.lastBatchId = batch.batch_id;
    const seqs = rows.map((r) => r.seq);

    let resp: EdgeBatchResponse;
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST', headers, body: body as unknown as BodyInit, signal: AbortSignal.timeout(this.cfg.cloud.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      resp = (await res.json()) as EdgeBatchResponse;
      if (!resp || !Array.isArray(resp.accepted)) throw new Error('invalid EdgeBatchResponse');
    } catch (e) {
      const msg = (e as Error).message;
      this.state.consecutiveFailures++;
      this.state.lastError = msg;
      this.state.connected = false;
      this.metrics.cloudConnected.set(0);
      this.metrics.syncBatches.inc({ result: 'error' });
      await this.pool.query(`UPDATE edge.outbox SET attempts = attempts + 1, last_error = $2 WHERE seq = ANY($1)`, [seqs, msg]);
      this.log.warn({ err: msg, records: rows.length, failures: this.state.consecutiveFailures }, 'cloud sync failed');
      return { sent: rows.length, accepted: 0, rejected: 0, error: msg };
    }

    const inBatch = new Set(seqs);
    const accepted = resp.accepted.filter((s) => inBatch.has(s));
    const rejected = (resp.rejected ?? []).filter((r) => inBatch.has(r.seq));
    const handled = new Set([...accepted, ...rejected.map((r) => r.seq)]);
    const unanswered = seqs.filter((s) => !handled.has(s));
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if (accepted.length) await c.query(`UPDATE edge.outbox SET sent_at = now(), last_error = NULL WHERE seq = ANY($1)`, [accepted]);
      for (const r of rejected) {
        if (r.retryable) {
          await c.query(
            `UPDATE edge.outbox SET attempts = attempts + 1, last_error = $2,
                parked_at = CASE WHEN attempts + 1 >= $3 THEN now() END WHERE seq = $1`,
            [r.seq, r.error, this.cfg.cloud.maxRetryableAttempts],
          );
        } else {
          await c.query(`UPDATE edge.outbox SET attempts = attempts + 1, last_error = $2, parked_at = now() WHERE seq = $1`, [r.seq, r.error]);
        }
      }
      if (unanswered.length) {
        await c.query(`UPDATE edge.outbox SET attempts = attempts + 1, last_error = 'not acknowledged' WHERE seq = ANY($1)`, [unanswered]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    this.state.consecutiveFailures = 0;
    this.state.lastError = null;
    this.state.lastSuccessAt = new Date().toISOString();
    this.state.connected = true;
    this.metrics.cloudConnected.set(1);
    this.metrics.syncBatches.inc({ result: 'ok' });
    this.metrics.syncRecords.inc({ result: 'accepted' }, accepted.length);
    this.metrics.syncRecords.inc({ result: 'rejected' }, rejected.length);
    if (rejected.length) this.log.warn({ rejected: rejected.slice(0, 10), count: rejected.length }, 'cloud rejected records');
    this.log.debug({ batch_id: batch.batch_id, accepted: accepted.length, rejected: rejected.length }, 'batch synced');

    if (Array.isArray(resp.commands) && resp.commands.length) {
      await this.commands.receive(resp.commands).catch((e) => this.log.error({ err: e }, 'command handling failed'));
    }
    // If nothing was accepted (all retryable rejections), avoid a hot loop.
    if (!accepted.length && !rejected.some((r) => !r.retryable)) {
      return { sent: rows.length, accepted: 0, rejected: rejected.length, error: 'no records accepted' };
    }
    return { sent: rows.length, accepted: accepted.length, rejected: rejected.length };
  }
}
