"""Risk bands shared by stock-out and national reserve endpoints."""

from __future__ import annotations


def days_of_cover(stock_l: float | None, avg_daily_l: float | None) -> float | None:
    if stock_l is None or avg_daily_l is None or avg_daily_l <= 0:
        return None
    return max(stock_l, 0.0) / avg_daily_l


def station_risk(days: float | None) -> str:
    """Stock-out risk per station: high < 2 days, medium < 5 days, else low."""
    if days is None:
        return "low"
    if days < 2:
        return "high"
    if days < 5:
        return "medium"
    return "low"


def reserve_risk(days: float | None) -> str:
    """National reserve risk: critical < 3, high < 7, medium < 15, else low."""
    if days is None:
        return "low"
    if days < 3:
        return "critical"
    if days < 7:
        return "high"
    if days < 15:
        return "medium"
    return "low"


def r(value: float | None, nd: int = 1) -> float | None:
    return None if value is None else round(float(value), nd)
