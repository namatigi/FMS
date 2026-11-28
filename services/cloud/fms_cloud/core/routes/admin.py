"""Port of services/core-api/src/routes/admin.ts.

Generic CRUD over the platform tables (platform_admin only) plus the audit-log viewer.
Each resource gets GET /<name>, GET /<name>/{id}, POST /<name>, PATCH /<name>/{id},
DELETE /<name>/{id} and, for resources with generated secrets, POST /<name>/{id}/rotate.

No `from __future__ import annotations` here: the views are created in a loop and
their (dynamic) pydantic types must be real objects for Ninja to read them.
"""

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from django.http import HttpRequest, HttpResponse
from ninja import Query, Router, Schema
from pydantic import AfterValidator, Field, PlainValidator, StrictBool, StringConstraints, WithJsonSchema, create_model

from ...common.crypto import generate_api_key, hash_password, random_token
from ...common.db import Conn, primary, ro, tx
from ...common.errors import bad_request, not_found
from ...common.jsonutil import json_response
from ...common.sqlutil import Params, decode_cursor, encode_cursor, is_uuid
from ..audit import audit
from ..auth import require_user
from .auth import Email

router = Router(tags=["admin"])

ROLES = ("platform_admin", "owner", "manager", "erb_national", "erb_provincial", "zra_auditor")
PARTNER_SCOPES = ("stations:read", "stock:read", "sales:read", "prices:read", "alerts:read")
WEBHOOK_EVENTS = ("daily_summary", "critical_alert", "stock_low")

# ------------------------------------------------------------------ zod-like field types

# z.string().uuid() (zod 3.25)
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$", re.IGNORECASE)


def _uuid(v: str) -> str:
    if not _UUID_RE.match(v):
        raise ValueError("Invalid uuid")
    return v


Uuid = Annotated[str, AfterValidator(_uuid)]


def Str(min_len: int | None = None, max_len: int | None = None):
    return Annotated[str, StringConstraints(min_length=min_len, max_length=max_len)]


def Num(*, int_: bool = False, ge: float | None = None, le: float | None = None, gt: float | None = None):
    """z.number() (optionally .int() / .min() / .max() / .positive() / .nonnegative()): JSON numbers only."""

    def check(v: Any) -> int | float:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise ValueError("Expected number")
        if int_:
            if not float(v).is_integer():
                raise ValueError("Expected integer, received float")
            v = int(v)
        if ge is not None and v < ge:
            raise ValueError(f"Number must be greater than or equal to {ge:g}")
        if le is not None and v > le:
            raise ValueError(f"Number must be less than or equal to {le:g}")
        if gt is not None and v <= gt:
            raise ValueError(f"Number must be greater than {gt:g}")
        return v

    schema: dict[str, Any] = {"type": "integer" if int_ else "number"}
    if ge is not None:
        schema["minimum"] = ge
    if le is not None:
        schema["maximum"] = le
    if gt is not None:
        schema["exclusiveMinimum"] = gt
    return Annotated[Any, PlainValidator(check), WithJsonSchema(schema)]


_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")
_SPECIAL = {"http", "https", "ws", "wss", "ftp"}


def _url(v: str) -> str:
    """Approximates `new URL(v)` succeeding (z.string().url())."""
    if not _SCHEME_RE.match(v) or any(ch.isspace() for ch in v.strip()):
        raise ValueError("Invalid url")
    try:
        parts = urlsplit(v.strip())
        _ = parts.port
    except ValueError as e:
        raise ValueError("Invalid url") from e
    if parts.scheme.lower() in _SPECIAL and not parts.hostname:
        raise ValueError("Invalid url")
    return v


def _http_url(v: str) -> str:
    if not re.match(r"^https?://", v):
        raise ValueError("http(s) URL required")
    return v


Url = Annotated[str, AfterValidator(_url), StringConstraints(max_length=2000)]
HttpUrl = Annotated[Url, AfterValidator(_http_url)]
ProvinceId = Num(int_=True, ge=1, le=10)


def req(t: Any) -> tuple[Any, Any]:
    return (t, ...)


def opt(t: Any) -> tuple[Any, Any]:
    """zod .optional(): may be absent, explicit null is rejected."""
    return (t, None)


