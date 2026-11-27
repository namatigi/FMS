/**
 * Fiscalisation pipeline: pending -> signSale (ZRA VSDC) -> signed -> print -> printed.
 *
 *  - Work is claimed with FOR UPDATE SKIP LOCKED and a lease (lease_until), so several workers
 *    (or a restarted process) never process the same receipt concurrently, and a crash mid-call
 *    only delays the receipt until the lease expires.
 *  - invoice_no is deterministic, and FiscalClient.signSale is idempotent on it, so a retry after an
 *    ambiguous failure (timeout) cannot double-sign.
 *  - Retryable errors back off exponentially (FISCAL_RETRY_BASE_MS * 2^n, capped at 5 min).
 *    Non-retryable errors mark the receipt failed and raise an alert.
 *  - Every status change is written to the outbox (kind fiscal_receipt) in the same DB transaction.
 */
import {
  FiscalError,
  type FiscalClient,
  type FiscalSaleRequest,
  type FiscalSignature,
  type ReceiptDocument,
  type ReceiptPrinter,
} from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig } from '../config.js';
import type { ConfigStore } from '../configStore.js';
import { withTx, type Pool, type PoolClient } from '../db.js';
import type { Metrics } from '../metrics.js';
import { insertAlert, outboxFiscalReceipt } from '../store.js';

interface ClaimedRow {
  id: number;
  transaction_id: number;
  invoice_no: string;
  status: 'pending' | 'signed';
  attempts: number;
  print_attempts: number;
  pts_id: string;
  pump_no: number;
  nozzle_no: number;
  pts_transaction_no: number;
  pts_grade_id: number | null;
  grade_name: string | null;
  ended_at: Date;
  volume_l: number;
  price: number;
  amount: number;
  tag: string | null;
  pts_user_id: number | null;
  request: FiscalSaleRequest | null;
  zra_rcpt_no: string | null;
  zra_tot_rcpt_no: string | null;
  zra_internal_data: string | null;
  zra_signature: string | null;
  zra_sdc_id: string | null;
  zra_mrc_no: string | null;
  zra_qr_url: string | null;
  zra_signed_at: Date | null;
  response: unknown;
}

const CLAIM_COLUMNS = `
  f.id, f.transaction_id, f.invoice_no, f.status, f.attempts, f.print_attempts, f.request, f.response,
  f.zra_rcpt_no, f.zra_tot_rcpt_no, f.zra_internal_data, f.zra_signature, f.zra_sdc_id, f.zra_mrc_no, f.zra_qr_url, f.zra_signed_at,
  t.pts_id, t.pump_no, t.nozzle_no, t.pts_transaction_no, t.pts_grade_id, t.grade_name, t.ended_at,
  t.volume_l, t.price, t.amount, t.tag, t.pts_user_id`;

const round2 = (v: number) => Math.round(v * 100) / 100;

