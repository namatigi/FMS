"""`notify`: alert notifications. payload: {station_id, alert}"""

from __future__ import annotations

from ..core import JobError, error_message, permanent, req
from ..jscompat import js_str, js_truthy
from ..notifiers import Notification
from .base import HandlerContext, JobHandler


def handle(ctx: HandlerContext) -> None:
    payload = ctx.job.payload if isinstance(ctx.job.payload, dict) else {}
    station_id = req.uuid(payload, "station_id")
    alert = payload.get("alert")
    if alert is None:
        alert = {}
    st = ctx.db.one(
        """SELECT s.id, s.code, s.name, s.province_id, s.company_id, c.contact_email, c.contact_phone
         FROM fms.stations s JOIN fms.companies c ON c.id = s.company_id WHERE s.id = $1::uuid""",
        [station_id],
    )
    if not st:
        raise permanent(f"station {station_id} not found", "STATION_NOT_FOUND")

    # Owners of the company + managers with access to the station.
    users = ctx.db.query(
        """SELECT u.email, u.phone FROM fms.users u
        WHERE u.is_active AND (
              (u.role = 'owner' AND u.company_id = $2::uuid)
           OR (u.role = 'manager' AND EXISTS (SELECT 1 FROM fms.user_station_access a WHERE a.user_id = u.id AND a.station_id = $1::uuid)))""",
        [st["id"], st["company_id"]],
    )
    emails: dict[str, None] = {}
    phones: dict[str, None] = {}
    if st["contact_email"]:
        emails[st["contact_email"]] = None
    if st["contact_phone"]:
        phones[st["contact_phone"]] = None
    for u in users:
        emails[u["email"]] = None
        if u["phone"]:
            phones[u["phone"]] = None

    a = alert if isinstance(alert, dict) else {}
    severity = js_str(a.get("severity") if a.get("severity") is not None else "warning")
    code = js_str(a.get("code") if a.get("code") is not None else "Alert")
    parts = [a.get("message"), f"Time: {js_str(a.get('occurred_at'))}" if js_truthy(a.get("occurred_at")) else None]
    text = "\n".join(js_str(x) for x in parts if js_truthy(x)) or code
    n = Notification(
        station={"id": st["id"], "code": st["code"], "name": st["name"], "province_id": st["province_id"], "company_id": st["company_id"]},
        alert=alert,
        severity=severity,
        subject=f"[FMS {severity.upper()}] {code} at {st['name']} ({st['code']})",
        text=text,
        recipients={"emails": list(emails), "phones": list(phones)},
    )

    failures: list[str] = []
    for notifier in ctx.notifiers:
        try:
            notifier.send(n)
            ctx.metrics.notifications.labels(channel=notifier.channel, outcome="sent").inc()
        except Exception as err:  # noqa: BLE001
            ctx.metrics.notifications.labels(channel=notifier.channel, outcome="error").inc()
            failures.append(f"{notifier.channel}: {error_message(err)}")
    if failures:
        raise JobError(f"notification channel(s) failed: {'; '.join(failures)}", True, "NOTIFY_FAILED")


notify_handler = JobHandler(kind="notify", handle=handle)