def nopt(t: Any) -> tuple[Any, Any]:
    """zod .nullable().optional()."""
    return (t | None, None)


def opt_str(max_len: int = 200) -> tuple[Any, Any]:
    return nopt(Str(max_len=max_len))


def items(t: Any, min_len: int = 0) -> Any:
    return Annotated[list[t], Field(min_length=min_len or None)]


# ------------------------------------------------------------------ resources


@dataclass
class Resource:
    name: str  # path segment
    table: str  # fms.<table>
    entity: str  # audit entity
    select: str  # select list over alias t
    order_by: str
    create: dict[str, tuple[Any, Any]]
    update: dict[str, tuple[Any, Any]]
    filters: list[str]  # equality filters allowed in querystring
    to_columns: Callable[[dict[str, Any], str], dict[str, Any]] | None = None
    after_write: Callable[[Conn, str, dict[str, Any]], None] | None = None
    generate: Callable[[], tuple[dict[str, Any], dict[str, Any]]] | None = None  # (columns, reveal)
    validate: Callable[[dict[str, Any]], None] | None = None
    redact: list[str] = field(default_factory=list)


def _users_to_columns(inp: dict[str, Any], mode: str) -> dict[str, Any]:
    cols = {k: v for k, v in inp.items() if k not in ("password", "station_ids", "reset_mfa")}
    if isinstance(cols.get("email"), str):
        cols["email"] = cols["email"].lower()
    if isinstance(inp.get("password"), str):
        cols["password_hash"] = hash_password(inp["password"])
    if inp.get("reset_mfa"):
        cols["mfa_secret"] = None
    return cols


def _users_validate(m: dict[str, Any]) -> None:
    if m.get("role") in ("owner", "manager") and not m.get("company_id"):
        raise bad_request(f"role {m['role']} requires company_id")
    if m.get("role") == "erb_provincial" and m.get("province_id") is None:
        raise bad_request("role erb_provincial requires province_id")


def _users_after_write(c: Conn, id_: str, inp: dict[str, Any]) -> None:
    if not isinstance(inp.get("station_ids"), list):
        return
    c.execute("DELETE FROM fms.user_station_access WHERE user_id = $1", [id_])
    if inp["station_ids"]:
        c.execute(
            "INSERT INTO fms.user_station_access (user_id, station_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
            [id_, inp["station_ids"]],
        )


def _gen_api_client() -> tuple[dict[str, Any], dict[str, Any]]:
    k = generate_api_key()
    return {"key_prefix": k["prefix"], "key_hash": k["hash"]}, {"api_key": k["key"]}


def _gen_gateway() -> tuple[dict[str, Any], dict[str, Any]]:
    k = generate_api_key()
    return {"api_key_hash": k["hash"]}, {"api_key": k["key"]}


def _gen_webhook() -> tuple[dict[str, Any], dict[str, Any]]:
    secret = random_token(32)
    return {"secret": secret}, {"secret": secret}


StationStatus = Literal["active", "suspended", "closed", "commissioning"]
ConnectionMode = Literal["edge", "direct"]
Lat = Num(ge=-90, le=90)
Lng = Num(ge=-180, le=180)