export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export class FiscalPipeline {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  private wakeRequested = false;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: GatewayConfig,
    private readonly config: ConfigStore,
    private readonly client: FiscalClient,
    private readonly printer: ReceiptPrinter,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly isActive: () => boolean = () => true,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** Ask the worker to look for work now (called after a new sale is stored). */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.loop();
    }, ms);
  }

  private async loop(): Promise<void> {
    this.running = true;
    let processed = 0;
    try {
      if (this.isActive()) processed = await this.runOnce();
    } catch (e) {
      this.log.error({ err: e }, 'fiscal pipeline iteration failed');
    } finally {
      this.running = false;
    }
    const again = processed > 0 || this.wakeRequested;
    this.wakeRequested = false;
    this.schedule(again ? 0 : this.cfg.fiscal.pollMs);
  }

  /** Claim up to `concurrency` due receipts and process them in parallel. Returns number processed. */
  async runOnce(): Promise<number> {
    const rows = await this.claim(this.cfg.fiscal.concurrency);
    await Promise.all(rows.map((r) => this.process(r)));
    return rows.length;
  }

  private async claim(limit: number): Promise<ClaimedRow[]> {
    return withTx(this.pool, async (c) => {
      const ids = await c.query<{ id: number }>(
        `SELECT id FROM edge.fiscal_receipts
          WHERE status IN ('pending','signed') AND next_attempt_at <= now()
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY next_attempt_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (!ids.rows.length) return [];
      await c.query(
        `UPDATE edge.fiscal_receipts SET lease_until = now() + make_interval(secs => $2::double precision / 1000) WHERE id = ANY($1)`,
        [ids.rows.map((r) => r.id), this.cfg.fiscal.leaseMs],
      );
      const r = await c.query<ClaimedRow>(
        `SELECT ${CLAIM_COLUMNS} FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id = f.transaction_id WHERE f.id = ANY($1) ORDER BY f.id`,
        [ids.rows.map((x) => x.id)],
      );
      return r.rows;
    });
  }

  buildRequest(row: Pick<ClaimedRow, 'invoice_no' | 'pts_grade_id' | 'grade_name' | 'ended_at' | 'volume_l' | 'price' | 'amount' | 'pts_user_id'>): FiscalSaleRequest {
    const g = this.config.grade(row.pts_grade_id);
    if (!g || !g.zra_item_code) {
      throw new FiscalError(`no ZRA item mapping for fuel grade ${row.pts_grade_id ?? '?'} (${row.grade_name ?? ''}); fix config and reload_config`, true, 'CONFIG');
    }
    const st = this.config.station;
    return {
      tpin: st.tpin,
      branch_id: st.bhf_id,
      invoice_no: row.invoice_no,
      sale_time: new Date(row.ended_at).toISOString(),
      payment_type: this.cfg.fiscal.paymentType,
      customer_tpin: null,
      customer_name: null,
      cashier_id: row.pts_user_id != null ? String(row.pts_user_id) : null,
      lines: [{
        item_code: g.zra_item_code,
        item_class_code: g.zra_item_class_code,
        item_name: g.zra_item_name ?? g.name,
        qty: Number(row.volume_l),
        unit_price: Number(row.price),
        total: Number(row.amount),
        vat_category: g.vat_category,
      }],
    };
  }

  buildReceipt(row: ClaimedRow, sig: FiscalSignature, req: FiscalSaleRequest): ReceiptDocument {
    const st = this.config.station;
    const rate = this.config.grade(row.pts_grade_id)?.vat_rate_pct ?? 0;
    const total = round2(req.lines.reduce((s, l) => s + l.total, 0));
    return {
      station_name: st.name,
      station_address: st.address,
      tpin: st.tpin,
      invoice_no: row.invoice_no,
      sale_time: req.sale_time,
      pump_no: row.pump_no,
      nozzle_no: row.nozzle_no,
      attendant: row.tag,
      lines: req.lines,
      total,
      vat_total: round2((total * rate) / (100 + rate)), // prices are VAT-inclusive
      payment_type: req.payment_type,
      signature: sig,
    };
  }

  private signatureFromRow(row: ClaimedRow): FiscalSignature {
    return {
      receipt_no: row.zra_rcpt_no ?? '',
      total_receipt_no: row.zra_tot_rcpt_no,
      internal_data: row.zra_internal_data,
      signature: row.zra_signature ?? '',
      sdc_id: row.zra_sdc_id,
      mrc_no: row.zra_mrc_no,
      qr_url: row.zra_qr_url,
      signed_at: row.zra_signed_at ? new Date(row.zra_signed_at).toISOString() : new Date().toISOString(),
      raw_response: row.response,
    };
  }

  private async process(row: ClaimedRow): Promise<void> {
    let sig: FiscalSignature;
    let req: FiscalSaleRequest;
    if (row.status === 'pending') {
      const attempt = row.attempts + 1;
      try {
        req = this.buildRequest(row);
        const t0 = process.hrtime.bigint();
        sig = await this.client.signSale(req);
        this.metrics.fiscalLatency.observe(Number(process.hrtime.bigint() - t0) / 1e9);
      } catch (e) {
        await this.onSignError(row, attempt, e);
        return;
      }
      this.metrics.fiscalResults.inc({ result: 'signed' });
      await withTx(this.pool, async (c) => {
        await c.query(
          `UPDATE edge.fiscal_receipts SET status='signed', attempts=$2, zra_rcpt_no=$3, zra_tot_rcpt_no=$4, zra_internal_data=$5,
              zra_signature=$6, zra_sdc_id=$7, zra_mrc_no=$8, zra_qr_url=$9, zra_signed_at=$10, request=$11, response=$12,
              last_error=NULL, last_error_code=NULL, next_attempt_at=now(), updated_at=now()
            WHERE id=$1`,
          [row.id, attempt, sig.receipt_no, sig.total_receipt_no, sig.internal_data, sig.signature, sig.sdc_id, sig.mrc_no,
            sig.qr_url, sig.signed_at, JSON.stringify(req), JSON.stringify(sig.raw_response ?? null)],
        );
        await c.query(`UPDATE edge.transactions SET fiscal_status='signed' WHERE id=$1`, [row.transaction_id]);
        await outboxFiscalReceipt(c, row.id);
      });
      row.attempts = attempt;
    } else {
      sig = this.signatureFromRow(row);
      req = row.request ?? this.buildRequest(row);
    }
    await this.printSigned(row, sig, req);
  }

  private async printSigned(row: ClaimedRow, sig: FiscalSignature, req: FiscalSaleRequest): Promise<void> {
    try {
      await this.printer.print(this.buildReceipt(row, sig, req));
      this.metrics.printResults.inc({ result: 'ok' });
    } catch (e) {
      this.metrics.printResults.inc({ result: 'error' });
      const pa = row.print_attempts + 1;
      const delay = backoffMs(pa, this.cfg.fiscal.retryBaseMs, this.cfg.fiscal.retryMaxMs);
      this.log.warn({ err: e, invoice_no: row.invoice_no, print_attempts: pa, retry_in_ms: delay }, 'receipt print failed; will retry');
      await this.pool.query(
        `UPDATE edge.fiscal_receipts SET print_attempts=$2, last_error=$3, last_error_code='PRINT', lease_until=NULL,
            next_attempt_at = now() + make_interval(secs => $4::double precision / 1000), updated_at=now() WHERE id=$1`,
        [row.id, pa, `print: ${(e as Error).message}`, delay],
      );
      return;
    }
    await withTx(this.pool, async (c) => {
      await c.query(
        `UPDATE edge.fiscal_receipts SET status='printed', printed_at=now(), print_attempts=print_attempts+1, lease_until=NULL,
            last_error=NULL, last_error_code=NULL, updated_at=now() WHERE id=$1`,
        [row.id],
      );
      await c.query(`UPDATE edge.transactions SET fiscal_status='printed' WHERE id=$1`, [row.transaction_id]);
      await outboxFiscalReceipt(c, row.id);
    });
    this.log.info({ invoice_no: row.invoice_no, rcpt_no: sig.receipt_no }, 'sale fiscalised and printed');
  }

  private async onSignError(row: ClaimedRow, attempt: number, e: unknown): Promise<void> {
    const err = e as Error & { retryable?: boolean; code?: string };
    // Unknown errors (network, bugs in a driver) are treated as retryable: never lose a sale.
    const retryable = e instanceof FiscalError ? e.retryable : err?.retryable ?? true;
    const code = err?.code ?? null;
    const msg = err?.message ?? String(e);
    if (retryable) {
      this.metrics.fiscalResults.inc({ result: 'retry' });
      const delay = backoffMs(attempt, this.cfg.fiscal.retryBaseMs, this.cfg.fiscal.retryMaxMs);
      this.log.warn({ invoice_no: row.invoice_no, attempt, code, err: msg, retry_in_ms: delay }, 'ZRA signSale failed (retryable)');
      await withTx(this.pool, async (c) => {
        await c.query(
          `UPDATE edge.fiscal_receipts SET attempts=$2, last_error=$3, last_error_code=$4, lease_until=NULL,
              next_attempt_at = now() + make_interval(secs => $5::double precision / 1000), updated_at=now() WHERE id=$1`,
          [row.id, attempt, msg, code, delay],
        );
        if (attempt === 1 && code === 'CONFIG') await this.raiseAlert(c, row, 'FiscalConfigMissing', 'warning', msg);
      });
      return;
    }
    this.metrics.fiscalResults.inc({ result: 'failed' });
    this.log.error({ invoice_no: row.invoice_no, attempt, code, err: msg }, 'ZRA signSale failed (non-retryable): receipt marked failed');
    await withTx(this.pool, async (c) => {
      await c.query(
        `UPDATE edge.fiscal_receipts SET status='failed', attempts=$2, last_error=$3, last_error_code=$4, lease_until=NULL, updated_at=now() WHERE id=$1`,
        [row.id, attempt, msg, code],
      );
      await c.query(`UPDATE edge.transactions SET fiscal_status='failed' WHERE id=$1`, [row.transaction_id]);
      await outboxFiscalReceipt(c, row.id);
      await this.raiseAlert(c, row, 'FiscalisationFailed', 'critical', `Invoice ${row.invoice_no}: ${msg}`);
    });
  }

  private async raiseAlert(c: PoolClient, row: ClaimedRow, code: string, severity: 'warning' | 'critical', message: string): Promise<void> {
    await insertAlert(c, {
      pts_id: row.pts_id,
      occurred_at: new Date().toISOString(),
      device_type: 'gateway',
      device_no: row.pump_no,
      code,
      severity,
      message,
      data: { invoice_no: row.invoice_no, pump_no: row.pump_no, pts_transaction_no: row.pts_transaction_no },
    }, 'gateway', true);
  }

  /** Reset a failed receipt so it is signed again (refiscalise command / UI). */
  async requeue(receiptId: number): Promise<boolean> {
    const ok = await withTx(this.pool, async (c) => {
      const r = await c.query<{ transaction_id: number }>(
        `UPDATE edge.fiscal_receipts SET status='pending', next_attempt_at=now(), lease_until=NULL, last_error=NULL, last_error_code=NULL, updated_at=now()
          WHERE id=$1 AND status='failed' RETURNING transaction_id`,
        [receiptId],
      );
      if (!r.rows[0]) return false;
      await c.query(`UPDATE edge.transactions SET fiscal_status='pending' WHERE id=$1`, [r.rows[0].transaction_id]);
      await outboxFiscalReceipt(c, receiptId);
      return true;
    });
    if (ok) this.kick();
    return ok;
  }

  /** Reprint a signed receipt now (local UI). Throws if not signed yet or the printer fails. */
  async reprint(receiptId: number): Promise<{ invoice_no: string }> {
    const r = await this.pool.query<ClaimedRow>(
      `SELECT ${CLAIM_COLUMNS} FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id = f.transaction_id WHERE f.id = $1`,
      [receiptId],
    );
    const row = r.rows[0];
    if (!row) throw Object.assign(new Error('receipt not found'), { statusCode: 404 });
    if (!row.zra_signature) throw Object.assign(new Error(`receipt not signed yet (status ${row.status})`), { statusCode: 409 });
    const sig = this.signatureFromRow(row);
    const req = row.request ?? this.buildRequest(row);
    await this.printer.print(this.buildReceipt(row, sig, req));
    this.metrics.printResults.inc({ result: 'reprint' });
    await this.pool.query(`UPDATE edge.fiscal_receipts SET reprint_count = reprint_count + 1, updated_at = now() WHERE id = $1`, [receiptId]);
    return { invoice_no: row.invoice_no };
  }
}
