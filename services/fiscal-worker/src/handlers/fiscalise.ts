/**
 * `fiscalise` — cloud ZRA fiscalisation (direct-mode stations, or edge sales left unsigned).
 * payload: { station_id, pump_no, pts_transaction_no, ended_at }
 *
 * Idempotency: the invoice number is deterministic and fiscal_receipts is unique per
 * transaction; if a receipt row already exists its invoice_no is reused, so the VSDC
 * sees the same cisInvcNo on every retry (duplicate → returns the original signature).
 */
import type { FiscalSaleRequest, FiscalSignature, ReceiptDocument } from '@fms/shared';
import { buildInvoiceNo, vatBreakdown, VSDC_SPEC } from '@fms/zra-client';
import { errorMessage, isRetryable, permanent, req, withTx } from '../core.js';
import type { HandlerContext, JobHandler } from './types.js';

interface TxRow {
  station_id: string;
  station_code: string;
  station_name: string;
  station_address: string | null;
  timezone: string;
  zra_branch_id: string;
  tpin: string | null;
  pump_no: number;
  nozzle_no: number;
  pts_transaction_no: number;
  ended_at: Date;
  volume_l: string;
  price: string;
  amount: string;
  tag: string | null;
  fiscal_status: string;
  product_code: string | null;
  zra_item_code: string | null;
  grade_name: string | null;
  product_name: string | null;
  zra_item_class_cd: string | null;
  zra_vat_cat_cd: string | null;
  receipt_status: string | null;
}

export interface FiscalisePayload {
  station_id: string;
  pump_no: number;
  pts_transaction_no: number;
  ended_at: string;
}

function parsePayload(p: Record<string, unknown>): FiscalisePayload {
  return { station_id: req.uuid(p, 'station_id'), pump_no: req.int(p, 'pump_no'), pts_transaction_no: req.int(p, 'pts_transaction_no'), ended_at: req.timestamp(p, 'ended_at') };
}

// ended_at in payloads/dedupe keys is ISO-8601 with millisecond precision; match the
// stored timestamptz within that millisecond (stays on the unique index prefix).
const TX_KEY_SQL = `pt.station_id = $1 AND pt.pump_no = $2 AND pt.pts_transaction_no = $3
  AND pt.ended_at >= $4::timestamptz AND pt.ended_at < $4::timestamptz + interval '1 millisecond'`;

async function loadTx(ctx: HandlerContext, p: FiscalisePayload): Promise<TxRow | null> {
  const { rows } = await ctx.db.query<TxRow>(
    `SELECT s.id AS station_id, s.code AS station_code, s.name AS station_name, s.address AS station_address,
            s.timezone, s.zra_branch_id, c.zra_tpin AS tpin,
            pt.pump_no, pt.nozzle_no, pt.pts_transaction_no, pt.ended_at, pt.volume_l, pt.price, pt.amount, pt.tag,
            pt.fiscal_status, coalesce(pt.product_code, fg.product_code) AS product_code,
            fg.zra_item_code, fg.name AS grade_name, pr.name AS product_name, pr.zra_item_class_cd, pr.zra_vat_cat_cd,
            fr.status AS receipt_status
       FROM fms.pump_transactions pt
       JOIN fms.stations s  ON s.id = pt.station_id
       JOIN fms.companies c ON c.id = s.company_id
       LEFT JOIN fms.fuel_grades fg ON fg.station_id = pt.station_id AND fg.pts_grade_id = pt.pts_grade_id
       LEFT JOIN fms.products pr    ON pr.code = coalesce(pt.product_code, fg.product_code)
       LEFT JOIN fms.fiscal_receipts fr ON fr.station_id = pt.station_id AND fr.pump_no = pt.pump_no
             AND fr.pts_transaction_no = pt.pts_transaction_no AND fr.tx_ended_at = pt.ended_at
      WHERE ${TX_KEY_SQL}`,
    [p.station_id, p.pump_no, p.pts_transaction_no, p.ended_at],
  );
  return rows[0] ?? null;
}

