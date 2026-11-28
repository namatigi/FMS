"""Leader-elected scheduler (services/fiscal-worker/src/scheduler.ts).

Every replica runs it; only the one holding the session-level advisory lock
(pg_try_advisory_lock on a dedicated connection) enqueues work. All enqueues use dedupe
keys, so a leader change mid-cycle is safe.

Tasks:
  hourly        SELECT fms.ensure_partitions(1,3); prune old done jobs
  daily 00:15   rollup for every station for yesterday (Africa/Lusaka) + erb_export per province + national
  every 5 min   fiscal sweep (direct-mode pending > 2 min, edge-mode pending > FISCAL_CLOUD_FALLBACK_MINUTES)
                + GatewayOffline alerts for edge gateways not seen for 15 min
                + expire unacknowledged edge commands (CommandExpired alerts)
"""

from __future__ import annotations

import datetime as dt
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg
from django.db import close_old_connections, connections

from fms_cloud.common.db import Conn, primary
from fms_cloud.common.jsonutil import iso

from .config import WorkerConfig
from .core import Log, add_days, error_message, zoned_now
from .metrics import Metrics
from .queue import JobQueue


def ISO_MS(col: str) -> str:
    """ended_at rendered exactly like JS Date.toISOString() (UTC, millisecond precision)."""
    return f"""to_char({col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"""


@dataclass
class SchedulerDeps:
    queue: JobQueue
    config: WorkerConfig
    log: Log
    metrics: Metrics
    db: Conn = primary


