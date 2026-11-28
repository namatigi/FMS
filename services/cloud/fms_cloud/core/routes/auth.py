"""Port of services/core-api/src/routes/auth.ts.

Login (with lockout and a per-IP rate limit), refresh-token rotation with family
revocation on reuse, logout, /me and TOTP MFA enrolment for erb_* / platform_admin.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Annotated, Any, Literal

from django.http import HttpRequest
from ninja import Router, Schema
from ninja.errors import ValidationError
from pydantic import AfterValidator, Field, StringConstraints
from pydantic import ValidationError as PydanticValidationError

from ...common.crypto import (
    generate_totp_secret,
    otpauth_url,
    random_token,
    sha256_hex,
    sign_jwt,
    verify_jwt,
    verify_password,
    verify_totp,
)
from ...common.db import Conn, primary, ro, tx
from ...common.errors import HttpError, bad_request, unauthorized
from ...common.ratelimit import FixedWindow
from ..audit import audit
from ..auth import MFA_ROLES, client_ip, require_user, user_of
from ..config import config
from ..metrics import LOGINS

router = Router(tags=["auth"])

MAX_FAILURES = 5
LOCK_WINDOW_MIN = 15

# zod's z.string().email() (zod 3.25)
EMAIL_RE = re.compile(r"^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$", re.IGNORECASE)


def _email(v: str) -> str:
    if not EMAIL_RE.match(v):
        raise ValueError("Invalid email")
    return v


Email = Annotated[str, AfterValidator(_email)]

# ------------------------------------------------------------------ rate limits
# @fastify/rate-limit route config: per IP, one store per route.
_limiters: dict[str, FixedWindow] = {}


def _route_limit(name: str, limit: int):
    """A Ninja auth callable: runs before body validation, like the Fastify onRequest rate-limit hook."""

    def check(request: HttpRequest) -> bool:
        lim = _limiters.get(name)
        if lim is None or lim.limit != limit_value():
            lim = _limiters[name] = FixedWindow(limit_value(), 60)
        ok, retry = lim.allow(client_ip(request))
        if not ok:
            raise HttpError(429, "rate_limited", "rate limit exceeded, retry in 1 minute", headers={"Retry-After": str(retry)})
        return True

    def limit_value() -> int:
        return config().login_rate_limit_rpm * limit

    check.__name__ = f"{name}_rate_limit"
    return check


login_limit = _route_limit("login", 1)
refresh_limit = _route_limit("refresh", 2)


# ------------------------------------------------------------------ schemas
class LoginIn(Schema):
    email: Annotated[Email, StringConstraints(max_length=320)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=512)]
    totp_code: str = None  # type: ignore[assignment]  # optional, not nullable (zod .optional())


class RefreshIn(Schema):
    refresh_token: Annotated[str, StringConstraints(min_length=10, max_length=200)]


class LogoutIn(Schema):
    refresh_token: str = None  # type: ignore[assignment]
    all: bool = Field(default=None, strict=True)  # type: ignore[assignment]


class CodeIn(Schema):
    code: str


class UserOut(Schema):
    id: str
    email: str
    full_name: str
    role: str
    company_id: str | None
    province_id: int | None


class TokenOut(Schema):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: Literal["Bearer"]
    user: UserOut


class SuccessOut(Schema):
    success: bool


def _public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {k: u[k] for k in ("id", "email", "full_name", "role", "company_id", "province_id")}


def _issue_tokens(c: Conn, request: HttpRequest, u: dict[str, Any], family_id: str | None = None) -> tuple[str, dict[str, Any]]:
    cfg = config()
    access = sign_jwt(
        {"sub": u["id"], "role": u["role"], "company_id": u["company_id"], "province_id": u["province_id"], "name": u["full_name"]},
        cfg.jwt_secret,
        cfg.access_ttl_sec,
    )
    refresh = random_token(32)
    row = c.one(
        """INSERT INTO fms.refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int), $5, $6) RETURNING id""",
        [
            u["id"],
            family_id or str(uuid.uuid4()),
            sha256_hex(refresh),
            cfg.refresh_ttl_days,
            (request.headers.get("User-Agent") or "")[:300],
            client_ip(request),
        ],
    )
    body = {
        "access_token": access,
        "refresh_token": refresh,
        "expires_in": cfg.access_ttl_sec,
        "token_type": "Bearer",
        "user": _public_user(u),
    }
    return row["id"], body


# ------------------------------------------------------------------ routes
@router.post(
    "/auth/login",
    auth=login_limit,
    response=TokenOut,
    summary="Log in with email + password (+ totp_code when MFA is enabled)",
)
def login(request: HttpRequest, body: LoginIn):
    db = primary
    ip = client_ip(request)
    email = body.email.strip().lower()
    n = db.scalar(
        """SELECT count(*)::int AS n FROM fms.login_attempts
          WHERE email = $1 AND NOT success AND reason IN ('bad_password','bad_totp')
            AND attempted_at > now() - make_interval(mins => $2::int)
            AND attempted_at > coalesce((SELECT max(attempted_at) FROM fms.login_attempts WHERE email = $1 AND success), '-infinity')""",
        [email, LOCK_WINDOW_MIN],
    )
    if (n or 0) >= MAX_FAILURES:
        db.execute("INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,false,'locked')", [email, ip])
        LOGINS.labels("locked").inc()
        audit(db, request, "auth.login_locked", entity="user", details={"email": email}, actor_type="anonymous")
        raise HttpError(429, "account_locked", f"too many failed attempts; try again in {LOCK_WINDOW_MIN} minutes")

    u = db.one(
        """SELECT id, email::text, full_name, role, company_id, province_id, is_active, password_hash, mfa_secret
           FROM fms.users WHERE email = $1""",
        [email],
    )
    pw_ok = verify_password(body.password, u["password_hash"] if u else None)
    if not u or not pw_ok or not u["is_active"]:
        db.execute("INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,false,'bad_password')", [email, ip])
        LOGINS.labels("failure").inc()
        audit(
            db,
            request,
            "auth.login_failed",
            entity="user",
            entity_id=u["id"] if u else None,
            details={"email": email},
            actor_type="anonymous",
        )
        raise unauthorized("invalid email or password", "invalid_credentials")
    if u["mfa_secret"]:
        if not body.totp_code:
            raise unauthorized("TOTP code required", "mfa_required")
        if not verify_totp(u["mfa_secret"], body.totp_code):
            db.execute("INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,false,'bad_totp')", [email, ip])
            LOGINS.labels("failure").inc()
            audit(
                db,
                request,
                "auth.login_failed",
                entity="user",
                entity_id=u["id"],
                details={"email": email, "reason": "bad_totp"},
                actor_type="anonymous",
            )
            raise unauthorized("invalid TOTP code", "invalid_mfa_code")
    with tx() as c:
        c.execute("INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,true,'ok')", [email, ip])
        c.execute("UPDATE fms.users SET last_login_at = now() WHERE id = $1", [u["id"]])
        _, out = _issue_tokens(c, request, u)
        audit(
            c,
            request,
            "auth.login",
            entity="user",
            entity_id=u["id"],
            actor_type="user",
            actor_id=u["id"],
            details={"mfa": bool(u["mfa_secret"])},
        )
    LOGINS.labels("success").inc()
    return out


@router.post("/auth/refresh", auth=refresh_limit, response=TokenOut, summary="Rotate a refresh token")
def refresh(request: HttpRequest, body: RefreshIn):
    token_hash = sha256_hex(body.refresh_token)
    # The transaction yields either tokens or an error; errors are raised only
    # after COMMIT so that family revocation on reuse is persisted.
    error: HttpError | None = None
    out: dict[str, Any] | None = None
    with tx() as c:
        r = c.one(
            """SELECT rt.id AS token_id, rt.family_id, rt.revoked_at, rt.expires_at <= now() AS expired,
                  u.id, u.email::text, u.full_name, u.role, u.company_id, u.province_id, u.is_active, u.password_hash, u.mfa_secret
             FROM fms.refresh_tokens rt JOIN fms.users u ON u.id = rt.user_id
            WHERE rt.token_hash = $1 FOR UPDATE OF rt""",
            [token_hash],
        )
        if not r:
            error = unauthorized("invalid refresh token", "invalid_token")
        elif r["revoked_at"]:
            # Reuse of a rotated/revoked token: revoke the whole family.
            c.execute("UPDATE fms.refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [r["family_id"]])
            audit(c, request, "auth.refresh_reuse_detected", entity="user", entity_id=r["id"], actor_type="user", actor_id=r["id"])
            error = unauthorized("refresh token already used", "invalid_token")
        elif r["expired"] or not r["is_active"]:
            error = unauthorized("refresh token expired", "invalid_token")
        else:
            token_id, out = _issue_tokens(c, request, r, r["family_id"])
            c.execute("UPDATE fms.refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [r["token_id"], token_id])
    if error:
        raise error
    return out


def _logout_body(request: HttpRequest) -> LogoutIn:
    """The body is optional (zod `.optional()` on the object)."""
    if not request.body or "json" not in (request.content_type or ""):
        return LogoutIn()
    try:
        data = json.loads(request.body)
    except ValueError as e:
        raise HttpError(400, "bad_request", f"invalid JSON body: {e}") from e
    try:
        return LogoutIn.model_validate(data)
    except PydanticValidationError as e:
        raise ValidationError([{**err, "loc": ("body", *err.get("loc", ()))} for err in e.errors(include_url=False)]) from e


@router.post(
    "/auth/logout",
    response=SuccessOut,
    summary="Revoke a refresh token (or all of the caller's tokens with all=true)",
    openapi_extra={
        "requestBody": {
            "required": False,
            "content": {"application/json": {"schema": LogoutIn.model_json_schema()}},
        }
    },
)
def logout(request: HttpRequest):
    body = _logout_body(request)
    db = primary
    h = request.headers.get("Authorization")
    authz = re.sub(r"^Bearer\s+", "", h, flags=re.IGNORECASE) if h else None
    claims = verify_jwt(authz, config().jwt_secret) if authz else None
    if not claims and not body.refresh_token:
        raise unauthorized()
    user_id: str | None = claims["sub"] if claims else None
    if body.refresh_token:
        row = db.one(
            "UPDATE fms.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE token_hash = $1 RETURNING user_id",
            [sha256_hex(body.refresh_token)],
        )
        user_id = user_id or (row["user_id"] if row else None)
    if body.all and claims:
        db.execute("UPDATE fms.refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [claims["sub"]])
    if user_id:
        audit(
            db,
            request,
            "auth.logout",
            entity="user",
            entity_id=user_id,
            actor_type="user",
            actor_id=user_id,
            details={"all": bool(body.all)},
        )
    return {"success": True}


@router.get("/me", summary="Current user")
def me(request: HttpRequest):
    require_user(request)
    pr = user_of(request)
    row = ro().one(
        """SELECT u.id, u.email::text AS email, u.full_name, u.role, u.company_id, u.province_id, u.phone,
                c.name AS company_name, p.name AS province_name,
                (u.mfa_secret IS NOT NULL) AS mfa_enabled, u.last_login_at,
                coalesce((SELECT array_agg(usa.station_id ORDER BY usa.station_id) FROM fms.user_station_access usa WHERE usa.user_id = u.id), '{}') AS station_ids
           FROM fms.users u
           LEFT JOIN fms.companies c ON c.id = u.company_id
           LEFT JOIN fms.provinces p ON p.id = u.province_id
          WHERE u.id = $1 AND u.is_active""",
        [pr.id],
    )
    if not row:
        raise unauthorized("user no longer active")
    return row


# ---- TOTP MFA (erb_* and platform_admin)
@router.post("/auth/mfa/enroll", summary="Start TOTP enrolment; returns secret + otpauth URL")
def mfa_enroll(request: HttpRequest):
    require_user(request, MFA_ROLES)
    pr = user_of(request)
    db = primary
    secret = generate_totp_secret()
    email = db.scalar("SELECT email::text FROM fms.users WHERE id = $1", [pr.id])
    db.execute(
        """INSERT INTO fms.mfa_enrolments (user_id, secret) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, created_at = now()""",
        [pr.id, secret],
    )
    audit(db, request, "auth.mfa_enroll_started", entity="user", entity_id=pr.id)
    return {"secret": secret, "otpauth_url": otpauth_url(config().mfa_issuer, email or pr.id, secret)}


@router.post("/auth/mfa/verify", summary="Confirm TOTP enrolment")
def mfa_verify(request: HttpRequest, body: CodeIn):
    require_user(request, MFA_ROLES)
    pr = user_of(request)
    db = primary
    secret = db.scalar("SELECT secret FROM fms.mfa_enrolments WHERE user_id = $1 AND created_at > now() - interval '30 minutes'", [pr.id])
    if not secret:
        raise bad_request("no pending MFA enrolment", "mfa_not_pending")
    if not verify_totp(secret, body.code):
        raise bad_request("invalid TOTP code", "invalid_mfa_code")
    with tx() as c:
        c.execute("UPDATE fms.users SET mfa_secret = $2 WHERE id = $1", [pr.id, secret])
        c.execute("DELETE FROM fms.mfa_enrolments WHERE user_id = $1", [pr.id])
        audit(c, request, "auth.mfa_enabled", entity="user", entity_id=pr.id)
    return {"mfa_enabled": True}


@router.post("/auth/mfa/disable", summary="Disable TOTP (requires a current code)")
def mfa_disable(request: HttpRequest, body: CodeIn):
    require_user(request, MFA_ROLES)
    pr = user_of(request)
    db = primary
    secret = db.scalar("SELECT mfa_secret FROM fms.users WHERE id = $1", [pr.id])
    if not secret:
        return {"mfa_enabled": False}
    if not verify_totp(secret, body.code):
        raise bad_request("invalid TOTP code", "invalid_mfa_code")
    db.execute("UPDATE fms.users SET mfa_secret = NULL WHERE id = $1", [pr.id])
    audit(db, request, "auth.mfa_disabled", entity="user", entity_id=pr.id)
    return {"mfa_enabled": False}
