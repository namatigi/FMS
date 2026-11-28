"""ingest-api HTTP endpoints (port of services/ingest-api/src/app.ts).

POST /ingest/pts               direct jsonPTS uploads from PTS-2 controllers (raw body for the HMAC)
POST /ingest/v1/edge/batches   EdgeBatch uploads from station edge gateways (optionally gzip-encoded)

Plain Django views: both endpoints need the raw request body (HMAC over the exact bytes, streaming
gzip with a decompressed-size limit), and Fastify's body handling is reproduced here:
Content-Length above BODY_LIMIT_BYTES -> 413, decompressed gzip above the limit -> 413,
unsupported Content-Encoding -> 415, unsupported Content-Type -> 415, invalid JSON -> 400.
Error replies on /ingest/pts are jsonPTS replies; elsewhere {"error": {"code", "message"}}.
"""

from __future__ import annotations

import logging
import threading
import time
import zlib
from typing import Any

from django.http import HttpRequest, HttpResponse
from django.views.decorators.csrf import csrf_exempt

from fms_cloud.common.crypto import safe_equal_hex, sha256_hex, verify_pts_signature
from fms_cloud.common.jsonutil import json_response
from fms_cloud.common.middleware import not_found_view

from . import metrics
from .config import Config, load_config
from .dbutil import sqlstate
from .ingest import Deps, TransientError, handle_edge_batch, handle_pts_upload
from .jsonpts import jsonpts_reply
from .jsutil import MISSING, is_number, js_norm, loads
from .ratelimit import RateLimiter
from .refdata import RefData

log = logging.getLogger("fms.ingest")

PTS_ROUTE = "/ingest/pts"
EDGE_ROUTE = "/ingest/v1/edge/batches"


# ------------------------------------------------------------------ per-process state (buildApp)


class IngestApp:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.ref = RefData(cfg.cache_ttl_ms)
        self.limiter = RateLimiter(cfg.rate_limit_rps, cfg.rate_limit_burst)

    def deps(self) -> Deps:
        return Deps(cfg=self.cfg, ref=self.ref)


_app: IngestApp | None = None
_app_lock = threading.Lock()


def get_app() -> IngestApp:
    global _app
    if _app is None:
        with _app_lock:
            if _app is None:
                _app = IngestApp(load_config())
    return _app


def configure(**overrides: Any) -> IngestApp:
    """(Re)build the process state from the environment plus overrides (tests, embedding)."""
    global _app
    with _app_lock:
        _app = IngestApp(load_config(**overrides))
    return _app


# ------------------------------------------------------------------ helpers


