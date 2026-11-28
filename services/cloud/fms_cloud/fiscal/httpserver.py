"""/healthz (liveness), /readyz (DB reachable), /metrics (Prometheus) on METRICS_PORT
(services/fiscal-worker/src/http.ts), served by a small threaded http.server."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from django.db import connections
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from fms_cloud.common.db import ping

from .core import Log
from .metrics import Metrics


@dataclass
class HttpDeps:
    metrics: Metrics
    log: Log
    # Liveness probe: False when the worker loop is stuck / stopped.
    is_alive: Callable[[], bool]
    info: Callable[[], dict[str, Any]]
    db_alias: str = "default"


def _readyz_check(alias: str, timeout_s: float = 3.0) -> None:
    box: dict[str, BaseException] = {}

    def run() -> None:
        try:
            ping(alias)
        except BaseException as e:  # noqa: BLE001
            box["err"] = e
        finally:
            connections.close_all()

    t = threading.Thread(target=run, name="fms-readyz", daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        raise TimeoutError("db timeout")
    if "err" in box:
        raise box["err"]


class WorkerHttpServer(ThreadingHTTPServer):
    daemon_threads = True

    def close(self) -> None:
        self.shutdown()
        self.server_close()

    @property
    def port(self) -> int:
        return self.server_address[1]


def start_http_server(port: int, deps: HttpDeps, host: str = "0.0.0.0") -> WorkerHttpServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def _json(self, status: int, body: Any) -> None:
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            path = self.path.split("?")[0]
            try:
                if path == "/healthz":
                    alive = deps.is_alive()
                    return self._json(200 if alive else 503, {"status": "ok" if alive else "unhealthy", **deps.info()})
                if path == "/readyz":
                    try:
                        _readyz_check(deps.db_alias)
                        return self._json(200, {"status": "ready"})
                    except Exception as err:  # noqa: BLE001
                        return self._json(503, {"status": "not_ready", "error": str(err)})
                if path == "/metrics":
                    body = generate_latest(deps.metrics.registry)
                    self.send_response(200)
                    self.send_header("content-type", CONTENT_TYPE_LATEST)
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self._json(404, {"error": {"code": "not_found", "message": "not found"}})
            except Exception as err:  # noqa: BLE001
                deps.log.error("http handler error", err=str(err))
                try:
                    self._json(500, {"error": {"code": "internal", "message": "internal error"}})
                except Exception:  # noqa: BLE001, S110
                    pass
            finally:
                connections.close_all()  # one thread per request: don't leak its DB connection

        do_POST = do_PUT = do_DELETE = do_HEAD = do_GET

    server = WorkerHttpServer((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="fms-worker-http", daemon=True).start()
    return server