function buildSale(ctx: HandlerContext, tx: TxRow, invoiceNo: string): FiscalSaleRequest {
  if (!tx.tpin) throw permanent(`Company of station ${tx.station_code} has no ZRA TPIN`, 'NO_TPIN');
  if (!tx.zra_item_code) throw permanent(`No ZRA item code for grade of ${tx.station_code} pump ${tx.pump_no} (fuel_grades.zra_item_code)`, 'NO_ITEM_CODE');
  return {
    tpin: tx.tpin,
    branch_id: tx.zra_branch_id,
    invoice_no: invoiceNo,
    sale_time: tx.ended_at.toISOString(),
    payment_type: ctx.config.zra.defaultPaymentType,
    customer_tpin: null,
    customer_name: null,
    cashier_id: null,
    lines: [
      {
        item_code: tx.zra_item_code,
        item_class_code: tx.zra_item_class_cd,
        item_name: tx.grade_name ?? tx.product_name ?? tx.product_code ?? 'Fuel',
        qty: Number(tx.volume_l),
        unit_price: Number(tx.price),
        total: Number(tx.amount),
        vat_category: tx.zra_vat_cat_cd ?? 'A',
      },
    ],
  };
}

async function archiveReceipt(ctx: HandlerContext, tx: TxRow, sale: FiscalSaleRequest, sig: FiscalSignature) {
  if (!ctx.receiptArchive) return;
  let vat = 0;
  try {
    vat = vatBreakdown(sale.lines, { ...VSDC_SPEC.defaultVatRates, ...ctx.config.zra.vatRates }).reduce((s, b) => s + b.tax, 0);
  } catch {
    /* unknown category: print without VAT split */
  }
  const doc: ReceiptDocument = {
    station_name: tx.station_name,
    station_address: tx.station_address,
    tpin: sale.tpin,
    invoice_no: sale.invoice_no,
    sale_time: sale.sale_time,
    pump_no: tx.pump_no,
    nozzle_no: tx.nozzle_no,
    attendant: tx.tag,
    lines: sale.lines,
    total: sale.lines.reduce((s, l) => s + l.total, 0),
    vat_total: Math.round(vat * 100) / 100,
    payment_type: sale.payment_type,
    signature: sig,
  };
  try {
    await ctx.receiptArchive.print(doc);
  } catch (err) {
    ctx.log.warn({ err: errorMessage(err), invoice_no: sale.invoice_no }, 'receipt archive failed');
  }
}

async function markSigned(ctx: HandlerContext, p: FiscalisePayload) {
  await ctx.db.query(`UPDATE fms.pump_transactions pt SET fiscal_status = 'signed' WHERE ${TX_KEY_SQL} AND pt.fiscal_status <> 'signed'`, [
    p.station_id, p.pump_no, p.pts_transaction_no, p.ended_at,
  ]);
}

