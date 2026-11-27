/**
 * Cloud commands delivered piggy-back on EdgeBatchResponse. Idempotent by command id:
 * the row in edge.commands_applied is inserted first (status 'scheduled'), so a command seen twice
 * is ignored, and a crash between receive and apply is recovered by the scheduled tick.
 *
 * Acknowledgements go to the cloud through the durable outbox (record kind 'command_ack'),
 * written in the same local transaction as the state change they report:
 *   'received'                      when the command is first stored (stops cloud redelivery)
 *   'applied' | 'partial' | 'failed' when it has been processed
 * A redelivered command re-acks its current state, in case the earlier ack is still queued.
 */
import type { CommandAckRecord, EdgeCommand } from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig } from '../config.js';
import type { ConfigStore } from '../configStore.js';
import { withTx, type Pool, type PoolClient } from '../db.js';
import { enqueueOutbox } from '../store.js';
import type { FiscalPipeline } from '../fiscal/pipeline.js';
import type { Metrics } from '../metrics.js';
import { PtsControlClient, PtsControlError } from '../pts/control.js';

const MAX_ATTEMPTS = 10;
const RETRY_MS = 60_000;

type Outcome = { status: 'applied' | 'failed' | 'partial'; result: unknown } | { status: 'retry'; result: unknown };

async function ack(c: PoolClient, command_id: string, status: CommandAckRecord['status'], result: unknown = null): Promise<void> {
  await enqueueOutbox(c, { kind: 'command_ack', data: { command_id, status, at: new Date().toISOString(), result } });
}

