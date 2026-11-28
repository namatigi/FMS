"""Port of services/core-api/src/routes/alerts.ts."""

from __future__ import annotations

from typing import Literal

from django.http import HttpRequest
from ninja import Query, Router, Schema
from pydantic import Field

from ...common.db import ro, tx
from ...common.errors import not_found
from ...common.sqlutil import Params
from ..audit import audit
from ..auth import require_roles, require_user
from ..scope import assert_station_in_scope, station_scope
from .stations import CoerceInt, IsoDateTime, keyset_cursor, page_of, parse_optional_body, path_int

router = Router(tags=["alerts"])

ALERT_COLUMNS = """a.id, a.station_id, s.code AS station_code, s.name AS station_name, s.province_id,
  a.occurred_at, a.device_type, a.device_no, a.code, a.severity, a.message, a.data,
  a.acknowledged_at, a.acknowledged_by, a.received_at,
  CASE WHEN a.acknowledged_at IS NULL THEN 'open' ELSE 'acknowledged' END AS status"""


class AlertsQuery(Schema):
    station_id: str | None = None
    status: Literal["open", "all", "acknowledged"] = "open"
    severity: Literal["info", "warning", "critical"] | None = None
    from_: IsoDateTime | None = Field(None, alias="from")
    to: IsoDateTime | None = None
    limit: CoerceInt = Field(100, ge=1, le=500)
    cursor: str | None = None


class AckBody(Schema):
    note: str | None = Field(None, max_length=1000)


@router.get("/alerts", summary="Alerts in scope (default: open only), newest first")
def list_alerts(request: HttpRequest, q: Query[AlertsQuery]):
    pr = require_user(request)
    db = ro()
    if q.station_id:
        assert_station_in_scope(db, pr, q.station_id)
    p = Params()
    where = [station_scope(pr, p)]
    if q.station_id:
        where.append(f"a.station_id = {p.add(q.station_id)}")
    if q.status == "open":
        where.append("a.acknowledged_at IS NULL")
    if q.status == "acknowledged":
        where.append("a.acknowledged_at IS NOT NULL")
    if q.severity:
        where.append(f"a.severity = {p.add(q.severity)}")
    if q.from_:
        where.append(f"a.occurred_at >= {p.add(q.from_)}::timestamptz")
    if q.to:
        where.append(f"a.occurred_at < {p.add(q.to)}::timestamptz")
    kc = keyset_cursor(q.cursor, p, "(a.occurred_at, a.id)")
    if kc:
        where.append(kc)
    rows = db.query(
        f"""SELECT {ALERT_COLUMNS}, to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _k
           FROM fms.alerts a JOIN fms.stations s ON s.id = a.station_id
          WHERE {" AND ".join(where)}
          ORDER BY a.occurred_at DESC, a.id DESC LIMIT {q.limit + 1}""",
        p.values,
    )
    return page_of(rows, q.limit)


@router.post("/alerts/{id}/ack", summary="Acknowledge an alert")
def ack_alert(request: HttpRequest, id: str):
    # Fastify validates params and body before the auth preHandlers run.
    alert_id = path_int(id)
    body = parse_optional_body(request, AckBody)
    pr = require_user(request)
    require_roles(request, "platform_admin", "owner", "manager")
    with tx() as c:
        p = Params([alert_id, pr.id])
        rows = c.query(
            f"""UPDATE fms.alerts a SET acknowledged_at = coalesce(a.acknowledged_at, now()), acknowledged_by = coalesce(a.acknowledged_by, $2::uuid)
             FROM fms.stations s
            WHERE a.id = $1 AND s.id = a.station_id AND {station_scope(pr, p)}
            RETURNING {ALERT_COLUMNS}""",
            p.values,
        )
        if not rows:
            raise not_found("alert")
        audit(
            c,
            request,
            "alert.ack",
            entity="alert",
            entity_id=alert_id,
            details={"station_id": rows[0]["station_id"], "note": body.note if body else None},
        )
        return rows[0]
