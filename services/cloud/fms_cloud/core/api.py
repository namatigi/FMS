"""The core API as one Django Ninja instance mounted at /api.

/api/v1/...          owner/manager, ERB, ZRA and admin routes (JWT)
/api/partner/v1/...  partner API (X-API-Key)
/api/docs            Swagger UI, /api/openapi.json the generated spec
"""

from __future__ import annotations

from django.db import DatabaseError
from django.http import HttpRequest
from ninja import NinjaAPI, Router
from ninja.errors import AuthenticationError, ValidationError
from ninja.errors import HttpError as NinjaHttpError
from ninja.renderers import BaseRenderer

from ..common.errors import HttpError, from_db_error
from ..common.jsonutil import dumps, json_response
from ..common.middleware import error_response


class JsonRenderer(BaseRenderer):
    media_type = "application/json"

    def render(self, request: HttpRequest, data, *, response_status):
        return dumps(data)


api = NinjaAPI(
    title="FMS core-api",
    description="National Fuel Monitoring System (Zambia) — owner/manager, ERB regulator, admin and partner APIs.",
    version="0.1.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
    renderer=JsonRenderer(),
    urls_namespace="core",
)


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for e in exc.errors:
        loc = "/".join(str(x) for x in e.get("loc", ()) if x not in ("body", "query", "path", "payload"))
        parts.append(f"/{loc} {e.get('msg', '')}".strip() if loc else str(e.get("msg", "")))
    return "; ".join(p for p in parts if p) or "invalid request"


@api.exception_handler(ValidationError)
def _on_validation(request: HttpRequest, exc: ValidationError):
    return json_response({"error": {"code": "validation_error", "message": _validation_message(exc)}}, status=400)


@api.exception_handler(HttpError)
def _on_http_error(request: HttpRequest, exc: HttpError):
    return json_response(exc.body(), status=exc.status_code, headers=exc.headers)


@api.exception_handler(NinjaHttpError)
def _on_ninja_http_error(request: HttpRequest, exc: NinjaHttpError):
    code = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed"}.get(
        exc.status_code, "error"
    )
    return json_response({"error": {"code": code, "message": str(exc)}}, status=exc.status_code)


@api.exception_handler(AuthenticationError)
def _on_auth_error(request: HttpRequest, exc: AuthenticationError):
    return json_response({"error": {"code": "unauthorized", "message": "authentication required"}}, status=401)


@api.exception_handler(DatabaseError)
def _on_db_error(request: HttpRequest, exc: DatabaseError):
    mapped = from_db_error(exc)
    if mapped:
        return json_response(mapped.body(), status=mapped.status_code)
    return error_response(request, exc)


# --------------------------------------------------------------- routers
# Each module defines `router = Router()`; prefixes match the Fastify registration.
from .routes import admin, alerts, auth, dashboard, fiscal, partner, regulator, stations, stream

v1 = Router()
v1.add_router("", auth.router)
v1.add_router("", dashboard.router)
v1.add_router("", stations.router)
v1.add_router("", alerts.router)
v1.add_router("", fiscal.router)
v1.add_router("", stream.router)
v1.add_router("/regulator", regulator.router)
v1.add_router("/admin", admin.router)

api.add_router("/v1", v1)
api.add_router("/partner/v1", partner.router)
