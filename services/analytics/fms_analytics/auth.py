"""JWT (HS256) authentication and role scoping (see docs/api/CONTRACTS.md)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import jwt
from fastapi import Request

from .errors import ApiError

REGULATOR_ROLES = frozenset({"erb_national", "erb_provincial", "platform_admin"})
STATION_ROLES = frozenset({"owner", "manager"})
ALL_ROLES = frozenset({"platform_admin", "owner", "manager", "erb_national", "erb_provincial", "zra_auditor"})


@dataclass(frozen=True)
class Principal:
    sub: str
    role: str
    company_id: str | None
    province_id: int | None
    name: str

    @property
    def is_regulator(self) -> bool:
        return self.role in REGULATOR_ROLES

    def scoped_province(self, requested: int | None) -> int | None:
        """erb_provincial is always forced to its own province."""
        if self.role == "erb_provincial":
            return self.province_id
        return requested


def decode_token(token: str, secret: str) -> Principal:
    if not secret:
        raise ApiError(500, "server_misconfigured", "JWT_SECRET is not configured")
    try:
        claims: dict[str, Any] = jwt.decode(
            token, secret, algorithms=["HS256"], options={"require": ["exp", "sub"]}, leeway=5
        )
    except jwt.ExpiredSignatureError as exc:
        raise ApiError(401, "token_expired", "Access token expired") from exc
    except jwt.PyJWTError as exc:
        raise ApiError(401, "invalid_token", "Invalid access token") from exc
    role = claims.get("role")
    if role not in ALL_ROLES:
        raise ApiError(401, "invalid_token", "Unknown role in token")
    province = claims.get("province_id")
    try:
        province_id = int(province) if province is not None else None
    except (TypeError, ValueError) as exc:
        raise ApiError(401, "invalid_token", "Invalid province_id claim") from exc
    if role == "erb_provincial" and province_id is None:
        raise ApiError(403, "forbidden", "erb_provincial token without province_id")
    return Principal(
        sub=str(claims["sub"]),
        role=role,
        company_id=claims.get("company_id"),
        province_id=province_id,
        name=str(claims.get("name") or ""),
    )


def current_principal(request: Request) -> Principal:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "unauthorized", "Missing bearer token")
    return decode_token(token.strip(), request.app.state.settings.jwt_secret)


def require_regulator(request: Request) -> Principal:
    p = current_principal(request)
    if not p.is_regulator:
        raise ApiError(403, "forbidden", "Regulator role required")
    return p


def require_regulator_or_station(request: Request) -> Principal:
    p = current_principal(request)
    if not (p.is_regulator or p.role in STATION_ROLES):
        raise ApiError(403, "forbidden", "Role not allowed")
    return p
