/**
 * Leader-elected scheduler. Every replica runs it; only the one holding the
 * session-level advisory lock (pg_try_advisory_lock on a dedicated connection)
 * enqueues work. All enqueues use dedupe keys, so a leader change mid-cycle is safe.
 *
 * Tasks:
 *   hourly        SELECT fms.ensure_partitions(1,3); prune old done jobs
 *   daily 00:15   rollup for every station for yesterday (Africa/Lusaka) + erb_export per province + national
 *   every 5 min   fiscal sweep (direct-mode pending > 2 min, edge-mode pending > FISCAL_CLOUD_FALLBACK_MINUTES)
 *                 + GatewayOffline alerts for edge gateways not seen for 15 min
 */
import pg from 'pg';
import type { WorkerConfig } from './config.js';
import { addDays, errorMessage, type Logger, zonedNow } from './core.js';
import type { Metrics } from './metrics.js';
import type { JobQueue } from './queue.js';

export interface SchedulerDeps {
  db: pg.Pool;
  queue: JobQueue;
  config: WorkerConfig;
  log: Logger;
  metrics: Metrics;
}

/** ended_at rendered exactly like JS Date.toISOString() (UTC, millisecond precision). */
const ISO_MS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export class Scheduler {
  private lockClient: pg.Client | null = null;
  private leader = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private last: Record<string, number> = {};
  private lastDailyDate: string | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
        if (!this.stopped) this.timer = setTimeout(loop, this.deps.config.scheduler.tickMs);
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.ticking;
    await this.releaseLeadership();
  }

  /** One scheduler iteration: (re)acquire leadership, run due tasks. */
  async tick(now = new Date()): Promise<void> {
    try {
      if (!(await this.ensureLeadership())) return;
      const s = this.deps.config.scheduler;
      await this.every('partitions', s.partitionsEveryMs, now, () => this.ensurePartitions());
      await this.every('sweep', s.fiscalSweepEveryMs, now, async () => {
        await this.sweepFiscal();
        await this.checkGateways();
      });
      const local = zonedNow(s.timeZone, now);
      const due = local.hour > s.dailyAt.hour || (local.hour === s.dailyAt.hour && local.minute >= s.dailyAt.minute);
      if (due && this.lastDailyDate !== local.date) {
        await this.run('daily', () => this.scheduleDaily(addDays(local.date, -1)));
        this.lastDailyDate = local.date;
      }
    } catch (err) {
      this.deps.log.error({ err: errorMessage(err) }, 'scheduler tick failed');
    }
  }

  private async every(name: string, intervalMs: number, now: Date, fn: () => Promise<unknown>) {
    if (now.getTime() - (this.last[name] ?? 0) < intervalMs) return;
    await this.run(name, fn);
    this.last[name] = now.getTime();
  }

  private async run(name: string, fn: () => Promise<unknown>) {
    try {
      const r = await fn();
      this.deps.metrics.schedulerRuns.inc({ task: name, outcome: 'ok' });
      this.deps.log.info({ task: name, result: r }, 'scheduler task ran');
    } catch (err) {
      this.deps.metrics.schedulerRuns.inc({ task: name, outcome: 'error' });
      this.deps.log.error({ task: name, err: errorMessage(err) }, 'scheduler task failed');
    }
  }

  private async ensureLeadership(): Promise<boolean> {
    try {
      if (!this.lockClient) {
        const c = new pg.Client({ connectionString: this.deps.config.databaseUrl, application_name: 'fms-fiscal-worker-scheduler' });
        c.on('error', (err) => {
          this.deps.log.warn({ err: errorMessage(err) }, 'scheduler lock connection error');
          this.dropLeadership();
        });
        await c.connect();
        this.lockClient = c;
      }
      if (this.leader) {
        await this.lockClient.query('SELECT 1'); // connection (and so the session lock) still alive
        return true;
      }
      const { rows } = await this.lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [this.deps.config.scheduler.lockKey]);
      if (rows[0]?.ok) {
        this.leader = true;
        this.last = {};
        this.deps.metrics.schedulerLeader.set(1);
        this.deps.log.info('acquired scheduler leadership');
      }
      return this.leader;
    } catch (err) {
      this.deps.log.warn({ err: errorMessage(err) }, 'scheduler leadership check failed');
      this.dropLeadership();
      return false;
    }
  }

  private dropLeadership() {
    if (this.leader) this.deps.log.warn('lost scheduler leadership');
    this.leader = false;
    this.deps.metrics.schedulerLeader.set(0);
    const c = this.lockClient;
    this.lockClient = null;
    c?.end().catch(() => {});
  }

  private async releaseLeadership() {
    const c = this.lockClient;
    if (c && this.leader) await c.query('SELECT pg_advisory_unlock($1::bigint)', [this.deps.config.scheduler.lockKey]).catch(() => {});
    this.leader = false;
    this.deps.metrics.schedulerLeader.set(0);
    this.lockClient = null;
    await c?.end().catch(() => {});
  }

  // ---------------------------------------------------------------- tasks

  async ensurePartitions(): Promise<{ pruned_jobs: number }> {
    await this.deps.db.query('SELECT fms.ensure_partitions(1, 3)');
    // Keep the jobs table small; dead jobs are kept for investigation.
    const r = await this.deps.db.query(`DELETE FROM fms.jobs WHERE status = 'done' AND created_at < now() - interval '14 days'`);
    return { pruned_jobs: r.rowCount ?? 0 };
  }

  /** Enqueue the end-of-day rollups and ERB exports for a business date (idempotent). */
  async scheduleDaily(businessDate: string): Promise<{ rollups: number; exports: number }> {
    const rollups = await this.deps.db.query(
      `INSERT INTO fms.jobs (kind, payload, dedupe_key)
       SELECT 'rollup', jsonb_build_object('station_id', s.id, 'business_date', $1::text), 'rollup-final:' || s.id || ':' || $1::text
         FROM fms.stations s WHERE s.status <> 'closed'
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [businessDate],
    );
    const delayMin = this.deps.config.scheduler.erbExportDelayMinutes;
    const exports = await this.deps.db.query(
      `INSERT INTO fms.jobs (kind, payload, dedupe_key, run_at)
       SELECT 'erb_export', jsonb_build_object('date', $1::text, 'province_id', p.id), 'erb_export:' || $1::text || ':' || p.code,
              now() + make_interval(mins => $2)
         FROM fms.provinces p
       UNION ALL
       SELECT 'erb_export', jsonb_build_object('date', $1::text, 'province_id', NULL), 'erb_export:' || $1::text || ':NATIONAL',
              now() + make_interval(mins => $2)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [businessDate, delayMin],
    );
    return { rollups: rollups.rowCount ?? 0, exports: exports.rowCount ?? 0 };
  }

  /** Enqueue cloud fiscalisation for transactions left pending. */
  async sweepFiscal(): Promise<{ enqueued: number }> {
    const s = this.deps.config.scheduler;
    const r = await this.deps.db.query(
      `INSERT INTO fms.jobs (kind, payload, dedupe_key)
       SELECT 'fiscalise',
              jsonb_build_object('station_id', pt.station_id, 'pump_no', pt.pump_no,
                                 'pts_transaction_no', pt.pts_transaction_no, 'ended_at', ${ISO_MS('pt.ended_at')}),
              'fiscalise:' || pt.station_id || ':' || pt.pump_no || ':' || pt.pts_transaction_no || ':' || ${ISO_MS('pt.ended_at')}
         FROM fms.pump_transactions pt
         JOIN fms.stations st ON st.id = pt.station_id
        WHERE pt.fiscal_status = 'pending'
          AND pt.ended_at > now() - make_interval(days => $3)
          AND st.status = 'active'
          AND ((st.connection_mode = 'direct' AND pt.received_at < now() - make_interval(mins => $1))
            OR (st.connection_mode = 'edge'   AND pt.received_at < now() - make_interval(mins => $2)))
          AND NOT EXISTS (
                SELECT 1 FROM fms.fiscal_receipts fr
                 WHERE fr.station_id = pt.station_id AND fr.pump_no = pt.pump_no
                   AND fr.pts_transaction_no = pt.pts_transaction_no AND fr.tx_ended_at = pt.ended_at
                   AND fr.status IN ('signed', 'printed'))
        ORDER BY pt.ended_at
        LIMIT $4
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [s.fiscalDirectDelayMinutes, s.fiscalCloudFallbackMinutes, s.fiscalSweepLookbackDays, s.fiscalSweepLimit],
    );
    return { enqueued: r.rowCount ?? 0 };
  }

  /** Raise GatewayOffline alerts (once per outage) and fan out critical ones. */
  async checkGateways(): Promise<{ alerts: number }> {
    const { rows } = await this.deps.db.query<{
      id: string; station_id: string; province_id: number; occurred_at: Date; severity: string; message: string; data: Record<string, unknown>;
    }>(
      `WITH stale AS (
         SELECT g.station_id, g.gateway_code, g.role, g.last_seen_at
           FROM fms.edge_gateways g JOIN fms.stations s ON s.id = g.station_id
          WHERE s.status = 'active' AND s.connection_mode = 'edge'
            AND g.last_seen_at IS NOT NULL AND g.last_seen_at < now() - make_interval(mins => $1)
            AND NOT EXISTS (SELECT 1 FROM fms.alerts a
                             WHERE a.station_id = g.station_id AND a.device_type = 'gateway' AND a.code = 'GatewayOffline'
                               AND a.data->>'gateway_code' = g.gateway_code AND a.occurred_at >= g.last_seen_at))
       INSERT INTO fms.alerts AS al (station_id, occurred_at, device_type, device_no, code, severity, message, data)
       SELECT station_id, now(), 'gateway', NULL, 'GatewayOffline',
              CASE WHEN role = 'primary' THEN 'critical' ELSE 'warning' END,
              format('Edge gateway %s (%s) not seen since %s', gateway_code, role, last_seen_at),
              jsonb_build_object('gateway_code', gateway_code, 'role', role, 'last_seen_at', last_seen_at)
         FROM stale
       ON CONFLICT DO NOTHING
       RETURNING al.id, al.station_id, (SELECT st.province_id FROM fms.stations st WHERE st.id = al.station_id) AS province_id,
                 al.occurred_at, al.severity, al.message, al.data`,
      [this.deps.config.scheduler.gatewayOfflineMinutes],
    );
    for (const a of rows) {
      const alert = { id: a.id, station_id: a.station_id, occurred_at: a.occurred_at.toISOString(), device_type: 'gateway', code: 'GatewayOffline', severity: a.severity, message: a.message, data: a.data };
      this.deps.log.warn({ station_id: a.station_id, gateway: a.data.gateway_code }, 'edge gateway offline');
      if (a.severity !== 'critical') continue;
      await this.deps.queue.enqueue({ kind: 'notify', payload: { station_id: a.station_id, alert }, dedupeKey: `notify:alert:${a.id}` });
      await this.deps.queue.enqueue({
        kind: 'webhook',
        payload: { event: 'critical_alert', data: { station_id: a.station_id, province_id: a.province_id, alert } },
        dedupeKey: `webhook:critical_alert:${a.id}`,
      });
    }
    return { alerts: rows.length };
  }
}
