"""One-line JSON logs on stdout, shaped like the pino logs of the node services."""

from __future__ import annotations

import json
import logging
import time

_LEVELS = {"DEBUG": 20, "INFO": 30, "WARNING": 40, "ERROR": 50, "CRITICAL": 60}
_SKIP = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str = "fms", **kw) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        out = {
            "level": _LEVELS.get(record.levelname, 30),
            "time": int(time.time() * 1000),
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _SKIP and not k.startswith("_"):
                out[k] = v
        if record.exc_info:
            out["err"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)
