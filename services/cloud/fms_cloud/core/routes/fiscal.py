"""Port of services/core-api/src/routes/fiscal.ts."""

from __future__ import annotations

from typing import Literal

from django.http import HttpRequest
from ninja import Query, Router, Schema
from pydantic import Field

from ...common.db import ro
from ...common.sqlutil import Params
from ..auth import require_user
from ..scope import assert_station_in_scope, station_scope
from .stations import CoerceInt, IsoDateTime, keyset_cursor, page_of

router = Router(tags=["fiscal"])


class ReceiptsQuery(Schema):
    station_id: str | None = None
    status: Literal["pending", "signed", "failed", "printed"] | None = None
    from_: IsoDateTime | None = Field(None, alias="from")
    to: IsoDateTime | None = None
    limit: CoerceInt = Field(100, ge=1, le=500)
    cursor: str | None = None


@router.get("/fiscal/receipts", summary="ZRA Smart Invoice fiscal receipts, newest first")
def list_receipts(request: HttpRequest, q: Query[ReceiptsQuery]):
    pr = require_user(request, ["platform_admin", "owner", "manager", "zra_auditor", "erb_national", "erb_provincial"])
    db = ro()
    if q.station_id:
        assert_station_in_scope(db, pr, q.station_id)
    p = Params()
    where = [station_scope(pr, p)]
    if q.station_id:
        where.append(f"f.station_id = {p.add(q.station_id)}")
    if q.status:
        where.append(f"f.status = {p.add(q.status)}")
    if q.from_:
        where.append(f"f.tx_ended_at >= {p.add(q.from_)}::timestamptz")
    if q.to:
        where.append(f"f.tx_ended_at < {p.add(q.to)}::timestamptz")
    kc = keyset_cursor(q.cursor, p, "(f.tx_ended_at, f.id)")
    if kc:
        where.append(kc)
    rows = db.query(
        f"""SELECT f.id, f.station_id, s.code AS station_code, s.name AS station_name, f.pump_no, f.pts_transaction_no, f.tx_ended_at,
                f.invoice_no, f.status, f.fiscalised_by, f.zra_rcpt_no, f.zra_tot_rcpt_no, f.zra_internal_data, f.zra_signature,
                f.zra_sdc_id, f.zra_mrc_no, f.zra_qr_url, f.zra_signed_at, f.printed_at, f.attempts, f.last_error, f.created_at,
                pt.volume_l, pt.amount, pt.product_code,
                to_char(f.tx_ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.fiscal_receipts f
           JOIN fms.stations s ON s.id = f.station_id
           LEFT JOIN fms.pump_transactions pt ON pt.station_id = f.station_id AND pt.pump_no = f.pump_no
                 AND pt.pts_transaction_no = f.pts_transaction_no AND pt.ended_at = f.tx_ended_at
          WHERE {" AND ".join(where)}
          ORDER BY f.tx_ended_at DESC, f.id DESC LIMIT {q.limit + 1}""",
        p.values,
    )
    return page_of(rows, q.limit)
