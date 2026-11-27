"""Custom AI model registry.

Models are declared in MODELS_CONFIG (YAML or JSON)::

    models:
      reserve_risk:
        type: python
        entrypoint: fms_analytics.example_models.reserve_risk:predict
        version: "1.0.0"
        timeout_s: 10
      demand_mlflow:
        type: http
        url: http://mlflow:5001/invocations
        headers: {Authorization: "Bearer ${MLFLOW_TOKEN}"}
        timeout_s: 5
        enabled: false

Python entry points are ``module:function`` and are called as ``fn(inputs)`` or
``fn(inputs, ctx)`` (sync or async). ``ctx`` is a :class:`ModelContext` with a read-only DB
accessor. HTTP models receive ``POST {"inputs": {...}}`` and must answer JSON; an
``outputs`` object is used as-is, an MLflow ``predictions`` answer is wrapped as
``{"predictions": ...}``, anything else (an object) is returned as the outputs.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import logging
import os
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx
import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .db import ReadOnlyDB
from .errors import ApiError
from .metrics import MODEL_LATENCY, MODEL_PREDICTIONS, MODELS_LOADED

log = logging.getLogger("fms_analytics.registry")

_NAME_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,63}$")
_ENV_RE = re.compile(r"\$\{([A-Z0-9_]+)\}")
_TYPES: dict[str, tuple[type, ...]] = {
    "number": (int, float),
    "integer": (int,),
    "string": (str,),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list,),
}


class InputSchema(BaseModel):
    """Minimal input contract: required keys and simple JSON types."""

    model_config = ConfigDict(extra="forbid")
    required: list[str] = Field(default_factory=list)
    properties: dict[str, dict[str, Any]] = Field(default_factory=dict)
    additional_properties: bool = True


class ModelSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["python", "http"]
    entrypoint: str | None = None
    url: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_s: float = Field(10.0, gt=0, le=300)
    version: str = "0"
    description: str = ""
    enabled: bool = True
    tags: list[str] = Field(default_factory=list)
    input_schema: InputSchema | None = None
    options: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check(self) -> ModelSpec:
        if self.type == "python" and (not self.entrypoint or ":" not in self.entrypoint):
            raise ValueError("python models need entrypoint 'package.module:function'")
        if self.type == "http" and not (self.url and self.url.startswith(("http://", "https://"))):
            raise ValueError("http models need an http(s) url")
        return self


@dataclass
class ModelContext:
    name: str
    version: str
    db: ReadOnlyDB | None
    options: dict[str, Any]
    logger: logging.Logger


@dataclass
class RegisteredModel:
    name: str
    spec: ModelSpec | None
    status: str = "ready"  # ready | disabled | error
    error: str | None = None
    fn: Callable[..., Any] | None = field(default=None, repr=False)
    wants_ctx: bool = False
    is_async: bool = False

    def describe(self) -> dict[str, Any]:
        s = self.spec
        out: dict[str, Any] = {"name": self.name, "status": self.status, "error": self.error}
        if s is not None:
            out.update(
                type=s.type,
                version=s.version,
                description=s.description,
                enabled=s.enabled,
                timeout_s=s.timeout_s,
                tags=s.tags,
                input_schema=s.input_schema.model_dump() if s.input_schema else None,
            )
            if s.type == "python":
                out["entrypoint"] = s.entrypoint
            else:
                out["url"] = s.url  # headers deliberately not exposed (may hold secrets)
        return out


def _expand_env(value: str) -> str:
    return _ENV_RE.sub(lambda m: os.environ.get(m.group(1), ""), value)


def _validate_inputs(schema: InputSchema | None, inputs: dict[str, Any]) -> None:
    if schema is None:
        return
    missing = [k for k in schema.required if k not in inputs]
    if missing:
        raise ApiError(422, "invalid_inputs", f"Missing required inputs: {', '.join(missing)}")
    for key, value in inputs.items():
        prop = schema.properties.get(key)
        if prop is None:
            if not schema.additional_properties:
                raise ApiError(422, "invalid_inputs", f"Unexpected input: {key}")
            continue
        t = prop.get("type")
        if t in _TYPES and value is not None:
            ok = isinstance(value, _TYPES[t]) and not (t in {"number", "integer"} and isinstance(value, bool))
            if not ok:
                raise ApiError(422, "invalid_inputs", f"Input {key} must be of type {t}")
        if "enum" in prop and value not in prop["enum"]:
            raise ApiError(422, "invalid_inputs", f"Input {key} must be one of {prop['enum']}")


class ModelRegistry:
    def __init__(self) -> None:
        self.models: dict[str, RegisteredModel] = {}
        self.db_factory: Callable[[], ReadOnlyDB | None] = lambda: None
        self._http: httpx.AsyncClient | None = None

    # ------------------------------------------------------------------ loading
    @classmethod
    def from_file(cls, path: Path, extra_paths: list[str] | None = None) -> ModelRegistry:
        reg = cls()
        for p in extra_paths or []:
            if p and p not in sys.path:
                sys.path.insert(0, p)
        if not path.exists():
            log.warning("models config not found", extra={"path": str(path)})
            return reg
        text = path.read_text(encoding="utf-8")
        raw = json.loads(text) if path.suffix.lower() == ".json" else yaml.safe_load(text)
        reg.load_dict(raw or {})
        return reg

    def load_dict(self, raw: dict[str, Any]) -> None:
        models = raw.get("models", {}) if isinstance(raw, dict) else {}
        if not isinstance(models, dict):
            raise ValueError("'models' must be a mapping of name -> spec")
        for name, body in models.items():
            self.register(str(name), body)

    def register(self, name: str, body: dict[str, Any] | ModelSpec) -> RegisteredModel:
        if not _NAME_RE.match(name):
            rm = RegisteredModel(name=name, spec=None, status="error", error="invalid model name")
            self.models[name] = rm
            return rm
        try:
            spec = body if isinstance(body, ModelSpec) else ModelSpec.model_validate(body)
        except ValidationError as exc:
            rm = RegisteredModel(name=name, spec=None, status="error", error=_short(exc))
            log.error("invalid model spec", extra={"model": name, "error": rm.error})
            self.models[name] = rm
            return rm
        rm = RegisteredModel(name=name, spec=spec)
        if not spec.enabled:
            rm.status = "disabled"
        elif spec.type == "python":
            try:
                mod_name, _, fn_name = spec.entrypoint.partition(":")  # type: ignore[union-attr]
                fn = getattr(importlib.import_module(mod_name), fn_name)
                if not callable(fn):
                    raise TypeError(f"{spec.entrypoint} is not callable")
                rm.fn = fn
                rm.is_async = inspect.iscoroutinefunction(fn)
                params = [
                    p
                    for p in inspect.signature(fn).parameters.values()
                    if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
                ]
                rm.wants_ctx = len(params) >= 2
            except Exception as exc:  # noqa: BLE001
                rm.status, rm.error = "error", f"{type(exc).__name__}: {exc}"
                log.error("model load failed", extra={"model": name, "error": rm.error})
        self.models[name] = rm
        MODELS_LOADED.labels(model=name, status=rm.status).set(1)
        log.info("model registered", extra={"model": name, "type": spec.type, "status": rm.status})
        return rm

    def available(self, name: str) -> bool:
        m = self.models.get(name)
        return m is not None and m.status == "ready"

    def list(self) -> list[dict[str, Any]]:
        return [m.describe() for m in sorted(self.models.values(), key=lambda m: m.name)]

    def http_client(self) -> httpx.AsyncClient:
        # Created once (building the TLS context is slow) and outside any model timeout.
        if self._http is None:
            self._http = httpx.AsyncClient()
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # --------------------------------------------------------------- predicting
    async def predict(self, name: str, inputs: dict[str, Any]) -> dict[str, Any]:
        m = self.models.get(name)
        if m is None:
            raise ApiError(404, "model_not_found", f"Model {name} is not registered")
        if m.status == "disabled":
            raise ApiError(409, "model_disabled", f"Model {name} is disabled")
        if m.status != "ready" or m.spec is None:
            raise ApiError(503, "model_unavailable", f"Model {name} failed to load: {m.error}")
        spec = m.spec
        _validate_inputs(spec.input_schema, inputs)
        if spec.type == "http":
            self.http_client()
        t0 = time.perf_counter()
        outcome = "error"
        try:
            async with asyncio.timeout(spec.timeout_s):
                raw = await (
                    self._call_python(m, inputs) if spec.type == "python" else self._call_http(m, inputs)
                )
            outputs = _normalise_outputs(raw)
            outcome = "ok"
            return {"outputs": outputs, "model": name, "version": spec.version}
        except TimeoutError as exc:
            outcome = "timeout"
            raise ApiError(504, "model_timeout", f"Model {name} timed out after {spec.timeout_s}s") from exc
        except ApiError:
            raise
        except Exception as exc:
            log.exception("model prediction failed", extra={"model": name})
            raise ApiError(502, "model_error", f"Model {name} failed: {type(exc).__name__}: {exc}") from exc
        finally:
            dt = time.perf_counter() - t0
            MODEL_PREDICTIONS.labels(model=name, outcome=outcome).inc()
            MODEL_LATENCY.labels(model=name).observe(dt)
            log.info(
                "model prediction",
                extra={
                    "model": name,
                    "version": spec.version,
                    "outcome": outcome,
                    "duration_ms": round(dt * 1000, 1),
                },
            )

    async def _call_python(self, m: RegisteredModel, inputs: dict[str, Any]) -> Any:
        assert m.fn is not None and m.spec is not None
        ctx = ModelContext(
            name=m.name,
            version=m.spec.version,
            db=self.db_factory(),
            options=dict(m.spec.options),
            logger=logging.getLogger(f"fms_analytics.models.{m.name}"),
        )
        args: tuple[Any, ...] = (dict(inputs), ctx) if m.wants_ctx else (dict(inputs),)
        if m.is_async:
            return await m.fn(*args)
        # Sync models run in a worker thread; on timeout we stop waiting (thread finishes on its own).
        return await asyncio.to_thread(m.fn, *args)

    async def _call_http(self, m: RegisteredModel, inputs: dict[str, Any]) -> Any:
        assert m.spec is not None and m.spec.url
        client = self.http_client()
        headers = {
            "content-type": "application/json",
            **{k: _expand_env(v) for k, v in m.spec.headers.items()},
        }
        resp = await client.post(
            _expand_env(m.spec.url), json={"inputs": inputs}, headers=headers, timeout=m.spec.timeout_s
        )
        if resp.status_code >= 400:
            raise ApiError(502, "model_error", f"Model {m.name} returned HTTP {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise ApiError(502, "model_error", f"Model {m.name} returned non-JSON") from exc
        if isinstance(body, dict) and "outputs" in body:
            return body["outputs"]
        if isinstance(body, dict) and "predictions" in body:
            return {"predictions": body["predictions"]}
        return body


def _normalise_outputs(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ApiError(502, "model_error", "Model outputs must be a JSON object")
    try:
        return json.loads(json.dumps(raw, allow_nan=False, default=_json_default))
    except (TypeError, ValueError) as exc:
        raise ApiError(502, "model_error", f"Model outputs are not JSON-serialisable: {exc}") from exc


def _json_default(o: Any) -> Any:
    if hasattr(o, "item"):  # numpy scalars
        return o.item()
    if hasattr(o, "tolist"):
        return o.tolist()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    raise TypeError(f"{type(o).__name__} is not JSON serialisable")


def _short(exc: ValidationError) -> str:
    return "; ".join(f"{'.'.join(map(str, e['loc'])) or 'spec'}: {e['msg']}" for e in exc.errors())
