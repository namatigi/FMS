"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .cache import TTLCache
from .config import Settings
from .db import Database, ReadOnlyDB, apply_migrations
from .errors import ApiError
from .logging_setup import setup_logging
from .metrics import HTTP_LATENCY, HTTP_REQUESTS
from .pricing import load_pricing_config
from .registry import ModelRegistry
from .routes import router

if sys.platform == "win32":  # psycopg async cannot run on the Proactor loop
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

log = logging.getLogger("fms_analytics")


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    setup_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if settings.apply_migrations:
            try:
                await apply_migrations(settings)
            except Exception as exc:  # noqa: BLE001 - RO-only deployments may not migrate
                log.warning("analytics migration not applied", extra={"error": str(exc)})
        db = Database(settings)
        await db.open()
        loop = asyncio.get_running_loop()
        registry = ModelRegistry.from_file(
            settings.models_config, os.environ.get("MODELS_PYTHONPATH", "").split(os.pathsep)
        )
        registry.db_factory = lambda: ReadOnlyDB(db, loop)
        if any(m.spec and m.spec.type == "http" and m.status == "ready" for m in registry.models.values()):
            registry.http_client()
        app.state.db = db
        app.state.registry = registry
        log.info("analytics started", extra={"version": __version__, "models": len(registry.models)})
        try:
            yield
        finally:
            await registry.aclose()
            await db.close()

    app = FastAPI(
        title="FMS Analytics",
        version=__version__,
        lifespan=lifespan,
        docs_url="/analytics/v1/docs",
        openapi_url="/analytics/v1/openapi.json",
    )
    app.state.settings = settings
    app.state.forecast_cache = TTLCache(settings.forecast_cache_ttl_s)
    app.state.pricing_config = load_pricing_config(settings.pricing_config)

    @app.middleware("http")
    async def observe(request: Request, call_next):  # type: ignore[no-untyped-def]
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        t0 = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["x-request-id"] = rid
            return response
        finally:
            dt = time.perf_counter() - t0
            route = request.scope.get("route")
            path = getattr(route, "path", "unmatched")
            HTTP_REQUESTS.labels(request.method, path, str(status)).inc()
            HTTP_LATENCY.labels(request.method, path).observe(dt)
            if path not in {"/healthz", "/metrics"}:
                log.info(
                    "request",
                    extra={
                        "request_id": rid,
                        "method": request.method,
                        "path": request.url.path,
                        "status": status,
                        "duration_ms": round(dt * 1000, 1),
                    },
                )

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return _err(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        msg = "; ".join(f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}" for e in exc.errors())
        return _err(422, "validation_error", msg)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _err(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error")
        return _err(500, "internal_error", "Internal server error")

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    async def readyz(request: Request) -> Response:
        db_ok = await request.app.state.db.ping()
        body = {"status": "ok" if db_ok else "unavailable", "database": "ok" if db_ok else "down"}
        return JSONResponse(body, status_code=200 if db_ok else 503)

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> Response:
        return PlainTextResponse(generate_latest().decode(), media_type=CONTENT_TYPE_LATEST)

    app.include_router(router)
    return app


app = create_app()
