"""Example model ``pricing``: linear trend of the national volume-weighted pump price.

Fits ``avg_price ~ a + b * t`` (scikit-learn LinearRegression) per product over the last
``lookback_days`` (default 180) of ``daily_station_product`` and extrapolates to
``horizon_days`` (default 30) after the last observation.

Inputs: product_code (required), horizon_days?, lookback_days?
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import numpy as np
from sklearn.linear_model import LinearRegression

from fms_analytics.config import business_today


def predict(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    code = str(inputs["product_code"]).upper()
    horizon = int(inputs.get("horizon_days", 30))
    lookback = int(inputs.get("lookback_days", 180))
    today = business_today()
    rows = ctx.db.fetch_all(
        """SELECT business_date AS d, sum(sales_amount) / nullif(sum(sales_volume_l), 0) AS price
           FROM fms.daily_station_product
           WHERE product_code = %s AND business_date >= %s AND business_date < %s AND sales_volume_l > 0
           GROUP BY business_date ORDER BY business_date""",
        (code, today - timedelta(days=lookback), today),
    )
    rows = [r for r in rows if r["price"] is not None]
    if len(rows) < 5:
        raise ValueError(f"not enough price history for {code} ({len(rows)} days)")
    d0 = rows[0]["d"]
    t = np.array([[(r["d"] - d0).days] for r in rows], dtype=float)
    y = np.array([float(r["price"]) for r in rows])
    reg = LinearRegression().fit(t, y)
    last = rows[-1]["d"]
    target = last + timedelta(days=horizon)
    pred = float(reg.predict(np.array([[(target - d0).days]], dtype=float))[0])
    resid = y - reg.predict(t)
    return {
        "product_code": code,
        "predicted_price": round(pred, 2),
        "target_date": target.isoformat(),
        "last_observed_price": round(float(y[-1]), 2),
        "slope_zmw_per_day": round(float(reg.coef_[0]), 5),
        "r2": round(float(reg.score(t, y)), 4),
        "residual_std": round(float(resid.std(ddof=1)), 4),
        "n_obs": len(rows),
    }
