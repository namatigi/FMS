"""Pluggable alert notifiers for the `notify` job (services/fiscal-worker/src/notifiers.ts).

Every notifier receives the same Notification; channels are enabled by environment variables:
  (always)          LogNotifier
  SMTP_HOST         SmtpNotifier   - stub: logs the e-mail; plug in an SMTP transport
  SMS_GATEWAY_URL   SmsNotifier    - POSTs {to, message} JSON to an SMS gateway (Bearer SMS_GATEWAY_TOKEN)
  FCM_PROJECT_ID    FcmNotifier    - stub: logs the push to topic station-<id>; needs FCM HTTP v1 credentials
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .config import WorkerConfig
from .core import JobError, Log
from .jscompat import js_dumps


@dataclass
class Notification:
    station: dict[str, Any]  # {id, code, name, province_id, company_id}
    alert: dict[str, Any]
    severity: str
    subject: str
    text: str
    recipients: dict[str, list[str]]  # {emails, phones}


class Notifier(Protocol):
    channel: str

    def send(self, n: Notification) -> None: ...


class LogNotifier:
    channel = "log"

    def __init__(self, log: Log) -> None:
        self.log = log

    def send(self, n: Notification) -> None:
        self.log.warning(n.subject, station=n.station["code"], severity=n.severity, alert=n.alert, recipients=n.recipients)


class SmtpNotifier:
    channel = "email"

    def __init__(self, cfg: dict[str, Any], log: Log) -> None:
        self.cfg = cfg
        self.log = log

    def send(self, n: Notification) -> None:
        if not n.recipients["emails"]:
            return
        # Stub: wire an SMTP transport here (kept dependency-free on purpose).
        self.log.info(
            "email notification (stub)",
            smtp=f"{self.cfg['host']}:{self.cfg['port']}",
            **{"from": self.cfg["from"]},
            to=n.recipients["emails"],
            subject=n.subject,
        )


class SmsNotifier:
    channel = "sms"

    def __init__(self, cfg: dict[str, Any], log: Log, http: httpx.Client | None = None) -> None:
        self.cfg = cfg
        self.log = log
        self.http = http or httpx.Client()

    def send(self, n: Notification) -> None:
        if not n.recipients["phones"]:
            return
        headers = {"content-type": "application/json"}
        if self.cfg.get("token"):
            headers["authorization"] = f"Bearer {self.cfg['token']}"
        body = js_dumps({"to": n.recipients["phones"], "message": f"{n.subject}\n{n.text}"[:480]})
        res = self.http.post(self.cfg["url"], headers=headers, content=body.encode("utf-8"), timeout=10.0)
        if not (200 <= res.status_code <= 299):
            raise JobError(f"SMS gateway HTTP {res.status_code}", True)
        self.log.info("sms notification sent", to=len(n.recipients["phones"]))


class FcmNotifier:
    channel = "push"

    def __init__(self, cfg: dict[str, Any], log: Log) -> None:
        self.cfg = cfg
        self.log = log

    def send(self, n: Notification) -> None:
        # Stub: needs FCM HTTP v1 OAuth credentials; the mobile app subscribes to topic station-<id>.
        self.log.info("push notification (stub)", project=self.cfg["projectId"], topic=f"station-{n.station['id']}", title=n.subject)


def notifiers_from_config(cfg: WorkerConfig, log: Log, http: httpx.Client | None = None) -> list[Notifier]:
    out: list[Notifier] = [LogNotifier(log)]
    if cfg.notify.smtp:
        out.append(SmtpNotifier(cfg.notify.smtp, log))
    if cfg.notify.sms:
        out.append(SmsNotifier(cfg.notify.sms, log, http))
    if cfg.notify.fcm:
        out.append(FcmNotifier(cfg.notify.fcm, log))
    return out
