"""fms.audit_log writer (port of core-api src/lib/audit.ts)."""

from __future__ import annotations

import json
from typing import Any

from django.http import HttpRequest

from ..common.db import Conn
from .auth import client_ip


def audit(
    db: Conn,
    request: HttpRequest | None,
    action: str,
    *,
    entity: str | None = None,
    entity_id: str | int | None = None,
    details: dict[str, Any] | None = None,
    actor_type: str | None = None,
    actor_id: str | None = None,
) -> None:
    """Pass the transaction Conn for writes so the audit row commits atomically with them."""
    pr = getattr(request, "principal", None) if request is not None else None
    a_type = actor_type or (pr.kind if pr else "anonymous")
    a_id = actor_id or (pr.id if pr else None)
    d = dict(details or {})
    if request is not None:
        d.update({"ip": client_ip(request), "request_id": getattr(request, "id", None)})
    db.execute(
        "INSERT INTO fms.audit_log (actor_type, actor_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6)",
        [a_type, a_id, action, entity, str(entity_id) if entity_id is not None else None, json.dumps(d, default=str)],
    )
