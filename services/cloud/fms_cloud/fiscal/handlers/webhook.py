"""`webhook`: signed outbound webhooks (DESIGN section 8, CONTRACTS "Partner API").

payload: {event, data, subscription_id?, delivery_id?}
 - without subscription_id: fan-out. One child job per matching active subscription is
   enqueued (dedupe "webhook:<job id>:<subscription id>"), so each endpoint retries independently.
 - with subscription_id: deliver once; non-2xx / network errors -> retry with backoff.

Scoping: when the event data identifies a province (data.province_id, or data.station_id ->
stations.province_id) or company, subscriptions of province/company-scoped API clients only
receive matching events. A `province_id: null` (national data) is NOT sent to provincial clients.

Request: POST <url>, JSON body {id, event, created_at, data},
  headers X-FMS-Signature: t=<unix>,v1=<hmac>, X-FMS-Event, X-FMS-Delivery.
"""

from __future__ import annotations

from typing import Any

from fms_cloud.common.crypto import sign_webhook
from fms_cloud.common.jsonutil import iso

from ..core import JobError, error_message, req
from ..jscompat import js_dumps, js_number
from .base import HandlerContext, JobHandler


class _Undefined:
    def __repr__(self) -> str:
        return "undefined"


UNDEFINED: Any = _Undefined()


def resolve_scope(ctx: HandlerContext, data: dict[str, Any]) -> dict[str, Any]:
    if "province_id" in data:
        province = None if data["province_id"] is None else js_number(data["province_id"])
    else:
        province = UNDEFINED
    company = data["company_id"] if isinstance(data.get("company_id"), str) else UNDEFINED
    if (province is UNDEFINED or company is UNDEFINED) and isinstance(data.get("station_id"), str):
        row = ctx.db.one("SELECT province_id, company_id FROM fms.stations WHERE id = $1::uuid", [data["station_id"]])
        if row:
            if province is None or province is UNDEFINED:  # ??=
                province = row["province_id"]
            if company is None or company is UNDEFINED:
                company = row["company_id"]
    return {"province": province, "company": company}


def subscription_in_scope(sub: dict[str, Any], scope: dict[str, Any]) -> bool:
    """scope values: a value, None (null) or UNDEFINED (not given)."""
    province = scope.get("province", UNDEFINED)
    company = scope.get("company", UNDEFINED)
    if sub["province_id"] is not None and province is not UNDEFINED and province != sub["province_id"]:
        return False
    return not (sub["company_id"] is not None and company is not UNDEFINED and company != sub["company_id"])


def fan_out(ctx: HandlerContext, event: str, data: Any) -> None:
    rows = ctx.db.query(
        """SELECT ws.id, ws.url, ws.secret, ac.province_id, ac.company_id
       FROM fms.webhook_subscriptions ws
       JOIN fms.api_clients ac ON ac.id = ws.api_client_id
      WHERE ws.is_active AND ac.is_active AND $1 = ANY(ws.events)""",
        [event],
    )
    scope = resolve_scope(ctx, data if isinstance(data, dict) else {})
    targets = [s for s in rows if subscription_in_scope(s, scope)]
    queued = 0
    for s in targets:
        delivery_id = f"{ctx.job.id}:{s['id']}"
        jid = ctx.queue.enqueue(
            kind="webhook",
            payload={"event": event, "data": data, "subscription_id": s["id"], "delivery_id": delivery_id},
            dedupe_key=f"webhook:{delivery_id}",
            max_attempts=ctx.config.webhook.max_attempts,
        )
        if jid:
            queued += 1
    ctx.log.info("webhook fan-out", event=event, subscriptions=len(rows), in_scope=len(targets), queued=queued)


def deliver(ctx: HandlerContext, event: str, data: Any, subscription_id: str, delivery_id: str) -> None:
    sub = ctx.db.one(
        """SELECT ws.id, ws.url, ws.secret, ac.province_id, ac.company_id
       FROM fms.webhook_subscriptions ws JOIN fms.api_clients ac ON ac.id = ws.api_client_id
      WHERE ws.id = $1::uuid AND ws.is_active AND ac.is_active""",
        [subscription_id],
    )
    if not sub:
        ctx.log.info("webhook subscription inactive or deleted, dropping delivery", subscription_id=subscription_id)
        return
    body = js_dumps({"id": delivery_id, "event": event, "created_at": iso(ctx.job.created_at), "data": data})
    try:
        res = ctx.http.post(
            sub["url"],
            headers={
                "content-type": "application/json",
                "user-agent": ctx.config.webhook.user_agent,
                "x-fms-event": event,
                "x-fms-delivery": delivery_id,
                "x-fms-signature": sign_webhook(sub["secret"], body),
            },
            content=body.encode("utf-8"),
            timeout=ctx.config.webhook.timeout_ms / 1000,
            follow_redirects=False,
        )
    except Exception as err:
        ctx.metrics.webhook_deliveries.labels(event=event, outcome="error").inc()
        raise JobError(f"webhook POST {sub['url']} failed: {error_message(err)}", True, "WEBHOOK_NETWORK") from err
    if res.status_code < 200 or res.status_code >= 300:
        ctx.metrics.webhook_deliveries.labels(event=event, outcome="non_2xx").inc()
        raise JobError(f"webhook POST {sub['url']} returned HTTP {res.status_code}", True, "WEBHOOK_HTTP")
    ctx.metrics.webhook_deliveries.labels(event=event, outcome="delivered").inc()
    ctx.log.info("webhook delivered", event=event, subscription_id=sub["id"], status=res.status_code, delivery_id=delivery_id)


def handle(ctx: HandlerContext) -> None:
    p = ctx.job.payload if isinstance(ctx.job.payload, dict) else {}
    event = req.str(p, "event")
    data = p.get("data")
    if data is None:
        data = {}
    sub_id = p.get("subscription_id")
    if isinstance(sub_id, str) and sub_id:
        delivery_id = p["delivery_id"] if isinstance(p.get("delivery_id"), str) else f"{ctx.job.id}:{sub_id}"
        return deliver(ctx, event, data, req.uuid(p, "subscription_id"), delivery_id)
    return fan_out(ctx, event, data)


def on_dead(ctx: HandlerContext, error: str) -> None:
    p = ctx.job.payload if isinstance(ctx.job.payload, dict) else {}
    ctx.log.error("webhook delivery abandoned", event=p.get("event"), subscription_id=p.get("subscription_id"), error=error)


webhook_handler = JobHandler(kind="webhook", handle=handle, on_dead=on_dead)
