"""`fiscalise`: cloud ZRA fiscalisation (direct-mode stations, or edge sales left unsigned).
payload: {station_id, pump_no, pts_transaction_no, ended_at}

Idempotency: the invoice number is deterministic and fiscal_receipts is unique per
transaction; if a receipt row already exists its invoice_no is reused, so the VSDC sees
the same cisInvcNo on every retry (duplicate -> returns the original signature).
"""

from __future__ import annotations

from typing import Any

from fms_cloud.common.db import tx
from fms_cloud.common.jsonutil import iso

from ..core import error_message, is_retryable, permanent, req
from ..jscompat import coalesce, js_dumps, js_number, js_round, js_sum
from ..zra import VSDC_SPEC, build_invoice_no, vat_breakdown
from .base import HandlerContext, JobHandler


def parse_payload(p: dict[str, Any]) -> dict[str, Any]:
    return {
        "station_id": req.uuid(p, "station_id"),
        "pump_no": req.int(p, "pump_no"),
        "pts_transaction_no": req.int(p, "pts_transaction_no"),
        "ended_at": req.timestamp(p, "ended_at"),
    }


# ended_at in payloads/dedupe keys is ISO-8601 with millisecond precision; match the
# stored timestamptz within that millisecond (stays on the unique index prefix).
TX_KEY_SQL = """pt.station_id = $1 AND pt.pump_no = $2 AND pt.pts_transaction_no = $3
  AND pt.ended_at >= $4::timestamptz AND pt.ended_at < $4::timestamptz + interval '1 millisecond'"""


def _key(p: dict[str, Any]) -> list[Any]:
    return [p["station_id"], p["pump_no"], p["pts_transaction_no"], p["ended_at"]]


def load_tx(ctx: HandlerContext, p: dict[str, Any]) -> dict[str, Any] | None:
    return ctx.db.one(
        f"""SELECT s.id AS station_id, s.code AS station_code, s.name AS station_name, s.address AS station_address,
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
      WHERE {TX_KEY_SQL}""",
        _key(p),
    )


def build_sale(ctx: HandlerContext, t: dict[str, Any], invoice_no: str) -> dict[str, Any]:
    """FiscalSaleRequest for the transaction."""
    if not t["tpin"]:
        raise permanent(f"Company of station {t['station_code']} has no ZRA TPIN", "NO_TPIN")
    if not t["zra_item_code"]:
        raise permanent(
            f"No ZRA item code for grade of {t['station_code']} pump {t['pump_no']} (fuel_grades.zra_item_code)", "NO_ITEM_CODE"
        )
    return {
        "tpin": t["tpin"],
        "branch_id": t["zra_branch_id"],
        "invoice_no": invoice_no,
        "sale_time": iso(t["ended_at"]),
        "payment_type": ctx.config.zra.default_payment_type,
        "customer_tpin": None,
        "customer_name": None,
        "cashier_id": None,
        "lines": [
            {
                "item_code": t["zra_item_code"],
                "item_class_code": t["zra_item_class_cd"],
                "item_name": coalesce(t["grade_name"], t["product_name"], t["product_code"], "Fuel"),
                "qty": js_number(t["volume_l"]),
                "unit_price": js_number(t["price"]),
                "total": js_number(t["amount"]),
                "vat_category": coalesce(t["zra_vat_cat_cd"], "A"),
            }
        ],
    }


def archive_receipt(ctx: HandlerContext, t: dict[str, Any], sale: dict[str, Any], sig: dict[str, Any]) -> None:
    if not ctx.receipt_archive:
        return
    vat = 0
    try:
        vat = js_sum(b["tax"] for b in vat_breakdown(sale["lines"], {**VSDC_SPEC.defaultVatRates, **ctx.config.zra.vat_rates}))
    except Exception:  # noqa: BLE001, S110 - unknown category: print without VAT split
        pass
    doc = {
        "station_name": t["station_name"],
        "station_address": t["station_address"],
        "tpin": sale["tpin"],
        "invoice_no": sale["invoice_no"],
        "sale_time": sale["sale_time"],
        "pump_no": t["pump_no"],
        "nozzle_no": t["nozzle_no"],
        "attendant": t["tag"],
        "lines": sale["lines"],
        "total": js_sum(line["total"] for line in sale["lines"]),
        "vat_total": js_round(vat * 100) / 100,
        "payment_type": sale["payment_type"],
        "signature": sig,
    }
    try:
        ctx.receipt_archive.print(doc)
    except Exception as err:  # noqa: BLE001
        ctx.log.warning("receipt archive failed", err=error_message(err), invoice_no=sale["invoice_no"])


def mark_signed(ctx: HandlerContext, p: dict[str, Any]) -> None:
    ctx.db.execute(
        f"UPDATE fms.pump_transactions pt SET fiscal_status = 'signed' WHERE {TX_KEY_SQL} AND pt.fiscal_status <> 'signed'", _key(p)
    )


