"""Set-based persistence of normalised telemetry records (port of services/ingest-api/src/persist.ts).

All records of one request are written in ONE transaction, with one multi-row statement per
table (json_to_recordset), so a 500-record batch costs ~10-15 round trips instead of ~500+.
Every write is idempotent on the table's natural key, so the PTS-2 / edge gateway may resend
anything any number of times.
"""

from __future__ import annotations

import datetime as dt
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from fms_cloud.common.db import Conn

from .jsonpts import alarms_to_alerts
from .jsutil import dumps, js_string, num_out, parse_iso, to_iso
from .refdata import StationRef, local_date

Outcome = Literal["inserted", "duplicate", "ignored"]


@dataclass
class PersistItem:
    key: int  # caller-defined key (edge: record index; jsonPTS: packet index)
    rec: dict[str, Any]  # validated {"kind", "data"}
    station: StationRef


@dataclass
class PersistCtx:
    source: Literal["pts_direct", "edge"]
    rollup_delay_s: int
    gateway_id: str | None = None
    touch_controllers: list[str] = field(default_factory=list)  # pts_ids whose last_seen_at is touched (direct mode)


@dataclass
class RaisedAlert:
    id: int
    code: str
    severity: str


@dataclass
class PersistResult:
    outcome: dict[int, Outcome]
    alerts: list[RaisedAlert]
    jobs: int


@dataclass
class _PendingAlert:
    station: StationRef
    rec: dict[str, Any]
    key: int | None = None  # item key when the alert came in as an `alert` record
    webhook_event: str | None = None  # extra webhook to emit when newly inserted (e.g. stock_low)


def ms(v: str | dt.datetime) -> str:
    return to_iso(v)


def round3(n: float) -> float | int:
    """Math.round(n * 1000) / 1000 (half rounds towards +infinity)."""
    return num_out(math.floor(n * 1000 + 0.5) / 1000)


def _dedupe(xs: list, key: Callable[[Any], str]) -> tuple[list, list]:
    """First occurrence of each natural key (multi-row upserts cannot touch a row twice) + the repeats."""
    seen: set[str] = set()
    uniq: list = []
    dups: list = []
    for x in xs:
        k = key(x)
        if k in seen:
            dups.append(x)
        else:
            seen.add(k)
            uniq.append(x)
    return uniq, dups


def _product_of_grade(st: StationRef, grade: int | None) -> str | None:
    return st.grades.get(grade) if grade is not None else None