RESOURCES: list[Resource] = [
    Resource(
        name="companies",
        table="companies",
        entity="company",
        select="t.id, t.name, t.zra_tpin, t.erb_licence_no, t.contact_email::text AS contact_email, t.contact_phone, t.created_at",
        order_by="t.name, t.id",
        create={
            "name": req(Str(1, 200)),
            "zra_tpin": opt_str(20),
            "erb_licence_no": opt_str(),
            "contact_email": nopt(Email),
            "contact_phone": opt_str(40),
        },
        update={
            "name": opt(Str(1, 200)),
            "zra_tpin": opt_str(20),
            "erb_licence_no": opt_str(),
            "contact_email": nopt(Email),
            "contact_phone": opt_str(40),
        },
        filters=[],
    ),
    Resource(
        name="stations",
        table="stations",
        entity="station",
        select="""t.id, t.company_id, t.code, t.name, t.province_id, t.district, t.town, t.address, t.latitude, t.longitude, t.timezone,
             t.erb_licence_no, t.zra_branch_id, t.status, t.connection_mode, t.created_at""",
        order_by="t.code, t.id",
        create={
            "company_id": req(Uuid),
            "code": req(Str(1, 40)),
            "name": req(Str(1, 200)),
            "province_id": req(ProvinceId),
            "district": opt_str(),
            "town": opt_str(),
            "address": opt_str(500),
            "latitude": nopt(Lat),
            "longitude": nopt(Lng),
            "timezone": opt(Str(max_len=64)),
            "erb_licence_no": opt_str(),
            "zra_branch_id": opt(Str(max_len=10)),
            "status": opt(StationStatus),
            "connection_mode": opt(ConnectionMode),
        },
        update={
            "company_id": opt(Uuid),
            "code": opt(Str(1, 40)),
            "name": opt(Str(1, 200)),
            "province_id": opt(ProvinceId),
            "district": opt_str(),
            "town": opt_str(),
            "address": opt_str(500),
            "latitude": nopt(Lat),
            "longitude": nopt(Lng),
            "timezone": opt(Str(max_len=64)),
            "erb_licence_no": opt_str(),
            "zra_branch_id": opt(Str(max_len=10)),
            "status": opt(StationStatus),
            "connection_mode": opt(ConnectionMode),
        },
        filters=["company_id", "province_id", "status"],
    ),
    Resource(
        name="tanks",
        table="tanks",
        entity="tank",
        select="t.id, t.station_id, t.tank_no, t.product_code, t.capacity_l, t.low_level_l, t.created_at",
        order_by="t.station_id, t.tank_no",
        create={
            "station_id": req(Uuid),
            "tank_no": req(Num(int_=True, ge=1, le=50)),
            "product_code": req(Str(1)),
            "capacity_l": req(Num(gt=0)),
            "low_level_l": nopt(Num(ge=0)),
        },
        update={
            "tank_no": opt(Num(int_=True, ge=1, le=50)),
            "product_code": opt(Str(1)),
            "capacity_l": opt(Num(gt=0)),
            "low_level_l": nopt(Num(ge=0)),
        },
        filters=["station_id"],
    ),
    Resource(
        name="fuel_grades",
        table="fuel_grades",
        entity="fuel_grade",
        select="t.id, t.station_id, t.pts_grade_id, t.name, t.product_code, t.zra_item_code, t.price",
        order_by="t.station_id, t.pts_grade_id",
        create={
            "station_id": req(Uuid),
            "pts_grade_id": req(Num(int_=True, ge=0)),
            "name": req(Str(1, 100)),
            "product_code": req(Str(1)),
            "zra_item_code": opt_str(50),
            "price": req(Num(gt=0)),
        },
        update={
            "pts_grade_id": opt(Num(int_=True, ge=0)),
            "name": opt(Str(1, 100)),
            "product_code": opt(Str(1)),
            "zra_item_code": opt_str(50),
            "price": opt(Num(gt=0)),
        },
        filters=["station_id"],
    ),
    Resource(
        name="nozzles",
        table="nozzles",
        entity="nozzle",
        select="t.id, t.station_id, t.pump_no, t.nozzle_no, t.fuel_grade_id, t.tank_id",
        order_by="t.station_id, t.pump_no, t.nozzle_no",
        create={
            "station_id": req(Uuid),
            "pump_no": req(Num(int_=True, ge=1, le=50)),
            "nozzle_no": req(Num(int_=True, ge=1, le=10)),
            "fuel_grade_id": nopt(Uuid),
            "tank_id": nopt(Uuid),
        },
        update={
            "pump_no": opt(Num(int_=True, ge=1, le=50)),
            "nozzle_no": opt(Num(int_=True, ge=1, le=10)),
            "fuel_grade_id": nopt(Uuid),
            "tank_id": nopt(Uuid),
        },
        filters=["station_id"],
    ),
    Resource(
        name="controllers",
        table="controllers",
        entity="controller",
        select="t.id, t.station_id, t.pts_id, (t.hmac_secret IS NOT NULL) AS has_hmac_secret, t.firmware, t.last_seen_at, t.last_status, t.created_at",
        order_by="t.pts_id",
        create={"station_id": req(Uuid), "pts_id": req(Str(1, 64)), "hmac_secret": opt_str(200), "firmware": opt_str(100)},
        update={"station_id": opt(Uuid), "pts_id": opt(Str(1, 64)), "hmac_secret": opt_str(200), "firmware": opt_str(100)},
        filters=["station_id"],
        redact=["hmac_secret"],
    ),
    Resource(
        name="users",
        table="users",
        entity="user",
        select="""t.id, t.email::text AS email, t.full_name, t.phone, t.role, t.company_id, t.province_id, t.is_active,
             (t.mfa_secret IS NOT NULL) AS mfa_enabled, t.last_login_at, t.created_at,
             coalesce((SELECT array_agg(usa.station_id) FROM fms.user_station_access usa WHERE usa.user_id = t.id), '{}') AS station_ids""",
        order_by="t.email, t.id",
        create={
            "email": req(Annotated[Email, StringConstraints(max_length=320)]),
            "full_name": req(Str(1, 200)),
            "phone": opt_str(40),
            "password": req(Str(10, 200)),
            "role": req(Literal[ROLES]),
            "company_id": nopt(Uuid),
            "province_id": nopt(ProvinceId),
            "is_active": opt(StrictBool),
            "station_ids": opt(items(Uuid)),
        },
        update={
            "email": opt(Annotated[Email, StringConstraints(max_length=320)]),
            "full_name": opt(Str(1, 200)),
            "phone": opt_str(40),
            "password": opt(Str(10, 200)),
            "role": opt(Literal[ROLES]),
            "company_id": nopt(Uuid),
            "province_id": nopt(ProvinceId),
            "is_active": opt(StrictBool),
            "station_ids": opt(items(Uuid)),
            "reset_mfa": opt(StrictBool),
        },
        filters=["role", "company_id", "province_id"],
        redact=["password"],
        to_columns=_users_to_columns,
        validate=_users_validate,
        after_write=_users_after_write,
    ),
    Resource(
        name="api-clients",
        table="api_clients",
        entity="api_client",
        select="t.id, t.name, t.organisation, t.key_prefix, t.scopes, t.province_id, t.company_id, t.rate_limit_rpm, t.is_active, t.created_at",
        order_by="t.name, t.id",
        create={
            "name": req(Str(1, 200)),
            "organisation": req(Str(1, 200)),
            "scopes": req(items(Literal[PARTNER_SCOPES], 1)),
            "province_id": nopt(ProvinceId),
            "company_id": nopt(Uuid),
            "rate_limit_rpm": opt(Num(int_=True, ge=1, le=100000)),
            "is_active": opt(StrictBool),
        },
        update={
            "name": opt(Str(1, 200)),
            "organisation": opt(Str(1, 200)),
            "scopes": opt(items(Literal[PARTNER_SCOPES], 1)),
            "province_id": nopt(ProvinceId),
            "company_id": nopt(Uuid),
            "rate_limit_rpm": opt(Num(int_=True, ge=1, le=100000)),
            "is_active": opt(StrictBool),
        },
        filters=["province_id", "company_id"],
        generate=_gen_api_client,
    ),
    Resource(
        name="gateways",
        table="edge_gateways",
        entity="edge_gateway",
        select="t.id, t.station_id, t.gateway_code, t.role, t.version, t.last_seen_at, t.last_backlog, t.created_at",
        order_by="t.gateway_code",
        create={"station_id": req(Uuid), "gateway_code": req(Str(1, 64)), "role": opt(Literal["primary", "standby"])},
        update={"station_id": opt(Uuid), "gateway_code": opt(Str(1, 64)), "role": opt(Literal["primary", "standby"])},
        filters=["station_id"],
        generate=_gen_gateway,
    ),
    Resource(
        name="webhooks",
        table="webhook_subscriptions",
        entity="webhook_subscription",
        select="t.id, t.api_client_id, t.url, t.events, t.is_active, t.created_at",
        order_by="t.created_at DESC, t.id",
        create={
            "api_client_id": req(Uuid),
            "url": req(HttpUrl),
            "events": req(items(Literal[WEBHOOK_EVENTS], 1)),
            "is_active": opt(StrictBool),
        },
        update={"url": opt(Url), "events": opt(items(Literal[WEBHOOK_EVENTS], 1)), "is_active": opt(StrictBool)},
        filters=["api_client_id"],
        generate=_gen_webhook,
    ),
]

