"""FiscalError (packages/shared/src/fiscal.ts)."""

from __future__ import annotations


class FiscalError(Exception):
    """Fiscalisation failure carrying an explicit retry decision and an optional code."""

    def __init__(self, message: str, retryable: bool, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.code = code
