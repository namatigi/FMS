"""Example model ``reserve_risk``: probability of a national stock-out per product.

A gradient-boosting classifier is trained (once, lazily) on Monte-Carlo simulations of
"will cumulative demand exceed the stock before the next resupply arrives?" with features
``days_of_cover`` and the coefficient of variation of daily demand. At prediction time the
features come from the request or, when omitted, from the database (national station + depot
stock and the last 28 days of national daily sales).

Inputs (all optional):
    product_code: str            restrict to one product
    days_of_cover: float         override the observed cover (requires product_code)
    demand_cv: float             override the observed demand volatility
"""

from __future__ import annotations

import threading
from datetime import timedelta
from typing import Any

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier

from fms_analytics.config import business_today

RESUPPLY_MIN_DAYS, RESUPPLY_MAX_DAYS = 3, 21
_lock = threading.Lock()
_model: GradientBoostingClassifier | None = None


def _simulate(n: int = 4000, seed: int = 11) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    cover = rng.uniform(0, 40, n)
    cv = rng.uniform(0.02, 0.6, n)
    lead = rng.integers(RESUPPLY_MIN_DAYS, RESUPPLY_MAX_DAYS + 1, n)
    y = np.zeros(n, dtype=int)
    for i in range(n):
        demand = np.clip(rng.normal(1.0, cv[i], lead[i]), 0, None)
        y[i] = int(demand.sum() > cover[i])
    return np.column_stack([cover, cv]), y


def _get_model() -> GradientBoostingClassifier:
    global _model
    with _lock:
        if _model is None:
            x, y = _simulate()
            _model = GradientBoostingClassifier(n_estimators=150, max_depth=2, random_state=0).fit(x, y)
        return _model


def _band(p: float) -> str:
    return "high" if p >= 0.5 else "medium" if p >= 0.2 else "low"


def _observed(ctx: Any, product_code: str | None) -> list[dict[str, Any]]:
    today = business_today()
    pf = "AND product_code = %(p)s" if product_code else ""
    params = {"p": product_code, "start": today - timedelta(days=28), "today": today}
    stock = {
        r["product_code"]: float(r["v"] or 0)
        for r in ctx.db.fetch_all(
            f"SELECT product_code, sum(product_volume_l) v FROM fms.v_station_stock WHERE true {pf} "
            "GROUP BY product_code",
            params,
        )
    }
    for r in ctx.db.fetch_all(
        f"""SELECT product_code, sum(volume_l) v FROM (
              SELECT DISTINCT ON (depot_name, product_code) product_code, volume_l
              FROM fms.depot_stock ORDER BY depot_name, product_code, as_of DESC) x
            WHERE true {pf} GROUP BY product_code""",
        params,
    ):
        stock[r["product_code"]] = stock.get(r["product_code"], 0.0) + float(r["v"] or 0)
    daily = ctx.db.fetch_all(
        f"""SELECT product_code, business_date, sum(sales_volume_l) v FROM fms.daily_station_product
            WHERE business_date >= %(start)s AND business_date < %(today)s {pf}
            GROUP BY product_code, business_date""",
        params,
    )
    series: dict[str, list[float]] = {}
    for r in daily:
        series.setdefault(r["product_code"], []).append(float(r["v"] or 0))
    out = []
    for code, vals in sorted(series.items()):
        arr = np.asarray(vals)
        mean = float(arr.mean()) if arr.size else 0.0
        if mean <= 0:
            continue
        out.append(
            {
                "product_code": code,
                "stock_l": round(stock.get(code, 0.0), 1),
                "avg_daily_demand_l": round(mean, 1),
                "days_of_cover": stock.get(code, 0.0) / mean,
                "demand_cv": float(arr.std(ddof=1) / mean) if arr.size > 1 else 0.1,
            }
        )
    return out


def predict(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    product_code = inputs.get("product_code")
    product_code = str(product_code).upper() if product_code else None
    if inputs.get("days_of_cover") is not None:
        rows = [
            {
                "product_code": product_code,
                "days_of_cover": float(inputs["days_of_cover"]),
                "demand_cv": float(inputs.get("demand_cv", 0.15)),
            }
        ]
    else:
        if ctx is None or ctx.db is None:
            raise ValueError("days_of_cover is required when no database is available")
        rows = _observed(ctx, product_code)
        if inputs.get("demand_cv") is not None:
            for row in rows:
                row["demand_cv"] = float(inputs["demand_cv"])
    model = _get_model()
    results = []
    for row in rows:
        x = np.array([[min(max(row["days_of_cover"], 0.0), 60.0), min(max(row["demand_cv"], 0.0), 1.0)]])
        prob = float(model.predict_proba(x)[0, 1])
        results.append(
            {
                **row,
                "days_of_cover": round(row["days_of_cover"], 2),
                "demand_cv": round(row["demand_cv"], 4),
                "stockout_probability": round(prob, 4),
                "risk": _band(prob),
            }
        )
    return {
        "horizon": f"before next resupply ({RESUPPLY_MIN_DAYS}-{RESUPPLY_MAX_DAYS} days)",
        "products": results,
        "method": "GradientBoostingClassifier on Monte-Carlo simulated demand vs. cover",
    }