_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


def ident(s: str) -> str:
    if not _IDENT.match(s):
        raise ValueError(f"bad identifier {s}")
    return s


def _redact(r: Resource, inp: dict[str, Any]) -> dict[str, Any]:
    out = dict(inp)
    for k in r.redact:
        if k in out:
            out[k] = "[redacted]"
    return out


def _camel(name: str) -> str:
    return "".join(p.capitalize() for p in re.split(r"[-_]", name))


def _offset(cursor: str | None) -> int:
    c = decode_cursor(cursor)
    v = c[0] if c else 0
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0
    return int(n) if math.isfinite(n) else 0


def _register(r: Resource) -> None:
    cname = _camel(r.name)
    op = r.name.replace("-", "_")
    CreateIn = create_model(f"Admin{cname}Create", __base__=Schema, **r.create)
    UpdateIn = create_model(f"Admin{cname}Update", __base__=Schema, **r.update)
    query_fields: dict[str, Any] = {
        "limit": (Annotated[int, Field(ge=1, le=1000)], 200),
        "cursor": (str, Field(default=None)),
    }
    for f in r.filters:
        query_fields[f] = (str, Field(default=None))
    ListQuery = create_model(f"Admin{cname}ListQuery", __base__=Schema, **query_fields)

    def fetch_one(c: Conn, id_: str) -> dict[str, Any] | None:
        return c.one(f"SELECT {r.select} FROM fms.{r.table} t WHERE t.id = $1", [id_])

    @router.get(f"/{r.name}", summary=f"List {r.name}", operation_id=f"admin_{op}_list")
    def list_(request: HttpRequest, q: Query[ListQuery]):
        require_user(request, ["platform_admin"])
        qd = q.model_dump()
        p = Params()
        where = ["TRUE"]
        for f in r.filters:
            if qd.get(f) is not None and qd[f] != "":
                where.append(f"t.{ident(f)}::text = {p.add(str(qd[f]))}")
        offset = _offset(qd.get("cursor"))
        limit = int(qd["limit"])
        rows = ro().query(
            f"SELECT {r.select} FROM fms.{r.table} t WHERE {' AND '.join(where)} ORDER BY {r.order_by} LIMIT {limit + 1} OFFSET {offset}",
            p.values,
        )
        more = len(rows) > limit
        return {"items": rows[:limit], "next_cursor": encode_cursor([offset + limit]) if more else None}

    @router.get(f"/{r.name}/{{id}}", summary=f"Get one of {r.name}", operation_id=f"admin_{op}_get")
    def get_(request: HttpRequest, id: str):
        require_user(request, ["platform_admin"])
        if not is_uuid(id):
            raise not_found(r.entity)
        row = fetch_one(primary, id)
        if not row:
            raise not_found(r.entity)
        return row

    @router.post(
        f"/{r.name}",
        summary=f"Create {r.entity}{' (secret returned once)' if r.generate else ''}",
        operation_id=f"admin_{op}_create",
    )
    def create(request: HttpRequest, body: CreateIn):
        require_user(request, ["platform_admin"])
        inp = body.model_dump(exclude_unset=True)
        if r.validate:
            r.validate(inp)
        cols = r.to_columns(inp, "create") if r.to_columns else dict(inp)
        gen_cols, reveal = r.generate() if r.generate else ({}, {})
        cols.update(gen_cols)
        keys = list(cols.keys())
        p = Params()
        placeholders = [p.add(cols[k]) for k in keys]
        with tx() as c:
            id_ = c.one(
                f"INSERT INTO fms.{r.table} ({', '.join(ident(k) for k in keys)}) VALUES ({', '.join(placeholders)}) RETURNING id",
                p.values,
            )["id"]
            if r.after_write:
                r.after_write(c, id_, inp)
            audit(c, request, f"admin.{r.entity}.create", entity=r.entity, entity_id=id_, details=_redact(r, inp))
            out = fetch_one(c, id_)
        return json_response({**(out or {}), **reveal}, status=201)

    @router.patch(f"/{r.name}/{{id}}", summary=f"Update {r.entity}", operation_id=f"admin_{op}_update")
    def update(request: HttpRequest, id: str, body: UpdateIn):
        require_user(request, ["platform_admin"])
        if not is_uuid(id):
            raise not_found(r.entity)
        inp = body.model_dump(exclude_unset=True)
        if not inp:
            raise bad_request("empty update")
        with tx() as c:
            cur = c.one(f"SELECT * FROM fms.{r.table} WHERE id = $1 FOR UPDATE", [id])
            if not cur:
                raise not_found(r.entity)
            if r.validate:
                r.validate({**cur, **inp})
            cols = r.to_columns(inp, "update") if r.to_columns else dict(inp)
            keys = list(cols.keys())
            if keys:
                p = Params([id])
                c.execute(f"UPDATE fms.{r.table} SET {', '.join(f'{ident(k)} = {p.add(cols[k])}' for k in keys)} WHERE id = $1", p.values)
            if r.after_write:
                r.after_write(c, id, inp)
            audit(c, request, f"admin.{r.entity}.update", entity=r.entity, entity_id=id, details=_redact(r, inp))
            return fetch_one(c, id)

    @router.delete(f"/{r.name}/{{id}}", summary=f"Delete {r.entity}", operation_id=f"admin_{op}_delete")
    def delete(request: HttpRequest, id: str):
        require_user(request, ["platform_admin"])
        if not is_uuid(id):
            raise not_found(r.entity)
        with tx() as c:
            if not c.execute(f"DELETE FROM fms.{r.table} WHERE id = $1", [id]):
                raise not_found(r.entity)
            audit(c, request, f"admin.{r.entity}.delete", entity=r.entity, entity_id=id)
        return HttpResponse(status=204)

    if r.generate:
        generate = r.generate

        @router.post(f"/{r.name}/{{id}}/rotate", summary=f"Rotate {r.entity} secret (returned once)", operation_id=f"admin_{op}_rotate")
        def rotate(request: HttpRequest, id: str):
            require_user(request, ["platform_admin"])
            if not is_uuid(id):
                raise not_found(r.entity)
            gen_cols, reveal = generate()
            keys = list(gen_cols.keys())
            p = Params([id])
            with tx() as c:
                n = c.execute(
                    f"UPDATE fms.{r.table} SET {', '.join(f'{ident(k)} = {p.add(gen_cols[k])}' for k in keys)} WHERE id = $1", p.values
                )
                if not n:
                    raise not_found(r.entity)
                audit(c, request, f"admin.{r.entity}.rotate_secret", entity=r.entity, entity_id=id)
                return {**(fetch_one(c, id) or {}), **reveal}


