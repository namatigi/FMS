"""API errors. Every error body is {"error": {"code": ..., "message": ...}} (docs/api/CONTRACTS.md)."""

from __future__ import annotations


class HttpError(Exception):
    def __init__(self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers or {}

    def body(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}


def not_found(what: str = "resource") -> HttpError:
    return HttpError(404, "not_found", f"{what} not found")


def forbidden(msg: str = "insufficient permissions") -> HttpError:
    return HttpError(403, "forbidden", msg)


def unauthorized(msg: str = "authentication required", code: str = "unauthorized") -> HttpError:
    return HttpError(401, code, msg)


def bad_request(msg: str, code: str = "bad_request") -> HttpError:
    return HttpError(400, code, msg)


def conflict(msg: str) -> HttpError:
    return HttpError(409, "conflict", msg)


def unprocessable(msg: str, code: str = "unprocessable") -> HttpError:
    return HttpError(422, code, msg)


# PostgreSQL SQLSTATE -> API error, as core-api's Fastify error handler mapped them.
PG_ERRORS: dict[str, tuple[int, str, str | None]] = {
    "23505": (409, "conflict", "a record with the same unique key already exists"),
    "23503": (409, "conflict", "referenced record missing or record still referenced"),
    "23514": (400, "bad_request", None),
    "23502": (400, "bad_request", None),
    "22P02": (400, "bad_request", None),
    "22007": (400, "bad_request", None),
    "22008": (400, "bad_request", None),
    "22003": (400, "bad_request", None),
}


def from_db_error(exc: BaseException) -> HttpError | None:
    """Map a psycopg/Django DatabaseError to an HttpError, or None if it is not a client error."""
    cause = exc.__cause__ or exc
    sqlstate = getattr(cause, "sqlstate", None) or getattr(getattr(cause, "diag", None), "sqlstate", None)
    if not sqlstate or sqlstate not in PG_ERRORS:
        return None
    status, code, msg = PG_ERRORS[sqlstate]
    return HttpError(status, code, msg or f"invalid value: {str(cause).splitlines()[0]}")
