"""Port of services/core-api/src/routes/stream.ts.

GET /api/v1/stream?station_id=&token=

Server-Sent Events for live dashboards. The read connection is polled every
STREAM_POLL_MS (default 5 s); no triggers are installed on tables owned by other
services. Each tick queries rows newer than the previous tick (with a 15 s overlap
window + de-duplication so rows from late-committing transactions are not missed).

Events (data is JSON):
  event: tank_latest  data: {items:[tank_latest rows]}      (also sent once on connect as a snapshot)
  event: sales        data: {items:[pump transaction rows]}
  event: alert        data: {items:[alert rows]}
  event: ready        data: {station_id, poll_ms}
A `: keepalive` comment is written every tick.

Under gunicorn gthread (WSGI) the stream is a StreamingHttpResponse over a sync
generator that owns its worker thread while the client is connected. A client
disconnect surfaces as a failed write; the server then closes the response and
the generator gets GeneratorExit at its next yield (within one poll interval).
Queries run in autocommit (no transaction is held open between polls), and
close_old_connections() after every tick drops broken or over-age connections.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from collections.abc import Callable, Iterator
from typing import Any

from django.db import close_old_connections
from django.http import HttpRequest, StreamingHttpResponse
from ninja import Query, Router, Schema

from ...common.db import ro
from ...common.jsonutil import dumps, iso
from ...common.sqlutil import Params
from ..auth import require_user
from ..config import config
from ..metrics import SSE_CLIENTS
from ..scope import Principal, assert_station_in_scope, station_id_scope

log = logging.getLogger("fms.stream")

router = Router(tags=["stream"])

OVERLAP_SEC = 15


class StreamQuery(Schema):
    station_id: str | None = None
    token: str | None = None


def _ms(v: Any) -> int:
    """Date.getTime() of a timestamptz value."""
    if isinstance(v, dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=dt.UTC)
        return int(v.timestamp() * 1000)
    return 0


def _event(event: str, data: Any) -> bytes:
    return f"event: {event}\ndata: {dumps(data)}\n\n".encode()


def _stream(pr: Principal, station_id: str | None, poll_ms: int) -> Iterator[bytes]:
    def filter_(p: Params, col: str) -> str:
        return f"{col} = {p.add(station_id)}" if station_id else station_id_scope(pr, p, col)

    seen: dict[str, float] = {}  # key -> epoch ms first seen
    since = dt.datetime.now(dt.UTC)

    def fresh(rows: list[dict[str, Any]], key: Callable[[dict[str, Any]], str]) -> list[dict[str, Any]]:
        out = []
        for r in rows:
            k = key(r)
            if k in seen:
                continue
            seen[k] = time.time() * 1000
            out.append(r)
        return out

    def tank_key(r: dict[str, Any]) -> str:
        return f"t:{r['station_id']}:{r['tank_no']}:{_ms(r['measured_at'])}"

    def tick(initial: bool = False) -> list[bytes]:
        nonlocal since
        chunks: list[bytes] = []
        try:
            db = ro()
            now = db.scalar("SELECT now() AS now")
            frm = iso(since - dt.timedelta(seconds=OVERLAP_SEC))

            p1 = Params()
            tanks = db.query(
                f"""SELECT station_id, tank_no, measured_at, product_code, probe_status, alarms, product_height_mm, water_height_mm,
                    temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l
               FROM fms.tank_latest WHERE {filter_(p1, "station_id")}
               {"" if initial else f"AND measured_at > {p1.add(frm)}::timestamptz"}
              ORDER BY station_id, tank_no LIMIT 2000""",
                p1.values,
            )
            if initial:
                t = tanks
                for r in tanks:
                    seen[tank_key(r)] = time.time() * 1000
            else:
                t = fresh(tanks, tank_key)
            if t:
                chunks.append(_event("tank_latest", {"items": t}))

            if not initial:
                p2 = Params()
                sales = db.query(
                    f"""SELECT id, station_id, ended_at, pump_no, nozzle_no, product_code, volume_l, price, amount, tag, fiscal_status
                 FROM fms.pump_transactions
                WHERE {filter_(p2, "station_id")} AND received_at > {p2.add(frm)}::timestamptz
                  AND ended_at > now() - interval '2 days'
                ORDER BY received_at LIMIT 1000""",
                    p2.values,
                )
                s = fresh(sales, lambda r: f"s:{r['id']}")
                if s:
                    chunks.append(_event("sales", {"items": s}))

                p3 = Params()
                alerts = db.query(
                    f"""SELECT id, station_id, occurred_at, device_type, device_no, code, severity, message, data, acknowledged_at
                 FROM fms.alerts WHERE {filter_(p3, "station_id")} AND received_at > {p3.add(frm)}::timestamptz
                ORDER BY received_at LIMIT 500""",
                    p3.values,
                )
                a = fresh(alerts, lambda r: f"a:{r['id']}")
                if a:
                    chunks.append(_event("alert", {"items": a}))

            since = now
            cutoff = time.time() * 1000 - (OVERLAP_SEC + 60) * 1000
            for k in [k for k, v in seen.items() if v < cutoff]:
                del seen[k]
            chunks.append(b": keepalive\n\n")
        except Exception as e:
            log.warning("sse poll failed", exc_info=e)
        finally:
            close_old_connections()
        return chunks

    SSE_CLIENTS.inc()
    try:
        yield _event("ready", {"station_id": station_id, "poll_ms": poll_ms})
        yield from tick(True)
        interval = poll_ms / 1000
        next_at = time.monotonic() + interval
        while True:
            delay = next_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            yield from tick()
            # setInterval semantics: fixed cadence; a slow tick skips the slots it overran (core-api's `busy` flag).
            done_at = time.monotonic()
            next_at += interval
            while next_at <= done_at:
                next_at += interval
    finally:
        # Runs on GeneratorExit (client gone, response closed) or worker shutdown.
        SSE_CLIENTS.dec()


@router.get("/stream", summary="Server-Sent Events: tank_latest / sales / alert (auth via Bearer header or ?token=)")
def stream(request: HttpRequest, q: Query[StreamQuery]):
    pr = require_user(request, allow_query_token=True)
    station_id = q.station_id
    if station_id:
        assert_station_in_scope(ro(), pr, station_id)
    resp = StreamingHttpResponse(_stream(pr, station_id, config().stream_poll_ms), content_type="text/event-stream; charset=utf-8")
    resp["Cache-Control"] = "no-cache, no-transform"
    resp["X-Accel-Buffering"] = "no"
    # `Connection: keep-alive` is a hop-by-hop header, which WSGI applications may not set
    # (wsgiref rejects it, gunicorn drops it); HTTP/1.1 connections are persistent anyway.
    return resp
