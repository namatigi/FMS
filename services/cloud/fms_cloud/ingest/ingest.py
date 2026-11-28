"""Request-level orchestration (port of services/ingest-api/src/ingest.ts).

Auth happens in views.py; this module normalises/validates, persists in one transaction and falls
back to per-item transactions when the set-based transaction fails on a single bad row.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fms_cloud.common.db import Conn

from . import metrics
from .config import Config
from .dbutil import is_transient_db_error, with_tx
from .jsonpts import JsonPtsMappingError, jsonpts_reply, normalize_jsonpts_packet
from .jsutil import dumps, is_number, is_safe_integer, js_string
from .persist import PersistCtx, Persister, PersistItem, RaisedAlert, take_edge_commands
from .refdata import GatewayRef, RefData, StationRef
from .validate import RecordValidationError, record_pts_id, validate_record

log = logging.getLogger("fms.ingest")


class TransientError(Exception):
    pass


@dataclass
class Deps:
    cfg: Config
    ref: RefData


def _err_msg(e: BaseException) -> str:
    return str(e)


@dataclass
class _Fallback:
    outcome: dict[int, str]
    failed: dict[int, dict[str, Any]]
    extra: Any


def _count_alerts(alerts: list[RaisedAlert]) -> None:
    for a in alerts:
        metrics.alerts.labels(a.code, a.severity).inc()


def persist_with_fallback[E](
    d: Deps,
    ctx: PersistCtx,
    items: list[PersistItem],
    extra: Callable[[Conn, list[PersistItem]], E],
    extra_single: Callable[[Conn, PersistItem], None],
) -> _Fallback:
    """Persist items in one transaction (plus `extra` work in the same transaction).

    If the set-based statement fails for a non-transient reason (one bad row poisons the whole
    statement), each item is retried in its own transaction so only the culprit is rejected.
    """
    failed: dict[int, dict[str, Any]] = {}
    try:

        def batch(c: Conn):
            r = Persister(c, ctx).run(items)
            e = extra(c, items)
            return r, e

        r, e = with_tx(batch)
        _count_alerts(r.alerts)
        return _Fallback(outcome=r.outcome, failed=failed, extra=e)
    except Exception as err:
        if is_transient_db_error(err):
            raise TransientError(_err_msg(err)) from err
        log.warning("batch transaction failed, falling back to per-record", extra={"err": _err_msg(err), "items": len(items)})
    outcome: dict[int, str] = {}
    for it in items:
        try:

            def single(c: Conn, it: PersistItem = it):
                res = Persister(c, ctx).run([it])
                extra_single(c, it)
                return res

            r = with_tx(single)
            _count_alerts(r.alerts)
            outcome[it.key] = r.outcome.get(it.key, "ignored")
        except Exception as err:  # noqa: BLE001 - any failure rejects just this record
            failed[it.key] = {"error": f"db: {_err_msg(err)}", "retryable": is_transient_db_error(err)}
    return _Fallback(outcome=outcome, failed=failed, extra=None)


# =====================================================================================
# Direct jsonPTS
# =====================================================================================


def handle_pts_upload(d: Deps, station: StationRef, pts_id: str, packets: list[Any]) -> tuple[int, dict[str, Any]]:
    """-> (status, jsonPTS reply body)."""
    results: list[dict[str, Any]] = []
    items: list[PersistItem] = []
    raw: list[dict[str, Any]] = []

    for idx, pk in enumerate(packets):
        is_obj = isinstance(pk, dict)
        pid = pk.get("Id") if is_obj and is_number(pk.get("Id")) else idx
        ptype = pk.get("Type") if is_obj and isinstance(pk.get("Type"), str) else None
        results.append({"id": pid, "type": ptype, "ok": False, "message": "Error"})
        raw.append({"k": idx, "t": ptype if ptype is not None else "Unknown", "p": pk})
        if not is_obj or ptype is None:
            results[idx]["message"] = "Malformed packet"
            metrics.record("unknown", "pts_direct", "rejected")
            continue
        try:
            rec = normalize_jsonpts_packet(pts_id, pk, station.tz_offset)
            if rec is None:
                results[idx]["ok"] = True  # accepted, archived raw only (GPS, configuration)
                metrics.record(ptype, "pts_direct", "ignored")
                continue
            items.append(PersistItem(key=idx, rec=validate_record(rec), station=station))
        except (JsonPtsMappingError, RecordValidationError) as err:
            results[idx]["message"] = str(err)
            metrics.record(ptype, "pts_direct", "rejected")
            metrics.reject("pts", "malformed_packet")

    ctx = PersistCtx(source="pts_direct", rollup_delay_s=d.cfg.rollup_delay_s, touch_controllers=[pts_id])

    def archive(c: Conn, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        c.execute(
            """INSERT INTO fms.ingest_raw (source, pts_id, station_id, packet_type, payload)
       SELECT 'pts_direct', $1, $2, r.t, r.p FROM json_to_recordset($3::json) AS r(k int, t text, p jsonb)""",
            [pts_id, station.id, dumps(rows)],
        )

    raw_by_key = {r["k"]: r for r in raw}
    item_keys = {i.key for i in items}
    raw_without_items = [r for r in raw if r["k"] not in item_keys]

    try:
        res = persist_with_fallback(d, ctx, items, lambda c, _items: archive(c, raw), lambda c, it: archive(c, [raw_by_key[it.key]]))
    except TransientError:
        metrics.reject("pts", "db_unavailable")
        return 503, jsonpts_reply([{**r, "ok": False, "message": "Temporarily unavailable, retry"} for r in results])
    if res.failed:
        # fallback mode: archive the packets that were not persisted individually (ignored/malformed)
        try:
            with_tx(lambda c: archive(c, raw_without_items))
        except Exception as e:  # noqa: BLE001
            log.error("raw archive failed", extra={"err": _err_msg(e)})
    for it in items:
        f = res.failed.get(it.key)
        r = results[it.key]
        if f:
            r["message"] = f["error"]
            metrics.record(it.rec["kind"], "pts_direct", "rejected")
        else:
            r["ok"] = True
            metrics.record(it.rec["kind"], "pts_direct", res.outcome.get(it.key, "ignored"))
    return 200, jsonpts_reply(results)


# =====================================================================================
# Edge batches
# =====================================================================================


def handle_edge_batch(d: Deps, gw: GatewayRef, station: StationRef, batch_id: str, records: list[Any], raw_batch: Any) -> dict[str, Any]:
    """-> EdgeBatchResponse. Raises TransientError when the database is unavailable."""
    accepted: list[int] = []
    rejected: list[dict[str, Any]] = []
    items: list[PersistItem] = []
    seq_of: dict[int, int] = {}

    for idx, r in enumerate(records):
        seq = r.get("seq") if isinstance(r, dict) else None
        if not is_safe_integer(seq):
            # without a seq the gateway cannot correlate; nothing to report back for it
            metrics.reject("edge", "missing_seq")
            continue
        seq = int(seq)
        try:
            rec = validate_record(r)
        except RecordValidationError as err:
            rejected.append({"seq": seq, "error": str(err), "retryable": False})
            kind = r.get("kind")
            metrics.record("unknown" if kind is None else js_string(kind), "edge", "rejected")
            metrics.reject("edge", "invalid_record")
            continue
        pts_id = record_pts_id(rec)
        if pts_id is not None:
            ctl = d.ref.controllers.get(pts_id)
            if not ctl:
                # retryable: the controller may simply not be registered in the cloud yet
                rejected.append({"seq": seq, "error": f"unknown controller {pts_id}", "retryable": True})
                metrics.reject("edge", "unknown_controller")
                continue
            if ctl.station_id != gw.station_id:
                rejected.append({"seq": seq, "error": f"controller {pts_id} does not belong to station {station.code}", "retryable": False})
                metrics.reject("edge", "station_mismatch")
                continue
        seq_of[idx] = seq
        items.append(PersistItem(key=idx, rec=rec, station=station))

    ctx = PersistCtx(source="edge", gateway_id=gw.id, rollup_delay_s=d.cfg.rollup_delay_s)

    def extra(c: Conn, _items: list[PersistItem] | None = None) -> list[dict[str, Any]]:
        if d.cfg.archive_edge_batches:
            c.execute(
                """INSERT INTO fms.ingest_raw (source, gateway_code, station_id, packet_type, payload) VALUES ('edge', $1, $2, 'EdgeBatch', $3::jsonb)""",
                [gw.gateway_code, station.id, dumps(raw_batch)],
            )
        return take_edge_commands(c, station.id, gw.gateway_code, d.cfg.max_commands_per_response, d.cfg.command_redeliver_s)

    # ensure the heartbeat/last_seen update runs even for batches with zero valid records
    res = persist_with_fallback(d, ctx, items, extra, lambda c, it: None)
    commands = res.extra
    if commands is None:
        try:
            commands = with_tx(extra)
        except Exception:  # noqa: BLE001
            commands = []
    for it in items:
        seq = seq_of[it.key]
        f = res.failed.get(it.key)
        if f:
            rejected.append({"seq": seq, **f})
            metrics.record(it.rec["kind"], "edge", "rejected")
        else:
            accepted.append(seq)
            metrics.record(it.rec["kind"], "edge", res.outcome.get(it.key, "ignored"))
    return {"batch_id": batch_id, "accepted": accepted, "rejected": rejected, "commands": commands}
