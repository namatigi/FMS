"""core-api specific Prometheus metrics (port of services/core-api/src/lib/metrics.ts).

The http duration histogram is shared and lives in fms_cloud.common.metrics.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge

LOGINS = Counter("fms_core_logins_total", "Login attempts by outcome", ["outcome"])

# livesum: under PROMETHEUS_MULTIPROC_DIR the gauge is the sum over live worker processes.
SSE_CLIENTS = Gauge("fms_core_sse_clients", "Open Server-Sent Events streams", multiprocess_mode="livesum")

PARTNER_REQUESTS = Counter("fms_core_partner_requests_total", "Partner API requests by client prefix", ["client"])
