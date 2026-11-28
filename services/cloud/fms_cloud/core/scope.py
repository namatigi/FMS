"""Data scoping: who may see which stations (port of core-api src/lib/scope.ts).

stations_scope() is THE central scoping function. Every station-related query
must AND its predicate in.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from ..common.db import Conn
from ..common.errors import not_found
from ..common.sqlutil import Params, is_uuid

UserRole = Literal["platform_admin", "owner", "manager", "erb_national", "erb_provincial", "zra_auditor"]


@dataclass
class Principal:
    """The caller. kind='user' comes from the JWT; kind='api_client' from fms.api_clients."""

    kind: Literal["user", "api_client"]
    id: str
    name: str
    company_id: str | None = None
    province_id: int | None = None
    role: str | None = None  # users only
    scopes: list[str] = field(default_factory=list)  # api clients only
    rate_limit_rpm: int = 0  # api clients only

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


def station_scope(pr: Principal, p: Params, alias: str = "s") -> str:
    """SQL boolean predicate over a fms.stations row aliased `alias` (columns id, company_id, province_id).

    platform_admin / erb_national / zra_auditor -> all stations
    owner          -> company_id = claim company
    manager        -> station in user_station_access
    erb_provincial -> province_id = claim province
    api_client     -> optional province_id and company_id limits
    """
    if pr.kind == "api_client":
        conds: list[str] = []
        if pr.province_id is not None:
            conds.append(f"{alias}.province_id = {p.add(pr.province_id)}")
        if pr.company_id is not None:
            conds.append(f"{alias}.company_id = {p.add(pr.company_id)}")
        return f"({' AND '.join(conds)})" if conds else "TRUE"
    role = pr.role
    if role in ("platform_admin", "erb_national", "zra_auditor"):
        return "TRUE"
    if role == "owner":
        return f"{alias}.company_id = {p.add(pr.company_id)}" if pr.company_id else "FALSE"
    if role == "manager":
        return f"{alias}.id IN (SELECT usa.station_id FROM fms.user_station_access usa WHERE usa.user_id = {p.add(pr.id)})"
    if role == "erb_provincial":
        return f"{alias}.province_id = {p.add(pr.province_id)}" if pr.province_id is not None else "FALSE"
    return "FALSE"


def station_id_scope(pr: Principal, p: Params, col: str = "station_id") -> str:
    """Predicate for tables that carry only a station_id column."""
    pred = station_scope(pr, p, "sc")
    if pred == "TRUE":
        return "TRUE"
    return f"{col} IN (SELECT sc.id FROM fms.stations sc WHERE {pred})"


def assert_station_in_scope(db: Conn, pr: Principal, station_id: str) -> dict[str, Any]:
    """Resolve a station the caller may see, or raise 404 (never 403)."""
    if not is_uuid(station_id):
        raise not_found("station")
    p = Params([station_id])
    row = db.one(
        f"SELECT s.id, s.province_id, s.company_id, s.timezone, s.code, s.name FROM fms.stations s WHERE s.id = $1 AND {station_scope(pr, p)}",
        p.values,
    )
    if not row:
        raise not_found("station")
    return row


def regulator_province(pr: Principal, requested: int | None) -> int | None:
    """Province for regulator endpoints. erb_provincial is forced to its own province."""
    if pr.kind == "user" and pr.role == "erb_provincial":
        return pr.province_id if pr.province_id is not None else -1
    if pr.kind == "api_client" and pr.province_id is not None:
        return pr.province_id
    return requested