class Persister:
    def __init__(self, c: Conn, ctx: PersistCtx) -> None:
        self.c = c
        self.ctx = ctx
        self.outcome: dict[int, Outcome] = {}
        self.alerts: list[_PendingAlert] = []
        self.jobs: list[dict[str, Any]] = []
        self.rollups: dict[str, dict[str, str]] = {}
        self.raised: list[RaisedAlert] = []

    def run(self, items: list[PersistItem]) -> PersistResult:
        def by(kind: str) -> list[PersistItem]:
            return [i for i in items if i.rec["kind"] == kind]

        self._pump_transactions(by("pump_transaction"))
        self._tank_measurements(by("tank_measurement"))
        self._tank_deliveries(by("tank_delivery"))
        for it in by("alert"):
            self.alerts.append(_PendingAlert(station=it.station, rec=it.rec["data"], key=it.key))
        self._command_acks(by("command_ack"))
        self._insert_alerts()
        self._statuses(by("status"))
        self._heartbeats(by("heartbeat"))
        self._fiscal_receipts(by("fiscal_receipt"))
        self._insert_jobs()
        self._enqueue_rollups()
        return PersistResult(outcome=self.outcome, alerts=self.raised, jobs=len(self.jobs))

    def _add_rollup(self, st: StationRef, at: str) -> None:
        d = local_date(at, st.timezone)
        k = f"rollup:{st.id}:{d}"
        if k not in self.rollups:
            self.rollups[k] = {"station_id": st.id, "business_date": d}

    # ---------------------------------------------------------------- pump transactions
    def _pump_transactions(self, items: list[PersistItem]) -> None:
        if not items:
            return

        def key(st: str, pump: int, txno: int, ended: str) -> str:
            return f"{st}|{pump}|{txno}|{ended}"

        uniq, dups = _dedupe(
            items, lambda i: key(i.station.id, i.rec["data"]["pump_no"], i.rec["data"]["pts_transaction_no"], i.rec["data"]["ended_at"])
        )
        rows = []
        for i in uniq:
            t = i.rec["data"]
            st = i.station
            nz = st.nozzles.get(f"{t['pump_no']}:{t['nozzle_no']}")
            product = _product_of_grade(st, t["pts_grade_id"])
            if product is None:
                product = nz.product_code if nz else None
            rows.append(
                {
                    "station_id": st.id,
                    "pts_id": t["pts_id"],
                    "pts_transaction_no": t["pts_transaction_no"],
                    "pump_no": t["pump_no"],
                    "nozzle_no": t["nozzle_no"],
                    "pts_grade_id": t["pts_grade_id"],
                    "product_code": product,
                    "tank_no": nz.tank_no if nz else None,
                    "started_at": t["started_at"],
                    "ended_at": t["ended_at"],
                    "volume_l": t["volume_l"],
                    "tc_volume_l": t["tc_volume_l"],
                    "price": t["price"],
                    "amount": t["amount"],
                    "total_volume_l": t["total_volume_l"],
                    "total_amount": t["total_amount"],
                    "tag": t["tag"],
                    "pts_user_id": t["pts_user_id"],
                    "source": self.ctx.source,
                }
            )
        # fiscal_status is pre-set when the edge synced the receipt before the sale (out-of-order batches).
        res = self.c.query(
            """INSERT INTO fms.pump_transactions
         (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, pts_grade_id, product_code, tank_no,
          started_at, ended_at, volume_l, tc_volume_l, price, amount, total_volume_l, total_amount, tag,
          pts_user_id, source, fiscal_status)
       SELECT r.station_id, r.pts_id, r.pts_transaction_no, r.pump_no, r.nozzle_no, r.pts_grade_id, r.product_code, r.tank_no,
              r.started_at, r.ended_at, r.volume_l, r.tc_volume_l, r.price, r.amount, r.total_volume_l, r.total_amount, r.tag,
              r.pts_user_id, r.source,
              coalesce((SELECT CASE WHEN f.status IN ('signed','printed') THEN 'signed'
                                    WHEN f.status = 'failed' THEN 'failed' ELSE 'pending' END
                          FROM fms.fiscal_receipts f
                         WHERE f.station_id = r.station_id AND f.pump_no = r.pump_no
                           AND f.pts_transaction_no = r.pts_transaction_no AND f.tx_ended_at = r.ended_at), 'pending')
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, pts_id text, pts_transaction_no int, pump_no int, nozzle_no int, pts_grade_id int,
              product_code text, tank_no int, started_at timestamptz, ended_at timestamptz, volume_l numeric,
              tc_volume_l numeric, price numeric, amount numeric, total_volume_l numeric, total_amount numeric,
              tag text, pts_user_id int, source text)
       ON CONFLICT DO NOTHING
       RETURNING station_id, pump_no, pts_transaction_no, ended_at""",
            [dumps(rows)],
        )
        inserted = {key(r["station_id"], r["pump_no"], r["pts_transaction_no"], ms(r["ended_at"])) for r in res}
        fresh: list[PersistItem] = []
        for i in uniq:
            t = i.rec["data"]
            is_new = key(i.station.id, t["pump_no"], t["pts_transaction_no"], t["ended_at"]) in inserted
            self.outcome[i.key] = "inserted" if is_new else "duplicate"
            if is_new:
                fresh.append(i)
        for dup in dups:
            self.outcome[dup.key] = "duplicate"

        for i in fresh:
            t = i.rec["data"]
            self._add_rollup(i.station, t["ended_at"])
            if i.station.connection_mode == "direct":
                self.jobs.append(
                    {
                        "kind": "fiscalise",
                        "dedupe_key": f"fiscalise:{i.station.id}:{t['pump_no']}:{t['pts_transaction_no']}:{t['ended_at']}",
                        "payload": {
                            "station_id": i.station.id,
                            "pump_no": t["pump_no"],
                            "nozzle_no": t["nozzle_no"],
                            "pts_transaction_no": t["pts_transaction_no"],
                            "ended_at": t["ended_at"],
                        },
                    }
                )
        self._totaliser_check(fresh)

    def _totaliser_check(self, fresh: list[PersistItem]) -> None:
        """Totaliser continuity: unaccounted = (total_now - total_prev) - volume.

        > 0.5 L means fuel left the nozzle without a recorded sale (e.g. manual mode). Previous = latest
        earlier sale on the same station/pump/nozzle with a totaliser value (may be in this same batch:
        rows are already inserted).
        """
        with_totals = [i for i in fresh if i.rec["data"]["total_volume_l"] is not None]
        if not with_totals:
            return
        rows = [
            {
                "k": k,
                "station_id": i.station.id,
                "pump_no": i.rec["data"]["pump_no"],
                "nozzle_no": i.rec["data"]["nozzle_no"],
                "ended_at": i.rec["data"]["ended_at"],
            }
            for k, i in enumerate(with_totals)
        ]
        res = self.c.query(
            """SELECT r.k, p.total_volume_l AS prev_total
         FROM json_to_recordset($1::json) AS r(k int, station_id uuid, pump_no int, nozzle_no int, ended_at timestamptz)
         CROSS JOIN LATERAL (
              SELECT t.total_volume_l FROM fms.pump_transactions t
               WHERE t.station_id = r.station_id AND t.pump_no = r.pump_no AND t.nozzle_no = r.nozzle_no
                 AND t.ended_at < r.ended_at AND t.total_volume_l IS NOT NULL
               ORDER BY t.ended_at DESC LIMIT 1) p""",
            [dumps(rows)],
        )
        for r in res:
            i = with_totals[r["k"]]
            t = i.rec["data"]
            prev = num_out(float(r["prev_total"]))
            actual = t["total_volume_l"]
            expected = round3(prev + t["volume_l"])
            unaccounted = round3(actual - prev - t["volume_l"])
            if unaccounted > 0.5:
                self.alerts.append(
                    _PendingAlert(
                        station=i.station,
                        rec={
                            "pts_id": t["pts_id"],
                            "occurred_at": t["ended_at"],
                            "device_type": "pump",
                            "device_no": t["pump_no"],
                            "code": "TotalizerMismatch",
                            "severity": "critical",
                            "message": (
                                f"Pump {t['pump_no']} nozzle {t['nozzle_no']}: {js_string(unaccounted)} L dispensed without a recorded sale"
                            ),
                            "data": {
                                "expected": expected,
                                "actual": actual,
                                "unaccounted_l": unaccounted,
                                "previous_total_l": prev,
                                "nozzle_no": t["nozzle_no"],
                                "pts_transaction_no": t["pts_transaction_no"],
                                "product_code": _product_of_grade(i.station, t["pts_grade_id"]),
                            },
                        },
                    )
                )

    # ---------------------------------------------------------------- tank measurements
    def _tank_measurements(self, items: list[PersistItem]) -> None:
        if not items:
            return

        def key(st: str, tank: int, at: str) -> str:
            return f"{st}|{tank}|{at}"

        uniq, dups = _dedupe(items, lambda i: key(i.station.id, i.rec["data"]["tank_no"], i.rec["data"]["measured_at"]))
        rows = []
        for i in uniq:
            m = i.rec["data"]
            tank = i.station.tanks.get(m["tank_no"])
            rows.append(
                {
                    "station_id": i.station.id,
                    "tank_no": m["tank_no"],
                    "measured_at": m["measured_at"],
                    "product_code": tank.product_code if tank else None,
                    "probe_status": m["probe_status"],
                    "alarms": m["alarms"],
                    "product_height_mm": m["product_height_mm"],
                    "water_height_mm": m["water_height_mm"],
                    "temperature_c": m["temperature_c"],
                    "product_volume_l": m["product_volume_l"],
                    "water_volume_l": m["water_volume_l"],
                    "ullage_l": m["ullage_l"],
                    "tc_volume_l": m["tc_volume_l"],
                    "density_kg_m3": m["density_kg_m3"],
                    "mass_kg": m["mass_kg"],
                }
            )
        res = self.c.query(
            """INSERT INTO fms.tank_measurements
         (station_id, tank_no, measured_at, product_code, probe_status, alarms, product_height_mm, water_height_mm,
          temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l, density_kg_m3, mass_kg)
       SELECT r.station_id, r.tank_no, r.measured_at, r.product_code, r.probe_status, r.alarms, r.product_height_mm,
              r.water_height_mm, r.temperature_c, r.product_volume_l, r.water_volume_l, r.ullage_l, r.tc_volume_l,
              r.density_kg_m3, r.mass_kg
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, tank_no int, measured_at timestamptz, product_code text, probe_status text, alarms text[],
              product_height_mm numeric, water_height_mm numeric, temperature_c numeric, product_volume_l numeric,
              water_volume_l numeric, ullage_l numeric, tc_volume_l numeric, density_kg_m3 numeric, mass_kg numeric)
       ON CONFLICT DO NOTHING
       RETURNING station_id, tank_no, measured_at""",
            [dumps(rows)],
        )
        inserted = {key(r["station_id"], r["tank_no"], ms(r["measured_at"])) for r in res}
        fresh: list[tuple[PersistItem, dict[str, Any]]] = []
        for idx, i in enumerate(uniq):
            is_new = key(i.station.id, i.rec["data"]["tank_no"], i.rec["data"]["measured_at"]) in inserted
            self.outcome[i.key] = "inserted" if is_new else "duplicate"
            if is_new:
                fresh.append((i, rows[idx]))
        for dup in dups:
            self.outcome[dup.key] = "duplicate"
        if not fresh:
            return

        # Rollups: the measurement sets that day's closing stock and the next day's opening stock.
        today: dict[str, str] = {}
        for item, row in fresh:
            st = item.station
            self._add_rollup(st, row["measured_at"])
            next_day = to_iso(parse_iso(row["measured_at"]) + dt.timedelta(days=1))
            if st.timezone not in today:
                today[st.timezone] = local_date(dt.datetime.now(dt.UTC), st.timezone)
            if local_date(next_day, st.timezone) <= today[st.timezone]:
                self._add_rollup(st, next_day)

        # Group per tank (ascending time) and fetch the current tank_latest rows.
        groups: dict[str, list[tuple[PersistItem, dict[str, Any]]]] = {}
        for f in fresh:
            groups.setdefault(f"{f[1]['station_id']}|{f[1]['tank_no']}", []).append(f)
        for g in groups.values():
            g.sort(key=lambda f: f[1]["measured_at"])
        tanks = [{"station_id": g[0][1]["station_id"], "tank_no": g[0][1]["tank_no"]} for g in groups.values()]
        old_rows = self.c.query(
            """SELECT tl.station_id, tl.tank_no, tl.measured_at, tl.product_volume_l, tl.alarms
         FROM fms.tank_latest tl
         JOIN json_to_recordset($1::json) AS r(station_id uuid, tank_no int)
           ON tl.station_id = r.station_id AND tl.tank_no = r.tank_no""",
            [dumps(tanks)],
        )
        old = {f"{r['station_id']}|{r['tank_no']}": r for r in old_rows}

        latest: list[dict[str, Any]] = []
        for k, g in groups.items():
            prev = old.get(k)
            st = g[0][0].station
            # Alarm onset: raise an alert only when a flag appears that the previous reading did not have.
            prev_alarms = set((prev or {}).get("alarms") or [])
            for item, _row in g:
                for a in alarms_to_alerts(item.rec["data"]):
                    if a["code"] not in prev_alarms:
                        self.alerts.append(_PendingAlert(station=st, rec=a))
                prev_alarms = set(item.rec["data"]["alarms"])
            newest = g[-1][1]
            is_newer = prev is None or prev["measured_at"] < parse_iso(newest["measured_at"])
            if not is_newer:
                continue
            latest.append(newest)
            # Low stock: crossing from >= low_level_l (or unknown) to below it.
            tank = st.tanks.get(newest["tank_no"])
            low = tank.low_level_l if tank else None
            vol = newest["product_volume_l"]
            prev_vol = None if prev is None or prev.get("product_volume_l") is None else num_out(float(prev["product_volume_l"]))
            if low is not None and vol is not None and vol < low and (prev_vol is None or prev_vol >= low):
                product = tank.product_code if tank else None
                self.alerts.append(
                    _PendingAlert(
                        station=st,
                        webhook_event="stock_low",
                        rec={
                            "pts_id": g[0][0].rec["data"]["pts_id"],
                            "occurred_at": newest["measured_at"],
                            "device_type": "tank",
                            "device_no": newest["tank_no"],
                            "code": "LowStock",
                            "severity": "warning",
                            "message": (
                                f"Tank {newest['tank_no']} ({product if product is not None else '?'}) below reorder level: "
                                f"{js_string(vol)} L < {js_string(low)} L"
                            ),
                            "data": {
                                "tank_no": newest["tank_no"],
                                "product_code": product,
                                "product_volume_l": vol,
                                "low_level_l": low,
                                "capacity_l": tank.capacity_l if tank else None,
                                "previous_volume_l": prev_vol,
                            },
                        },
                    )
                )
        if not latest:
            return
        latest.sort(key=lambda r: f"{r['station_id']}{r['tank_no']}")  # stable lock order
        self.c.execute(
            """INSERT INTO fms.tank_latest AS tl
         (station_id, tank_no, measured_at, product_code, probe_status, alarms, product_height_mm, water_height_mm,
          temperature_c, product_volume_l, water_volume_l, ullage_l, tc_volume_l)
       SELECT r.station_id, r.tank_no, r.measured_at, r.product_code, r.probe_status, r.alarms, r.product_height_mm,
              r.water_height_mm, r.temperature_c, r.product_volume_l, r.water_volume_l, r.ullage_l, r.tc_volume_l
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, tank_no int, measured_at timestamptz, product_code text, probe_status text, alarms text[],
              product_height_mm numeric, water_height_mm numeric, temperature_c numeric, product_volume_l numeric,
              water_volume_l numeric, ullage_l numeric, tc_volume_l numeric)
       ON CONFLICT (station_id, tank_no) DO UPDATE SET
              measured_at = EXCLUDED.measured_at, product_code = EXCLUDED.product_code,
              probe_status = EXCLUDED.probe_status, alarms = EXCLUDED.alarms,
              product_height_mm = EXCLUDED.product_height_mm, water_height_mm = EXCLUDED.water_height_mm,
              temperature_c = EXCLUDED.temperature_c, product_volume_l = EXCLUDED.product_volume_l,
              water_volume_l = EXCLUDED.water_volume_l, ullage_l = EXCLUDED.ullage_l, tc_volume_l = EXCLUDED.tc_volume_l
        WHERE tl.measured_at < EXCLUDED.measured_at""",
            [dumps(latest)],
        )

    # ---------------------------------------------------------------- deliveries
    def _tank_deliveries(self, items: list[PersistItem]) -> None:
        if not items:
            return

        def key(st: str, tank: int, at: str) -> str:
            return f"{st}|{tank}|{at}"

        uniq, dups = _dedupe(items, lambda i: key(i.station.id, i.rec["data"]["tank_no"], i.rec["data"]["started_at"]))
        rows = []
        for i in uniq:
            d = i.rec["data"]
            tank = i.station.tanks.get(d["tank_no"])
            rows.append(
                {
                    "station_id": i.station.id,
                    "tank_no": d["tank_no"],
                    "product_code": tank.product_code if tank else None,
                    **{
                        k: d[k]
                        for k in (
                            "started_at",
                            "ended_at",
                            "start_volume_l",
                            "end_volume_l",
                            "start_tc_volume_l",
                            "end_tc_volume_l",
                            "start_height_mm",
                            "end_height_mm",
                            "start_water_mm",
                            "end_water_mm",
                            "start_temperature_c",
                            "end_temperature_c",
                            "start_density_kg_m3",
                            "end_density_kg_m3",
                        )
                    },
                }
            )
        res = self.c.query(
            """INSERT INTO fms.tank_deliveries
         (station_id, tank_no, product_code, started_at, ended_at, start_volume_l, end_volume_l, start_tc_volume_l,
          end_tc_volume_l, start_height_mm, end_height_mm, start_water_mm, end_water_mm, start_temperature_c,
          end_temperature_c, start_density_kg_m3, end_density_kg_m3)
       SELECT r.station_id, r.tank_no, r.product_code, r.started_at, r.ended_at, r.start_volume_l, r.end_volume_l,
              r.start_tc_volume_l, r.end_tc_volume_l, r.start_height_mm, r.end_height_mm, r.start_water_mm, r.end_water_mm,
              r.start_temperature_c, r.end_temperature_c, r.start_density_kg_m3, r.end_density_kg_m3
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, tank_no int, product_code text, started_at timestamptz, ended_at timestamptz,
              start_volume_l numeric, end_volume_l numeric, start_tc_volume_l numeric, end_tc_volume_l numeric,
              start_height_mm numeric, end_height_mm numeric, start_water_mm numeric, end_water_mm numeric,
              start_temperature_c numeric, end_temperature_c numeric, start_density_kg_m3 numeric, end_density_kg_m3 numeric)
       ON CONFLICT DO NOTHING
       RETURNING station_id, tank_no, started_at""",
            [dumps(rows)],
        )
        inserted = {key(r["station_id"], r["tank_no"], ms(r["started_at"])) for r in res}
        for i in uniq:
            is_new = key(i.station.id, i.rec["data"]["tank_no"], i.rec["data"]["started_at"]) in inserted
            self.outcome[i.key] = "inserted" if is_new else "duplicate"
            if is_new:
                self._add_rollup(i.station, i.rec["data"]["ended_at"])
        for dup in dups:
            self.outcome[dup.key] = "duplicate"

    # ---------------------------------------------------------------- alerts
    def _insert_alerts(self) -> None:
        if not self.alerts:
            return

        def key(st: str, at: str, dtype: str, dn: int | None, code: str) -> str:
            return f"{st}|{at}|{dtype}|{'' if dn is None else dn}|{code}"

        def akey(a: _PendingAlert) -> str:
            r = a.rec
            return key(a.station.id, ms(r["occurred_at"]), r["device_type"], r["device_no"], r["code"])

        uniq, dups = _dedupe(self.alerts, akey)
        rows = [
            {
                "station_id": a.station.id,
                "occurred_at": ms(a.rec["occurred_at"]),
                "device_type": a.rec["device_type"],
                "device_no": a.rec["device_no"],
                "code": a.rec["code"],
                "severity": a.rec["severity"],
                "message": a.rec["message"],
                "data": a.rec.get("data"),
            }
            for a in uniq
        ]
        # NOT EXISTS covers device_no IS NULL, which the UNIQUE constraint treats as distinct.
        res = self.c.query(
            """INSERT INTO fms.alerts (station_id, occurred_at, device_type, device_no, code, severity, message, data)
       SELECT r.station_id, r.occurred_at, r.device_type, r.device_no, r.code, r.severity, r.message, r.data
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, occurred_at timestamptz, device_type text, device_no int, code text,
              severity text, message text, data jsonb)
        WHERE NOT EXISTS (SELECT 1 FROM fms.alerts a
                           WHERE a.station_id = r.station_id AND a.occurred_at = r.occurred_at
                             AND a.device_type = r.device_type AND a.device_no IS NOT DISTINCT FROM r.device_no
                             AND a.code = r.code)
       ON CONFLICT DO NOTHING
       RETURNING id, station_id, occurred_at, device_type, device_no, code""",
            [dumps(rows)],
        )
        ids = {key(r["station_id"], ms(r["occurred_at"]), r["device_type"], r["device_no"], r["code"]): r["id"] for r in res}
        for a in uniq:
            aid = ids.get(akey(a))
            if a.key is not None:
                self.outcome[a.key] = "inserted" if aid is not None else "duplicate"
            if aid is None:
                continue
            self.raised.append(RaisedAlert(id=aid, code=a.rec["code"], severity=a.rec["severity"]))
            st = a.station
            alert = {
                "id": aid,
                "station_id": st.id,
                "station_code": st.code,
                "occurred_at": ms(a.rec["occurred_at"]),
                "device_type": a.rec["device_type"],
                "device_no": a.rec["device_no"],
                "code": a.rec["code"],
                "severity": a.rec["severity"],
                "message": a.rec["message"],
                "data": a.rec.get("data"),
            }
            base = {"station_id": st.id, "station_code": st.code, "province_id": st.province_id, "company_id": st.company_id}
            if a.rec["severity"] == "critical":
                self.jobs.append(
                    {"kind": "notify", "dedupe_key": f"notify:alert:{aid}", "payload": {**base, "alert_id": aid, "alert": alert}}
                )
                self.jobs.append(
                    {
                        "kind": "webhook",
                        "dedupe_key": f"webhook:critical_alert:{aid}",
                        "payload": {**base, "event": "critical_alert", "alert_id": aid, "data": alert},
                    }
                )
            if a.webhook_event:
                self.jobs.append(
                    {
                        "kind": "webhook",
                        "dedupe_key": f"webhook:{a.webhook_event}:{aid}",
                        "payload": {**base, "event": a.webhook_event, "alert_id": aid, "data": alert},
                    }
                )
        for dup in dups:
            if dup.key is not None:
                self.outcome[dup.key] = "duplicate"

    # ---------------------------------------------------------------- status / heartbeat
    def _statuses(self, items: list[PersistItem]) -> None:
        latest: dict[str, dict[str, Any]] = {}
        for i in items:
            s = i.rec["data"]
            cur = latest.get(s["pts_id"])
            if cur is None or cur["reported_at"] <= s["reported_at"]:
                latest[s["pts_id"]] = s
            self.outcome[i.key] = "inserted"
        touch = [p for p in dict.fromkeys(self.ctx.touch_controllers) if p not in latest]
        rows = [{"pts_id": s["pts_id"], "status": s["status"]} for s in latest.values()]
        rows += [{"pts_id": p, "status": None} for p in touch]
        rows.sort(key=lambda r: r["pts_id"])
        if not rows:
            return
        self.c.execute(
            """UPDATE fms.controllers c
          SET last_seen_at = now(), last_status = coalesce(r.status, c.last_status)
         FROM json_to_recordset($1::json) AS r(pts_id text, status jsonb)
        WHERE c.pts_id = r.pts_id""",
            [dumps(rows)],
        )

    def _heartbeats(self, items: list[PersistItem]) -> None:
        if not self.ctx.gateway_id:
            for i in items:
                self.outcome[i.key] = "ignored"
            return
        hb = items[-1].rec["data"] if items else None
        for i in items:
            self.outcome[i.key] = "inserted"
        # Any authenticated batch proves the gateway is alive; heartbeats also carry backlog/version.
        self.c.execute(
            """UPDATE fms.edge_gateways
          SET last_seen_at = now(),
              last_backlog = coalesce($2::int, last_backlog),
              version = coalesce($3::text, version)
        WHERE id = $1""",
            [self.ctx.gateway_id, hb["backlog"] if hb else None, hb["gateway_version"] if hb else None],
        )

    # ---------------------------------------------------------------- command acknowledgements
    def _command_acks(self, items: list[PersistItem]) -> None:
        """Apply gateway acks to fms.edge_commands.

        Status only moves forward (fms.edge_command_rank), so re-sent or out-of-order acks are harmless.
        Acks for unknown ids (or another station's commands) are accepted and ignored so the gateway
        does not retry them forever.
        """
        if not items:
            return
        station = items[0].station
        rows = [{"k": i.key, **i.rec["data"], "result": i.rec["data"].get("result")} for i in items]
        res = self.c.query(
            """WITH acks AS (
          SELECT DISTINCT ON (r.command_id) r.k, r.command_id, r.status, r.at, r.result
            FROM json_to_recordset($1::json) AS r(k int, command_id text, status text, at timestamptz, result jsonb)
           ORDER BY r.command_id, fms.edge_command_rank(r.status) DESC, r.at DESC)
       UPDATE fms.edge_commands e
          SET status = CASE WHEN fms.edge_command_rank(a.status) > fms.edge_command_rank(e.status) THEN a.status ELSE e.status END,
              received_at = coalesce(e.received_at, a.at),
              completed_at = CASE WHEN a.status IN ('applied','partial','failed') THEN coalesce(e.completed_at, a.at) ELSE e.completed_at END,
              result = CASE WHEN a.status = 'received' THEN e.result ELSE coalesce(a.result, e.result) END,
              updated_at = now()
         FROM acks a
        WHERE e.id = a.command_id AND e.station_id = $2
       RETURNING a.k, e.id, e.type, a.status""",
            [dumps(rows), station.id],
        )
        matched = {r["id"] for r in res}
        for i in items:
            self.outcome[i.key] = "inserted" if i.rec["data"]["command_id"] in matched else "ignored"
        # A command the station could not apply (e.g. price update rejected by the controller) needs a human.
        for r in res:
            if r["status"] not in ("failed", "partial"):
                continue
            ack = next(i for i in items if i.rec["data"]["command_id"] == r["id"]).rec["data"]
            self.alerts.append(
                _PendingAlert(
                    station=station,
                    rec={
                        "pts_id": None,
                        "occurred_at": ack["at"],
                        "device_type": "gateway",
                        "device_no": None,
                        "code": "CommandFailed" if r["status"] == "failed" else "CommandPartiallyApplied",
                        "severity": "warning",
                        "message": f"Command {r['type']} ({r['id']}) {r['status']} at station {station.code}",
                        "data": {"command_id": r["id"], "type": r["type"], "result": ack.get("result")},
                    },
                )
            )

    # ---------------------------------------------------------------- fiscal receipts
    def _fiscal_receipts(self, items: list[PersistItem]) -> None:
        if not items:
            return

        def key(st: str, pump: int, txno: int, at: str) -> str:
            return f"{st}|{pump}|{txno}|{at}"

        def ikey(i: PersistItem) -> str:
            d = i.rec["data"]
            return key(i.station.id, d["pump_no"], d["pts_transaction_no"], d["tx_ended_at"])

        # Last one wins within a batch (later outbox entries carry the more advanced status).
        last_by_key: dict[str, PersistItem] = {}
        for i in items:
            last_by_key[ikey(i)] = i
        rows = [{"station_id": i.station.id, **i.rec["data"]} for i in last_by_key.values()]
        res = self.c.query(
            """INSERT INTO fms.fiscal_receipts AS f
         (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, fiscalised_by, zra_rcpt_no,
          zra_tot_rcpt_no, zra_internal_data, zra_signature, zra_sdc_id, zra_mrc_no, zra_qr_url, zra_signed_at,
          printed_at, attempts, last_error)
       SELECT r.station_id, r.pump_no, r.pts_transaction_no, r.tx_ended_at, r.invoice_no, r.status, 'edge', r.zra_rcpt_no,
              r.zra_tot_rcpt_no, r.zra_internal_data, r.zra_signature, r.zra_sdc_id, r.zra_mrc_no, r.zra_qr_url,
              r.zra_signed_at, r.printed_at, r.attempts, r.last_error
         FROM json_to_recordset($1::json) AS r(
              station_id uuid, pump_no int, pts_transaction_no int, tx_ended_at timestamptz, invoice_no text, status text,
              zra_rcpt_no text, zra_tot_rcpt_no text, zra_internal_data text, zra_signature text, zra_sdc_id text,
              zra_mrc_no text, zra_qr_url text, zra_signed_at timestamptz, printed_at timestamptz, attempts int,
              last_error text)
        ORDER BY r.station_id, r.pump_no, r.pts_transaction_no, r.tx_ended_at
       ON CONFLICT (station_id, pump_no, pts_transaction_no, tx_ended_at) DO UPDATE SET
              invoice_no = EXCLUDED.invoice_no, status = EXCLUDED.status,
              zra_rcpt_no = coalesce(EXCLUDED.zra_rcpt_no, f.zra_rcpt_no),
              zra_tot_rcpt_no = coalesce(EXCLUDED.zra_tot_rcpt_no, f.zra_tot_rcpt_no),
              zra_internal_data = coalesce(EXCLUDED.zra_internal_data, f.zra_internal_data),
              zra_signature = coalesce(EXCLUDED.zra_signature, f.zra_signature),
              zra_sdc_id = coalesce(EXCLUDED.zra_sdc_id, f.zra_sdc_id),
              zra_mrc_no = coalesce(EXCLUDED.zra_mrc_no, f.zra_mrc_no),
              zra_qr_url = coalesce(EXCLUDED.zra_qr_url, f.zra_qr_url),
              zra_signed_at = coalesce(EXCLUDED.zra_signed_at, f.zra_signed_at),
              printed_at = coalesce(EXCLUDED.printed_at, f.printed_at),
              attempts = greatest(EXCLUDED.attempts, f.attempts),
              last_error = EXCLUDED.last_error
        -- never regress a signed/printed receipt because an older outbox entry was resent
        WHERE NOT (f.status IN ('signed','printed') AND EXCLUDED.status IN ('pending','failed'))
          AND NOT (f.status = 'printed' AND EXCLUDED.status = 'signed')
       RETURNING station_id, pump_no, pts_transaction_no, tx_ended_at, status, (xmax = 0) AS inserted""",
            [dumps(rows)],
        )
        changed = {key(r["station_id"], r["pump_no"], r["pts_transaction_no"], ms(r["tx_ended_at"])): r for r in res}
        for i in items:
            r = changed.get(ikey(i))
            self.outcome[i.key] = "inserted" if r and r["inserted"] else "duplicate"
        upd = [
            {
                "station_id": r["station_id"],
                "pump_no": r["pump_no"],
                "pts_transaction_no": r["pts_transaction_no"],
                "ended_at": ms(r["tx_ended_at"]),
                "status": r["status"],
            }
            for r in res
            if r["status"] != "pending"
        ]
        if not upd:
            return
        self.c.execute(
            """UPDATE fms.pump_transactions t
          SET fiscal_status = CASE WHEN r.status IN ('signed','printed') THEN 'signed' ELSE 'failed' END
         FROM json_to_recordset($1::json) AS r(station_id uuid, pump_no int, pts_transaction_no int, ended_at timestamptz, status text)
        WHERE t.station_id = r.station_id AND t.pump_no = r.pump_no AND t.pts_transaction_no = r.pts_transaction_no
          AND t.ended_at = r.ended_at AND t.fiscal_status NOT IN ('signed','exempt')""",
            [dumps(upd)],
        )

    # ---------------------------------------------------------------- jobs
    def _insert_jobs(self) -> None:
        if not self.jobs:
            return
        rows = sorted(self.jobs, key=lambda j: j["dedupe_key"])
        self.c.execute(
            """INSERT INTO fms.jobs (kind, payload, dedupe_key)
       SELECT r.kind, r.payload, r.dedupe_key
         FROM json_to_recordset($1::json) AS r(kind text, payload jsonb, dedupe_key text)
       ON CONFLICT (dedupe_key) DO NOTHING""",
            [dumps(rows)],
        )

    def _enqueue_rollups(self) -> None:
        """jobs.dedupe_key is unique forever, so a finished rollup is re-armed (debounced) instead of inserted again.

        A rollup currently 'running' is left alone (see README: lost-update window).
        """
        if not self.rollups:
            return
        rows = [{"dedupe_key": k, "payload": p} for k, p in sorted(self.rollups.items())]
        self.c.execute(
            """INSERT INTO fms.jobs AS j (kind, payload, dedupe_key, run_at)
       SELECT 'rollup', r.payload, r.dedupe_key, now() + make_interval(secs => $2::int)
         FROM json_to_recordset($1::json) AS r(dedupe_key text, payload jsonb)
       ON CONFLICT (dedupe_key) DO UPDATE
          SET status = 'queued', run_at = now() + make_interval(secs => $2::int), attempts = 0,
              locked_by = NULL, locked_at = NULL, last_error = NULL
        WHERE j.status IN ('done','dead')""",
            [dumps(rows), self.ctx.rollup_delay_s],
        )