for _r in RESOURCES:
    _register(_r)


# ------------------------------------------------------------------ audit log viewer
class AuditLogQuery(Schema):
    action: str = None  # type: ignore[assignment]
    actor_id: str = None  # type: ignore[assignment]
    entity: str = None  # type: ignore[assignment]
    limit: Annotated[int, Field(ge=1, le=1000)] = 200
    cursor: str = None  # type: ignore[assignment]


@router.get("/audit-log", summary="Audit log, newest first")
def audit_log(request: HttpRequest, q: Query[AuditLogQuery]):
    require_user(request, ["platform_admin"])
    p = Params()
    where = ["TRUE"]
    if q.action:
        where.append(f"action = {p.add(q.action)}")
    if q.actor_id:
        where.append(f"actor_id = {p.add(q.actor_id)}")
    if q.entity:
        where.append(f"entity = {p.add(q.entity)}")
    c = decode_cursor(q.cursor)
    if c:
        where.append(f"id < {p.add(_num(c[0]))}")
    rows = ro().query(f"SELECT * FROM fms.audit_log WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT {q.limit + 1}", p.values)
    more = len(rows) > q.limit
    page = rows[: q.limit]
    return {"items": page, "next_cursor": encode_cursor([page[-1]["id"]]) if more else None}


def _num(v: Any) -> Any:
    """JavaScript Number(v)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float("nan")
    return int(f) if f.is_integer() else f
