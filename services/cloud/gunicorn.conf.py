"""gunicorn settings for the core and ingest roles.

gthread workers: each request holds a thread, which suits the blocking
database calls and the Server-Sent Events stream (/api/v1/stream holds one
thread per open stream, so GUNICORN_THREADS bounds concurrent streams).
"""

import os
import shutil

bind = f"{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '8080')}"
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
worker_class = "gthread"
threads = int(os.environ.get("GUNICORN_THREADS", "32"))
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "60"))
graceful_timeout = 15
keepalive = 75  # longer than the nginx upstream keepalive
accesslog = None
errorlog = "-"
forwarded_allow_ips = "*"
max_requests = int(os.environ.get("GUNICORN_MAX_REQUESTS", "0"))

# Aggregate Prometheus metrics across worker processes.
_prom = os.environ.setdefault("PROMETHEUS_MULTIPROC_DIR", "/tmp/prometheus")


def on_starting(server):
    shutil.rmtree(_prom, ignore_errors=True)
    os.makedirs(_prom, exist_ok=True)


def child_exit(server, worker):
    from prometheus_client import multiprocess

    multiprocess.mark_process_dead(worker.pid)
