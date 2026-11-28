"""Fixtures for the worker integration tests: real PostgreSQL (tests/conftest.py builds the
database with the fms schema + demo seed) and the in-process mock VSDC."""

from __future__ import annotations

import datetime as dt
import os
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

CEN = "aaaaaaaa-0000-0000-0000-000000000002"  # CEN-0001, direct mode, branch 001
LUS = "aaaaaaaa-0000-0000-0000-000000000001"  # LUS-0001, edge mode
CEN_PTS = "003B00265030500420303532"
LUS_PTS = "003B00265030500420303531"


@pytest.fixture(scope="session")
def tmp_root():
    d = tempfile.mkdtemp(prefix="fms-worker-test-")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture(scope="session")
def vsdc():
    from fms_cloud.fiscal.zra.mock import start_mock_vsdc

    m = start_mock_vsdc()
    yield m
    m.close()


@pytest.fixture(scope="session")
def cfg(vsdc, tmp_root):
    from fms_cloud.fiscal.config import load_config

    return load_config(
        {
            "DATABASE_URL": os.environ["DATABASE_URL"],
            "ZRA_VSDC_URL": vsdc.url,
            "ZRA_DEVICE_SERIAL": "DVC-CLOUD-TEST",
            "ZRA_TIMEOUT_MS": "5000",
            "LOG_LEVEL": "silent",
            "WORKER_ID": "test-worker-1",
            "EXPORT_DIR": os.path.join(tmp_root, "exports"),
            "RECEIPT_ARCHIVE_DIR": os.path.join(tmp_root, "receipts"),
            "JOB_BACKOFF_BASE_MS": "60000",
        }
    )


@pytest.fixture(scope="session")
def app(cfg):
    from fms_cloud.fiscal.app import create_app
    from fms_cloud.fiscal.core import Log

    a = create_app(cfg, Log("fms.fiscal_worker.test"))
    yield a
    a.deps.http.close()


@pytest.fixture
def q(db):
    def _q(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        return db.query(sql, params or [])

    return _q


@pytest.fixture(autouse=True)
def _clean(request):
    """beforeEach of integration.test.ts (only for tests that use the app)."""
    if "app" not in request.fixturenames:
        yield
        return
    from fms_cloud.common.db import primary as db

    request.getfixturevalue("vsdc").reset()
    db.execute("DELETE FROM fms.jobs")
    db.execute("DELETE FROM fms.fiscal_receipts")
    db.execute("DELETE FROM fms.pump_transactions")
    db.execute("DELETE FROM fms.daily_station_product")
    db.execute("DELETE FROM fms.alerts WHERE code = 'GatewayOffline'")
    db.execute("DELETE FROM fms.api_clients WHERE key_prefix LIKE 'test%'")
    yield


_seq = [(int(time.time() * 1000) % 100000) * 10]
_seq_lock = threading.Lock()


@pytest.fixture
def insert_tx(db):
    from fms_cloud.common.jsonutil import iso

    def _insert(
        station: str = CEN,
        pts: str = CEN_PTS,
        ended_at: dt.datetime | None = None,
        received_ago_min: int = 0,
        volume: float = 20.5,
        amount: float = 652.93,
    ) -> dict[str, Any]:
        with _seq_lock:
            _seq[0] += 1
            txno = _seq[0]
        if ended_at is None:
            now_s = int(time.time())
            ended_at = dt.datetime.fromtimestamp(now_s - 5 * 60, dt.UTC)
        db.execute(
            """INSERT INTO fms.pump_transactions (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, pts_grade_id, product_code, tank_no,
                                        ended_at, volume_l, price, amount, source, received_at)
     VALUES ($1, $2, $3, 1, 1, 1, 'PETROL', 1, $4, $5, 31.85, $6, 'pts_direct', now() - make_interval(mins => $7))""",
            [station, pts, txno, ended_at, volume, amount, received_ago_min],
        )
        return {
            "txno": txno,
            "ended_at": ended_at,
            "payload": {"station_id": station, "pump_no": 1, "pts_transaction_no": txno, "ended_at": iso(ended_at)},
        }

    return _insert


class _HookServer:
    """Webhook receiver: records requests, answers 500 while fail_next > 0, else 204."""

    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []
        self.fail_next = 0
        hook = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a: Any) -> None:
                pass

            def do_POST(self) -> None:
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n).decode("utf-8")
                hook.received.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                if hook.fail_next > 0:
                    hook.fail_next -= 1
                    self.send_response(500)
                    self.send_header("content-length", "4")
                    self.end_headers()
                    self.wfile.write(b"boom")
                else:
                    self.send_response(204)
                    self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/hook"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture(scope="session")
def _hook_server():
    s = _HookServer()
    yield s
    s.close()


@pytest.fixture
def hook(_hook_server):
    _hook_server.received.clear()
    _hook_server.fail_next = 0
    return _hook_server