export class CommandProcessor {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly pool: Pool,
    private readonly cfg: GatewayConfig,
    private readonly config: ConfigStore,
    private readonly pipeline: FiscalPipeline,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly controlFor: (pts_id: string) => PtsControlClient | null = (id) => {
      const c = cfg.controllers.find((x) => x.pts_id === id);
      return c?.control_url ? new PtsControlClient(c, log, cfg.ptsControl.timeoutMs) : null;
    },
  ) {}

  start(intervalMs = 5000): void {
    this.timer = setInterval(() => void this.runDue(), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy;
  }

  /** Record new commands (ignoring already-known ids) and apply those that are due. */
  async receive(cmds: EdgeCommand[]): Promise<void> {
    for (const cmd of cmds) {
      if (!cmd || typeof cmd.id !== 'string' || typeof cmd.type !== 'string') continue;
      const due = cmd.type === 'set_prices' && cmd.effective_at ? new Date(cmd.effective_at) : new Date();
      const isNew = await withTx(this.pool, async (c) => {
        const ins = await c.query(
          `INSERT INTO edge.commands_applied (id, type, payload, status, due_at) VALUES ($1, $2, $3, 'scheduled', $4)
           ON CONFLICT (id) DO NOTHING`,
          [cmd.id, cmd.type, JSON.stringify(cmd), Number.isNaN(due.getTime()) ? new Date() : due],
        );
        if (ins.rowCount) {
          await ack(c, cmd.id, 'received');
          return true;
        }
        // Redelivered: the cloud has not seen our ack yet; repeat the current state.
        const cur = await c.query<{ status: string; result: unknown }>(`SELECT status, result FROM edge.commands_applied WHERE id = $1`, [cmd.id]);
        const st = cur.rows[0]?.status;
        await ack(c, cmd.id, st === 'applied' || st === 'partial' || st === 'failed' ? st : 'received', st === 'scheduled' ? null : cur.rows[0]?.result ?? null);
        return false;
      });
      if (!isNew) {
        this.metrics.commands.inc({ type: cmd.type, result: 'duplicate' });
        continue;
      }
      this.log.info({ command: cmd }, 'cloud command received');
    }
    await this.runDue();
  }

  /** Apply all scheduled commands whose due time has passed. Serialised. */
  runDue(): Promise<void> {
    this.busy = this.busy.then(() => this.applyDue()).catch((e) => this.log.error({ err: e }, 'command processing failed'));
    return this.busy;
  }

  private async applyDue(): Promise<void> {
    const r = await this.pool.query<{ id: string; payload: EdgeCommand; attempts: number }>(
      `SELECT id, payload, attempts FROM edge.commands_applied WHERE status = 'scheduled' AND due_at <= now() ORDER BY received_at, id`,
    );
    for (const row of r.rows) {
      let out: Outcome;
      try {
        out = await this.apply(row.payload);
      } catch (e) {
        out = { status: 'failed', result: { error: (e as Error).message } };
      }
      const attempts = row.attempts + 1;
      if (out.status === 'retry' && attempts < MAX_ATTEMPTS) {
        await this.pool.query(
          `UPDATE edge.commands_applied SET attempts = $2, result = $3, due_at = now() + make_interval(secs => $4::double precision / 1000) WHERE id = $1`,
          [row.id, attempts, JSON.stringify(out.result), RETRY_MS],
        );
        this.metrics.commands.inc({ type: row.payload.type, result: 'retry' });
        continue;
      }
      const status = out.status === 'retry' ? 'failed' : out.status;
      await withTx(this.pool, async (c) => {
        await c.query(
          `UPDATE edge.commands_applied SET status = $2, attempts = $3, result = $4, applied_at = now() WHERE id = $1`,
          [row.id, status, attempts, JSON.stringify(out.result)],
        );
        await ack(c, row.id, status, out.result);
      });
      this.metrics.commands.inc({ type: row.payload.type, result: status });
      (status === 'applied' ? this.log.info : this.log.warn).call(this.log, { command_id: row.id, type: row.payload.type, status, result: out.result }, 'cloud command processed');
    }
  }

  private async apply(cmd: EdgeCommand): Promise<Outcome> {
    switch (cmd.type) {
      case 'set_prices': {
        const prices = (cmd.prices ?? []).filter((p) => Number.isFinite(p.pts_grade_id) && Number.isFinite(p.price) && p.price > 0);
        if (!prices.length) return { status: 'failed', result: { error: 'no valid prices' } };
        const results: Array<{ pts_id: string; ok: boolean; detail: unknown }> = [];
        let retry = false;
        for (const c of this.cfg.controllers) {
          const client = this.controlFor(c.pts_id);
          if (!client) {
            results.push({ pts_id: c.pts_id, ok: false, detail: 'no control_url configured' });
            continue;
          }
          try {
            results.push({ pts_id: c.pts_id, ok: true, detail: await client.setPrices(prices) });
          } catch (e) {
            if (e instanceof PtsControlError && e.retryable) retry = true;
            results.push({ pts_id: c.pts_id, ok: false, detail: (e as Error).message });
          }
        }
        if (retry) return { status: 'retry', result: { controllers: results } };
        // Local prices are updated even if no controller is reachable, so the next sale's
        // fiscal line items and the local UI show the regulated price.
        for (const p of prices) await this.config.setPrice(p.pts_grade_id, p.price);
        const okCount = results.filter((r) => r.ok).length;
        const status = results.length > 0 && okCount === results.length ? 'applied' : okCount > 0 ? 'partial' : results.length ? 'failed' : 'partial';
        return { status, result: { prices, controllers: results } };
      }
      case 'refiscalise': {
        const r = await this.pool.query<{ id: number; status: string }>(
          `SELECT f.id, f.status FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id = f.transaction_id
            WHERE t.pump_no = $1 AND t.pts_transaction_no = $2 AND t.ended_at = $3`,
          [cmd.pump_no, cmd.pts_transaction_no, cmd.tx_ended_at],
        );
        if (!r.rows.length) return { status: 'failed', result: { error: 'transaction not found on this gateway' } };
        const out = [];
        for (const row of r.rows) {
          if (row.status === 'failed') out.push({ id: row.id, requeued: await this.pipeline.requeue(row.id) });
          else out.push({ id: row.id, requeued: false, status: row.status });
        }
        return { status: 'applied', result: { receipts: out } };
      }
      case 'reload_config':
        return { status: 'applied', result: await this.config.reload() };
      default:
        return { status: 'failed', result: { error: `unknown command type ${(cmd as { type: string }).type}` } };
    }
  }
}