def take_edge_commands(c: Conn, station_id: str, gateway_code: str, limit: int, redeliver_after_s: int) -> list[dict[str, Any]]:
    """Pick commands to deliver to a station's gateway from fms.edge_commands.

    New ones, plus 'delivered' ones whose 'received' ack has not arrived within redeliver_after_s
    (lost response, gateway crash before storing). Runs in the batch transaction, so a rolled-back
    batch does not count as a delivery.
    """
    if limit <= 0:
        return []
    res = c.query(
        """WITH picked AS (
        SELECT id FROM fms.edge_commands
         WHERE station_id = $1
           AND not_before <= now() AND expires_at > now()
           AND (status = 'queued'
                OR (status = 'delivered' AND last_delivered_at < now() - make_interval(secs => $4::int)))
         ORDER BY created_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
     UPDATE fms.edge_commands e
        SET status = 'delivered', delivery_count = e.delivery_count + 1,
            first_delivered_at = coalesce(e.first_delivered_at, now()), last_delivered_at = now(),
            delivered_via = $3, updated_at = now()
       FROM picked WHERE e.id = picked.id
     RETURNING e.id, e.command, e.created_at""",
        [station_id, limit, gateway_code, redeliver_after_s],
    )
    res.sort(key=lambda r: (r["created_at"].replace(microsecond=(r["created_at"].microsecond // 1000) * 1000), r["id"]))
    out = []
    for r in res:
        cmd = dict(r["command"]) if isinstance(r["command"], dict) else {}
        cmd["id"] = r["id"]
        out.append(cmd)
    return out