def handle(ctx: HandlerContext) -> None:
    p = parse_payload(ctx.job.payload)
    t = load_tx(ctx, p)
    if not t:
        raise permanent(f"pump transaction not found: {js_dumps(p)}", "TX_NOT_FOUND")
    log = ctx.log.child(station=t["station_code"], pump=t["pump_no"], txno=t["pts_transaction_no"])

    if t["fiscal_status"] == "exempt":
        log.info("transaction exempt from fiscalisation, skipping")
        ctx.metrics.fiscal_signed.labels(result="skipped").inc()
        return
    if t["receipt_status"] in ("signed", "printed"):
        # Edge (or an earlier attempt) already signed it; make sure the transaction reflects it.
        if t["fiscal_status"] != "signed":
            mark_signed(ctx, p)
        log.info("already fiscalised, skipping", receipt_status=t["receipt_status"])
        ctx.metrics.fiscal_signed.labels(result="skipped").inc()
        return

    proposed_invoice = build_invoice_no(
        t["station_code"], t["pump_no"], t["pts_transaction_no"], t["ended_at"], t["timezone"] or "Africa/Lusaka"
    )
    draft = build_sale(ctx, t, proposed_invoice)

    # Upsert the receipt row; an existing row keeps its invoice_no (edge may have tried already).
    row = ctx.db.one(
        """INSERT INTO fms.fiscal_receipts AS fr (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, fiscalised_by, attempts, request)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'cloud', 1, $6::jsonb)
       ON CONFLICT (station_id, pump_no, pts_transaction_no, tx_ended_at) DO UPDATE
          SET attempts = fr.attempts + 1, fiscalised_by = 'cloud', status = 'pending'
        WHERE fr.status IN ('pending', 'failed')
       RETURNING fr.id, fr.invoice_no""",
        [t["station_id"], t["pump_no"], t["pts_transaction_no"], t["ended_at"], proposed_invoice, js_dumps({"sale": draft})],
    )
    if not row:
        mark_signed(ctx, p)
        log.info("receipt signed concurrently by another path, skipping")
        ctx.metrics.fiscal_signed.labels(result="skipped").inc()
        return
    receipt_id = row["id"]
    sale = draft if row["invoice_no"] == proposed_invoice else {**draft, "invoice_no": row["invoice_no"]}
    client = ctx.fiscal_client_for(sale["tpin"], sale["branch_id"])

    try:
        sig = client.sign_sale(sale)
    except Exception as err:
        retryable = is_retryable(err)
        ctx.db.execute(
            "UPDATE fms.fiscal_receipts SET last_error = $2, status = $3 WHERE id = $1 AND status = 'pending'",
            [receipt_id, error_message(err)[:2000], "pending" if retryable else "failed"],
        )
        log.warning("VSDC signing failed", err=error_message(err), retryable=retryable, invoice_no=sale["invoice_no"])
        raise

    with tx(ctx.db.alias) as c:
        c.execute(
            """UPDATE fms.fiscal_receipts
            SET status = 'signed', zra_rcpt_no = $2, zra_tot_rcpt_no = $3, zra_internal_data = $4, zra_signature = $5,
                zra_sdc_id = $6, zra_mrc_no = $7, zra_qr_url = $8, zra_signed_at = $9, response = $10::jsonb, last_error = NULL
          WHERE id = $1""",
            [
                receipt_id,
                sig["receipt_no"],
                sig["total_receipt_no"],
                sig["internal_data"],
                sig["signature"],
                sig["sdc_id"],
                sig["mrc_no"],
                sig["qr_url"],
                sig["signed_at"],
                js_dumps(sig.get("raw_response")),
            ],
        )
        c.execute(f"UPDATE fms.pump_transactions pt SET fiscal_status = 'signed' WHERE {TX_KEY_SQL}", _key(p))
    ctx.metrics.fiscal_signed.labels(result="signed").inc()
    log.info("sale fiscalised by cloud", invoice_no=sale["invoice_no"], rcpt_no=sig["receipt_no"], sdc_id=sig["sdc_id"])
    archive_receipt(ctx, t, sale, sig)


def on_dead(ctx: HandlerContext, error: str) -> None:
    try:
        p = parse_payload(ctx.job.payload)
    except Exception:  # noqa: BLE001
        return
    with tx(ctx.db.alias) as c:
        c.execute(
            """UPDATE fms.fiscal_receipts SET status = 'failed', last_error = $5
          WHERE station_id = $1 AND pump_no = $2 AND pts_transaction_no = $3
            AND tx_ended_at >= $4::timestamptz AND tx_ended_at < $4::timestamptz + interval '1 millisecond'
            AND status IN ('pending', 'failed')""",
            [*_key(p), error[:2000]],
        )
        c.execute(
            f"UPDATE fms.pump_transactions pt SET fiscal_status = 'failed' WHERE {TX_KEY_SQL} AND pt.fiscal_status = 'pending'", _key(p)
        )
    ctx.metrics.fiscal_signed.labels(result="failed").inc()


fiscalise_handler = JobHandler(kind="fiscalise", handle=handle, on_dead=on_dead)