class _HttpFail(Exception):
    """A Fastify-style request error (body parsing, encoding) -> routed through the error handler."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _api_error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> HttpResponse:
    return json_response({"error": {"code": code, "message": message}}, status=status, headers=headers)


def _reply(body: Any, status: int = 200, headers: dict[str, str] | None = None) -> HttpResponse:
    return json_response(js_norm(body), status=status, headers=headers)


def _header(request: HttpRequest, name: str) -> str | None:
    return request.headers.get(name)


def _content_length(request: HttpRequest) -> int | None:
    try:
        v = request.META.get("CONTENT_LENGTH")
        return int(v) if v not in (None, "") else None
    except ValueError:
        return None


_TOO_LARGE = ("FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large")


def _read_raw(request: HttpRequest, limit: int) -> bytes:
    """The request body, at most `limit` bytes (413 beyond, like Fastify's bodyLimit)."""
    n = _content_length(request)
    if n is not None and n > limit:
        raise _HttpFail(413, *_TOO_LARGE)
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = request.read(64 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise _HttpFail(413, *_TOO_LARGE)
        chunks.append(chunk)
    return b"".join(chunks)


def _gunzip(request: HttpRequest, limit: int) -> bytes:
    """Stream-decompress the body; the limit applies to the decompressed size (zip-bomb safe)."""
    step = 64 * 1024
    out: list[bytes] = []
    size = 0
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    seen_input = False

    def feed(data: bytes) -> None:
        nonlocal size, d
        while True:
            if d.eof:
                if not data:
                    return
                d = zlib.decompressobj(16 + zlib.MAX_WBITS)  # concatenated members, as node's gunzip accepts
            piece = d.decompress(data, step)  # bounded output per call
            size += len(piece)
            if size > limit:
                raise _HttpFail(413, *_TOO_LARGE)
            out.append(piece)
            data = d.unused_data if d.eof else d.unconsumed_tail
            if not data and len(piece) < step:
                return

    try:
        while True:
            chunk = request.read(step)
            if not chunk:
                break
            seen_input = True
            feed(chunk)
    except zlib.error as e:
        raise _HttpFail(400, "Z_DATA_ERROR", str(e).split(": ", 1)[-1]) from e
    if not seen_input or not d.eof:
        raise _HttpFail(400, "Z_BUF_ERROR", "unexpected end of file")
    return b"".join(out)


def _observe(route: str, outcome: str, t0: float) -> None:
    metrics.batch_latency.labels(route, outcome).observe(time.perf_counter() - t0)


def _error_reply(request: HttpRequest, route_url: str, status: int, code: str, message: str) -> HttpResponse:
    """Fastify setErrorHandler: count, then a jsonPTS reply on /ingest/pts or an API error elsewhere."""
    metrics.reject(route_url, "body_too_large" if status == 413 else f"http_{status}")
    if request.path.startswith(PTS_ROUTE):
        return _reply(jsonpts_reply([{"id": 0, "ok": False, "message": message}]), status=status)
    return _api_error(status, code, "internal error" if status >= 500 else message)


def _crash(request: HttpRequest, route_url: str, err: BaseException) -> HttpResponse:
    log.error("request failed", exc_info=err, extra={"path": request.path, "request_id": getattr(request, "id", None)})
    return _error_reply(request, route_url, 500, sqlstate(err) or "error", str(err))


# ------------------------------------------------------------------ direct jsonPTS


@csrf_exempt
def pts_upload(request: HttpRequest) -> HttpResponse:
    if request.method != "POST":
        return not_found_view(request)
    try:
        return _pts_upload(request, get_app())
    except _HttpFail as e:
        return _error_reply(request, PTS_ROUTE, e.status, e.code, e.message)
    except Exception as e:  # noqa: BLE001
        return _crash(request, PTS_ROUTE, e)


def _pts_upload(request: HttpRequest, app: IngestApp) -> HttpResponse:
    t0 = time.perf_counter()
    raw = _read_raw(request, app.cfg.body_limit_bytes)

    def finish(outcome: str) -> None:
        _observe("pts", outcome, t0)

    try:
        body = loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        metrics.reject("pts", "invalid_json")
        finish("bad_request")
        return _reply(jsonpts_reply([{"id": 0, "ok": False, "message": "Invalid JSON"}]), status=400)
    packets = body.get("Packets") if isinstance(body, dict) else None
    packets = packets if isinstance(packets, list) else None

    def unauthorized(message: str) -> HttpResponse:
        finish("unauthorized")
        out = []
        for i, p in enumerate(packets if packets is not None else [{}]):
            pk: dict[str, Any] = {"Id": p["Id"] if isinstance(p, dict) and is_number(p.get("Id")) else i}
            if isinstance(p, dict) and isinstance(p.get("Type"), str):
                pk["Type"] = p["Type"]
            pk.update({"Error": True, "Code": 401, "Message": message})
            out.append(pk)
        return _reply({"Protocol": "jsonPTS", "Packets": out}, status=401)

    if packets is None:
        metrics.reject("pts", "invalid_request")
        finish("bad_request")
        return _reply(jsonpts_reply([{"id": 0, "ok": False, "message": "Packets array required"}]), status=400)
    body_pts = body.get("PtsId")
    pts_id = (body_pts if isinstance(body_pts, str) and body_pts else None) or _header(request, "x-pts-id")
    if not pts_id:
        metrics.reject("pts", "unknown_controller")
        return unauthorized("Unauthorized: PtsId missing")
    ctl = app.ref.controllers.get(pts_id)
    if not ctl:
        metrics.reject("pts", "unknown_controller")
        return unauthorized("Unauthorized: unknown controller")
    sig_h = _header(request, "x-pts-signature")
    sig = None
    if sig_h is not None:
        sig = (sig_h[7:] if sig_h[:7].lower() == "sha256=" else sig_h).strip()
    if not verify_pts_signature(ctl.hmac_secret, raw, sig):
        metrics.reject("pts", "bad_signature")
        log.warning("bad PTS signature", extra={"ptsId": pts_id})
        return unauthorized("Unauthorized: bad signature")
    wait = app.limiter.take(f"pts:{pts_id}")
    if wait > 0:
        metrics.reject("pts", "rate_limited")
        finish("rate_limited")
        results = []
        for i, p in enumerate(packets):
            pid = p.get("Id") if isinstance(p, dict) else None
            results.append({"id": pid if pid is not None else i, "ok": False, "message": "Rate limited"})
        return _reply(jsonpts_reply(results), status=429, headers={"Retry-After": str(wait)})
    station = app.ref.stations.get(ctl.station_id)
    if not station:
        return unauthorized("Unauthorized: controller has no station")
    metrics.batch_size.labels("pts").observe(len(packets))
    status, out = handle_pts_upload(app.deps(), station, pts_id, packets)
    finish("ok" if status == 200 else "unavailable")
    return _reply(out, status=status, headers={"Retry-After": "5"} if status == 503 else None)


# ------------------------------------------------------------------ edge batches


def _parse_edge_body(request: HttpRequest, cfg: Config) -> Any:
    """Fastify preParsing (Content-Encoding) + content-type parsing for the edge route. MISSING = no body."""
    enc = (_header(request, "content-encoding") or "identity").lower()
    if enc not in ("identity", "gzip"):
        raise _HttpFail(415, "unsupported_encoding", f"unsupported content-encoding {enc}")
    ctype = request.META.get("CONTENT_TYPE") or None
    if ctype is None:
        # Fastify only parses a body it has a content type for; with none (and no length) there is no body
        n = _content_length(request)
        if enc == "gzip" or not n:
            return MISSING
        raise _HttpFail(415, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type: ")
    media = ctype.split(";", 1)[0].strip().lower()
    if media not in ("application/json", "text/plain"):
        raise _HttpFail(415, "FST_ERR_CTP_INVALID_MEDIA_TYPE", f"Unsupported Media Type: {ctype}")
    raw = _gunzip(request, cfg.body_limit_bytes) if enc == "gzip" else _read_raw(request, cfg.body_limit_bytes)
    text = raw.decode("utf-8", errors="replace")
    if media == "text/plain":
        return text
    if text == "":
        raise _HttpFail(400, "FST_ERR_CTP_EMPTY_JSON_BODY", "Body cannot be empty when content-type is set to 'application/json'")
    try:
        return loads(text)
    except ValueError:
        raise _HttpFail(
            400, "FST_ERR_CTP_INVALID_JSON_BODY", "Body is not valid JSON but content-type is set to 'application/json'"
        ) from None


@csrf_exempt
def edge_batches(request: HttpRequest) -> HttpResponse:
    if request.method != "POST":
        return not_found_view(request)
    try:
        return _edge_batches(request, get_app())
    except _HttpFail as e:
        return _error_reply(request, EDGE_ROUTE, e.status, e.code, e.message)
    except Exception as e:  # noqa: BLE001
        return _crash(request, EDGE_ROUTE, e)


def _edge_batches(request: HttpRequest, app: IngestApp) -> HttpResponse:
    cfg = app.cfg
    body = _parse_edge_body(request, cfg)
    t0 = time.perf_counter()

    def finish(outcome: str) -> None:
        _observe("edge", outcome, t0)

    code = _header(request, "x-gateway-code")
    auth = _header(request, "authorization")
    key = auth[7:].strip() if auth and auth.startswith("Bearer ") else None
    if not code or not key:
        metrics.reject("edge", "unauthorized")
        finish("unauthorized")
        return _api_error(401, "unauthorized", "Bearer key and X-Gateway-Code required")
    wait = app.limiter.take(f"gw:{code}")
    if wait > 0:
        metrics.reject("edge", "rate_limited")
        finish("rate_limited")
        return _api_error(429, "rate_limited", "slow down", headers={"Retry-After": str(wait)})
    gw = app.ref.gateways.get(code)
    if not gw or not safe_equal_hex(sha256_hex(key), gw.api_key_hash):
        metrics.reject("edge", "unauthorized")
        finish("unauthorized")
        return _api_error(401, "unauthorized", "invalid gateway credentials")
    station = app.ref.stations.get(gw.station_id)
    if not station:
        return _api_error(403, "forbidden", "gateway station not found")
    if not isinstance(body, dict) or not isinstance(body.get("records"), list):
        metrics.reject("edge", "invalid_request")
        finish("bad_request")
        return _api_error(400, "invalid_batch", "EdgeBatch with records[] required")
    if "gateway_code" in body and body["gateway_code"] != code:
        finish("forbidden")
        return _api_error(403, "forbidden", "gateway_code does not match X-Gateway-Code")
    if body.get("station_code", MISSING) != station.code:
        metrics.reject("edge", "station_mismatch")
        finish("forbidden")
        return _api_error(403, "station_mismatch", f"gateway {code} is registered for station {station.code}")
    records = body["records"]
    if len(records) > cfg.max_records_per_batch:
        metrics.reject("edge", "too_many_records")
        finish("bad_request")
        return _api_error(413, "too_many_records", f"max {cfg.max_records_per_batch} records per batch")
    metrics.batch_size.labels("edge").observe(len(records))
    batch_id = body.get("batch_id")
    try:
        res = handle_edge_batch(app.deps(), gw, station, batch_id if isinstance(batch_id, str) else "", records, body)
    except TransientError:
        metrics.reject("edge", "db_unavailable")
        finish("unavailable")
        return _api_error(503, "unavailable", "database unavailable, retry", headers={"Retry-After": "5"})
    finish("ok")
    return _reply(res)