export const fiscaliseHandler: JobHandler = {
  kind: 'fiscalise',

  async handle(ctx) {
    const p = parsePayload(ctx.job.payload);
    const tx = await loadTx(ctx, p);
    if (!tx) throw permanent(`pump transaction not found: ${JSON.stringify(p)}`, 'TX_NOT_FOUND');
    const log = ctx.log.child({ station: tx.station_code, pump: tx.pump_no, txno: tx.pts_transaction_no });

    if (tx.fiscal_status === 'exempt') {
      log.info('transaction exempt from fiscalisation, skipping');
      ctx.metrics.fiscalSigned.inc({ result: 'skipped' });
      return;
    }
    if (tx.receipt_status === 'signed' || tx.receipt_status === 'printed') {
      // Edge (or an earlier attempt) already signed it; make sure the transaction reflects it.
      if (tx.fiscal_status !== 'signed') await markSigned(ctx, p);
      log.info({ receipt_status: tx.receipt_status }, 'already fiscalised, skipping');
      ctx.metrics.fiscalSigned.inc({ result: 'skipped' });
      return;
    }

    const proposedInvoice = buildInvoiceNo({
      stationCode: tx.station_code,
      pumpNo: tx.pump_no,
      ptsTransactionNo: tx.pts_transaction_no,
      endedAt: tx.ended_at,
      timeZone: tx.timezone || 'Africa/Lusaka',
    });
    const draft = buildSale(ctx, tx, proposedInvoice);

    // Upsert the receipt row; an existing row keeps its invoice_no (edge may have tried already).
    const { rows } = await ctx.db.query<{ id: string; invoice_no: string }>(
      `INSERT INTO fms.fiscal_receipts AS fr (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, fiscalised_by, attempts, request)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'cloud', 1, $6::jsonb)
       ON CONFLICT (station_id, pump_no, pts_transaction_no, tx_ended_at) DO UPDATE
          SET attempts = fr.attempts + 1, fiscalised_by = 'cloud', status = 'pending'
        WHERE fr.status IN ('pending', 'failed')
       RETURNING fr.id, fr.invoice_no`,
      [tx.station_id, tx.pump_no, tx.pts_transaction_no, tx.ended_at, proposedInvoice, JSON.stringify({ sale: draft })],
    );
    if (!rows[0]) {
      await markSigned(ctx, p);
      log.info('receipt signed concurrently by another path, skipping');
      ctx.metrics.fiscalSigned.inc({ result: 'skipped' });
      return;
    }
    const receiptId = rows[0].id;
    const sale = rows[0].invoice_no === proposedInvoice ? draft : { ...draft, invoice_no: rows[0].invoice_no };
    const client = ctx.fiscalClientFor(sale.tpin, sale.branch_id);

    let sig: FiscalSignature;
    try {
      sig = await client.signSale(sale);
    } catch (err) {
      const retryable = isRetryable(err);
      await ctx.db.query(`UPDATE fms.fiscal_receipts SET last_error = $2, status = $3 WHERE id = $1 AND status = 'pending'`, [
        receiptId, errorMessage(err).slice(0, 2000), retryable ? 'pending' : 'failed',
      ]);
      log.warn({ err: errorMessage(err), retryable, invoice_no: sale.invoice_no }, 'VSDC signing failed');
      throw err;
    }

    await withTx(ctx.db, async (c) => {
      await c.query(
        `UPDATE fms.fiscal_receipts
            SET status = 'signed', zra_rcpt_no = $2, zra_tot_rcpt_no = $3, zra_internal_data = $4, zra_signature = $5,
                zra_sdc_id = $6, zra_mrc_no = $7, zra_qr_url = $8, zra_signed_at = $9, response = $10::jsonb, last_error = NULL
          WHERE id = $1`,
        [receiptId, sig.receipt_no, sig.total_receipt_no, sig.internal_data, sig.signature, sig.sdc_id, sig.mrc_no, sig.qr_url, sig.signed_at, JSON.stringify(sig.raw_response ?? null)],
      );
      await c.query(`UPDATE fms.pump_transactions pt SET fiscal_status = 'signed' WHERE ${TX_KEY_SQL}`, [p.station_id, p.pump_no, p.pts_transaction_no, p.ended_at]);
    });
    ctx.metrics.fiscalSigned.inc({ result: 'signed' });
    log.info({ invoice_no: sale.invoice_no, rcpt_no: sig.receipt_no, sdc_id: sig.sdc_id }, 'sale fiscalised by cloud');
    await archiveReceipt(ctx, tx, sale, sig);
  },

  async onDead(ctx, error) {
    let p: FiscalisePayload;
    try {
      p = parsePayload(ctx.job.payload);
    } catch {
      return;
    }
    await withTx(ctx.db, async (c) => {
      await c.query(
        `UPDATE fms.fiscal_receipts SET status = 'failed', last_error = $5
          WHERE station_id = $1 AND pump_no = $2 AND pts_transaction_no = $3
            AND tx_ended_at >= $4::timestamptz AND tx_ended_at < $4::timestamptz + interval '1 millisecond'
            AND status IN ('pending', 'failed')`,
        [p.station_id, p.pump_no, p.pts_transaction_no, p.ended_at, error.slice(0, 2000)],
      );
      await c.query(`UPDATE fms.pump_transactions pt SET fiscal_status = 'failed' WHERE ${TX_KEY_SQL} AND pt.fiscal_status = 'pending'`, [
        p.station_id, p.pump_no, p.pts_transaction_no, p.ended_at,
      ]);
    });
    ctx.metrics.fiscalSigned.inc({ result: 'failed' });
  },
};