class Scheduler:
    def __init__(self, deps: SchedulerDeps) -> None:
        self.deps = deps
        self._lock_conn: psycopg.Connection | None = None
        self._leader = False
        self._last: dict[str, float] = {}
        self._last_daily_date: str | None = None
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None
        self._mutex = threading.RLock()  # one tick at a time; stop() waits for a running tick

    @property
    def is_leader(self) -> bool:
        return self._leader

    # ---------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self._stopped = threading.Event()

        def loop() -> None:
            try:
                while not self._stopped.is_set():
                    self.tick()
                    self._stopped.wait(self.deps.config.scheduler.tick_ms / 1000)
            finally:
                connections.close_all()

        self._thread = threading.Thread(target=loop, name="fms-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join()
        self._thread = None
        self._release_leadership()

    def tick(self, now: dt.datetime | None = None) -> None:
        """One scheduler iteration: (re)acquire leadership, run due tasks."""
        now = now or dt.datetime.now(dt.UTC)
        with self._mutex:
            try:
                close_old_connections()
                if not self._ensure_leadership():
                    return
                s = self.deps.config.scheduler
                self._every("partitions", s.partitions_every_ms, now, self.ensure_partitions)

                def sweep() -> None:
                    self.sweep_fiscal()
                    self.check_gateways()
                    self.expire_commands()

                self._every("sweep", s.fiscal_sweep_every_ms, now, sweep)
                local = zoned_now(s.time_zone, now)
                due = local["hour"] > s.daily_at.hour or (local["hour"] == s.daily_at.hour and local["minute"] >= s.daily_at.minute)
                if due and self._last_daily_date != local["date"]:
                    self._run("daily", lambda: self.schedule_daily(add_days(local["date"], -1)))
                    self._last_daily_date = local["date"]
            except Exception as err:  # noqa: BLE001
                self.deps.log.error("scheduler tick failed", err=error_message(err))

    def _every(self, name: str, interval_ms: float, now: dt.datetime, fn: Callable[[], Any]) -> None:
        t = now.timestamp() * 1000
        if t - self._last.get(name, 0) < interval_ms:
            return
        self._run(name, fn)
        self._last[name] = t

    def _run(self, name: str, fn: Callable[[], Any]) -> None:
        try:
            r = fn()
            self.deps.metrics.scheduler_runs.labels(task=name, outcome="ok").inc()
            self.deps.log.info("scheduler task ran", task=name, result=r)
        except Exception as err:  # noqa: BLE001
            self.deps.metrics.scheduler_runs.labels(task=name, outcome="error").inc()
            self.deps.log.error("scheduler task failed", task=name, err=error_message(err))

    # -------------------------------------------------------------- leadership

    def _ensure_leadership(self) -> bool:
        try:
            if self._lock_conn is None:
                self._lock_conn = psycopg.connect(
                    self.deps.config.database_url, autocommit=True, application_name="fms-fiscal-worker-scheduler"
                )
            if self._leader:
                self._lock_conn.execute("SELECT 1")  # connection (and so the session lock) still alive
                return True
            row = self._lock_conn.execute("SELECT pg_try_advisory_lock(%s::bigint) AS ok", [self.deps.config.scheduler.lock_key]).fetchone()
            if row and row[0]:
                self._leader = True
                self._last = {}
                self.deps.metrics.scheduler_leader.set(1)
                self.deps.log.info("acquired scheduler leadership")
            return self._leader
        except Exception as err:  # noqa: BLE001
            self.deps.log.warning("scheduler leadership check failed", err=error_message(err))
            self._drop_leadership()
            return False

    def _drop_leadership(self) -> None:
        if self._leader:
            self.deps.log.warning("lost scheduler leadership")
        self._leader = False
        self.deps.metrics.scheduler_leader.set(0)
        c, self._lock_conn = self._lock_conn, None
        if c is not None:
            try:
                c.close()
            except Exception:  # noqa: BLE001, S110
                pass

    def _release_leadership(self) -> None:
        with self._mutex:
            c = self._lock_conn
            if c is not None and self._leader:
                try:
                    c.execute("SELECT pg_advisory_unlock(%s::bigint)", [self.deps.config.scheduler.lock_key])
                except Exception:  # noqa: BLE001, S110
                    pass
            self._leader = False
            self.deps.metrics.scheduler_leader.set(0)
            self._lock_conn = None
            if c is not None:
                try:
                    c.close()
                except Exception:  # noqa: BLE001, S110
                    pass

    # -------------------------------------------------------------------- tasks

    def ensure_partitions(self) -> dict[str, int]:
        db = self.deps.db
        db.query("SELECT fms.ensure_partitions(1, 3)")
        # Keep the jobs table small; dead jobs are kept for investigation.
        n = db.execute("DELETE FROM fms.jobs WHERE status = 'done' AND created_at < now() - interval '14 days'")
        return {"pruned_jobs": n or 0}

    def schedule_daily(self, business_date: str) -> dict[str, int]:
        """Enqueue the end-of-day rollups and ERB exports for a business date (idempotent)."""
        db = self.deps.db
        rollups = db.execute(
            """INSERT INTO fms.jobs (kind, payload, dedupe_key)
       SELECT 'rollup', jsonb_build_object('station_id', s.id, 'business_date', $1::text), 'rollup-final:' || s.id || ':' || $1::text
         FROM fms.stations s WHERE s.status <> 'closed'
       ON CONFLICT (dedupe_key) DO NOTHING""",
            [business_date],
        )
        delay_min = self.deps.config.scheduler.erb_export_delay_minutes
        exports = db.execute(
            """INSERT INTO fms.jobs (kind, payload, dedupe_key, run_at)
       SELECT 'erb_export', jsonb_build_object('date', $1::text, 'province_id', p.id), 'erb_export:' || $1::text || ':' || p.code,
              now() + make_interval(mins => $2)
         FROM fms.provinces p
       UNION ALL
       SELECT 'erb_export', jsonb_build_object('date', $1::text, 'province_id', NULL), 'erb_export:' || $1::text || ':NATIONAL',
              now() + make_interval(mins => $2)
       ON CONFLICT (dedupe_key) DO NOTHING""",
            [business_date, delay_min],
        )
        return {"rollups": rollups or 0, "exports": exports or 0}

    def sweep_fiscal(self) -> dict[str, int]:
        """Enqueue cloud fiscalisation for transactions left pending."""
        s = self.deps.config.scheduler
        n = self.deps.db.execute(
            f"""INSERT INTO fms.jobs (kind, payload, dedupe_key)
       SELECT 'fiscalise',
              jsonb_build_object('station_id', pt.station_id, 'pump_no', pt.pump_no,
                                 'pts_transaction_no', pt.pts_transaction_no, 'ended_at', {ISO_MS("pt.ended_at")}),
              'fiscalise:' || pt.station_id || ':' || pt.pump_no || ':' || pt.pts_transaction_no || ':' || {ISO_MS("pt.ended_at")}
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
       ON CONFLICT (dedupe_key) DO NOTHING""",
            [s.fiscal_direct_delay_minutes, s.fiscal_cloud_fallback_minutes, s.fiscal_sweep_lookback_days, s.fiscal_sweep_limit],
        )
        return {"enqueued": n or 0}

    def expire_commands(self) -> dict[str, int]:
        """Expire edge commands the station never acknowledged ('queued'/'delivered' past expires_at),
        e.g. a price change for a gateway that stayed offline, and raise a CommandExpired alert so the
        owner knows the pumps may still show the old price."""
        n = self.deps.db.execute(
            """WITH expired AS (
         UPDATE fms.edge_commands SET status = 'expired', updated_at = now()
          WHERE status IN ('queued','delivered') AND expires_at <= now()
          RETURNING id, station_id, type, delivery_count, expires_at)
       INSERT INTO fms.alerts (station_id, occurred_at, device_type, device_no, code, severity, message, data)
       SELECT station_id, expires_at, 'gateway', NULL, 'CommandExpired', 'warning',
              format('Command %s (%s) was not acknowledged by the station before it expired', type, id),
              jsonb_build_object('command_id', id, 'type', type, 'delivery_count', delivery_count)
         FROM expired
       ON CONFLICT DO NOTHING"""
        )
        return {"expired": n or 0}

    def check_gateways(self) -> dict[str, int]:
        """Raise GatewayOffline alerts (once per outage) and fan out critical ones."""
        rows = self.deps.db.query(
            """WITH stale AS (
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
                 al.occurred_at, al.severity, al.message, al.data""",
            [self.deps.config.scheduler.gateway_offline_minutes],
        )
        q = self.deps.queue
        for a in rows:
            alert = {
                "id": a["id"],
                "station_id": a["station_id"],
                "occurred_at": iso(a["occurred_at"]),
                "device_type": "gateway",
                "code": "GatewayOffline",
                "severity": a["severity"],
                "message": a["message"],
                "data": a["data"],
            }
            self.deps.log.warning("edge gateway offline", station_id=a["station_id"], gateway=(a["data"] or {}).get("gateway_code"))
            if a["severity"] != "critical":
                continue
            q.enqueue(kind="notify", payload={"station_id": a["station_id"], "alert": alert}, dedupe_key=f"notify:alert:{a['id']}")
            q.enqueue(
                kind="webhook",
                payload={
                    "event": "critical_alert",
                    "data": {"station_id": a["station_id"], "province_id": a["province_id"], "alert": alert},
                },
                dedupe_key=f"webhook:critical_alert:{a['id']}",
            )
        return {"alerts": len(rows)}
