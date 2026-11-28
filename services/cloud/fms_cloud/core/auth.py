"""Request authentication for user (JWT) routes (port of core-api src/lib/auth.ts).

Call require_user() at the top of a view, the way the Fastify routes used a
preHandler. It sets request.principal and returns it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from django.http import HttpRequest

from ..common.crypto import verify_jwt
from ..common.errors import forbidden, unauthorized
from .config import config
from .scope import Principal

READ_ROLES = ("platform_admin", "owner", "manager", "erb_national", "erb_provincial", "zra_auditor")
OPERATOR_ROLES = ("platform_admin", "owner", "manager")
REGULATOR_ROLES = ("platform_admin", "erb_national", "erb_provincial")
MFA_ROLES = ("platform_admin", "erb_national", "erb_provincial")

_BEARER = re.compile(r"^Bearer\s+", re.IGNORECASE)


def _bearer(request: HttpRequest, allow_query_token: bool) -> str | None:
    h = request.headers.get("Authorization")
    if h and _BEARER.match(h):
        return _BEARER.sub("", h).strip()
    if allow_query_token:
        q = request.GET.get("token")
        if q:
            return q
    return None


def require_user(request: HttpRequest, roles: Iterable[str] | None = None, *, allow_query_token: bool = False) -> Principal:
    tok = _bearer(request, allow_query_token)
    if not tok:
        raise unauthorized()
    claims = verify_jwt(tok, config().jwt_secret)
    if not claims:
        raise unauthorized("invalid or expired token", "invalid_token")
    pr = Principal(
        kind="user",
        id=claims["sub"],
        role=claims["role"],
        company_id=claims.get("company_id"),
        province_id=claims.get("province_id"),
        name=claims.get("name") or "",
    )
    request.principal = pr
    if roles is not None and pr.role not in tuple(roles):
        raise forbidden()
    return pr


def require_roles(request: HttpRequest, *roles: str) -> None:
    pr = getattr(request, "principal", None)
    if not pr or pr.kind != "user" or pr.role not in roles:
        raise forbidden()


def user_of(request: HttpRequest) -> Principal:
    pr = getattr(request, "principal", None)
    if not pr or pr.kind != "user":
        raise unauthorized()
    return pr


def client_ip(request: HttpRequest) -> str:
    """trustProxy: first X-Forwarded-For hop, else REMOTE_ADDR."""
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "")
