"""Daily demand forecasting (pure functions, no I/O).

* >= 28 days of history: Holt-Winters additive (damped additive trend, additive weekly
  seasonality). 80 % prediction intervals from simulated future paths.
* 7..27 days: seasonal naive (same weekday last week); interval from the std of
  weekly differences.
* 1..6 days: historical mean; interval from the sample std.
Backtest: the same method is refit on all but the last 14 days and MAPE (%) is computed
on that 14-day holdout.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np
import pandas as pd

SEASON = 7
HW_MIN_DAYS = 28
HOLDOUT_DAYS = 14
Z80 = 1.2815515655446004  # two-sided 80 % => 10th / 90th percentiles


@dataclass
class ForecastResult:
    model: str
    dates: list[date]
    mean: np.ndarray
    lower: np.ndarray
    upper: np.ndarray


def prepare_series(rows: list[tuple[date, float]], end: date | None = None) -> pd.Series:
    """Daily series with a complete calendar; interior gaps are linearly interpolated."""
    if not rows:
        return pd.Series(dtype=float)
    s = pd.Series({pd.Timestamp(d): float(v) for d, v in rows}).sort_index()
    last = pd.Timestamp(end) if end is not None else s.index.max()
    idx = pd.date_range(s.index.min(), max(last, s.index.max()), freq="D")
    s = s.reindex(idx).interpolate(limit_direction="both")
    s.index.freq = "D"
    return s


def _hw(y: pd.Series, horizon: int, reps: int = 400) -> ForecastResult:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit = ExponentialSmoothing(
            y.to_numpy(dtype=float),
            trend="add",
            damped_trend=True,
            seasonal="add",
            seasonal_periods=SEASON,
            initialization_method="estimated",
        ).fit(optimized=True)
        mean = np.asarray(fit.forecast(horizon), dtype=float)
        try:
            sims = np.asarray(
                fit.simulate(
                    horizon,
                    repetitions=reps,
                    error="add",
                    anchor="end",
                    random_state=np.random.default_rng(7),
                ),
                dtype=float,
            ).reshape(horizon, -1)
            lower = np.percentile(sims, 10, axis=1)
            upper = np.percentile(sims, 90, axis=1)
        except Exception:  # noqa: BLE001 - fall back to analytic residual band
            sd = float(np.std(np.asarray(fit.resid, dtype=float), ddof=1))
            steps = np.sqrt(np.arange(1, horizon + 1))
            lower, upper = mean - Z80 * sd * steps, mean + Z80 * sd * steps
    lower = np.minimum(lower, mean)
    upper = np.maximum(upper, mean)
    return ForecastResult("holt_winters_additive_weekly", _future(y, horizon), mean, lower, upper)


def _seasonal_naive(y: pd.Series, horizon: int) -> ForecastResult:
    vals = y.to_numpy(dtype=float)
    last_week = vals[-SEASON:]
    mean = np.array([last_week[i % SEASON] for i in range(horizon)])
    diffs = vals[SEASON:] - vals[:-SEASON]
    sd = (
        float(np.std(diffs, ddof=1))
        if diffs.size >= 2
        else float(np.std(vals, ddof=1) if vals.size > 1 else 0)
    )
    k = np.sqrt(np.floor(np.arange(horizon) / SEASON) + 1)
    return ForecastResult(
        "seasonal_naive_weekly", _future(y, horizon), mean, mean - Z80 * sd * k, mean + Z80 * sd * k
    )


def _mean(y: pd.Series, horizon: int) -> ForecastResult:
    vals = y.to_numpy(dtype=float)
    m = float(vals.mean())
    sd = float(vals.std(ddof=1)) if vals.size > 1 else abs(m) * 0.2
    mean = np.full(horizon, m)
    band = Z80 * sd * np.sqrt(1 + 1 / max(vals.size, 1))
    return ForecastResult("historical_mean", _future(y, horizon), mean, mean - band, mean + band)


def _future(y: pd.Series, horizon: int) -> list[date]:
    last = y.index.max().date()
    return [last + timedelta(days=i) for i in range(1, horizon + 1)]


def fit_forecast(y: pd.Series, horizon: int) -> ForecastResult:
    n = len(y)
    if n >= HW_MIN_DAYS:
        try:
            return _hw(y, horizon)
        except Exception:  # noqa: BLE001 - degenerate series (e.g. constant) -> fallback
            return _seasonal_naive(y, horizon)
    if n >= SEASON:
        return _seasonal_naive(y, horizon)
    return _mean(y, horizon)


def mape(actual: np.ndarray, predicted: np.ndarray) -> float | None:
    mask = np.abs(actual) > 1e-9
    if not mask.any():
        return None
    return float(np.mean(np.abs((actual[mask] - predicted[mask]) / actual[mask])) * 100)


def backtest_mape(y: pd.Series, holdout: int = HOLDOUT_DAYS) -> float | None:
    if len(y) < holdout + SEASON:
        return None
    train, test = y.iloc[:-holdout], y.iloc[-holdout:]
    res = fit_forecast(train, holdout)
    return mape(test.to_numpy(dtype=float), np.clip(res.mean, 0, None))


def forecast_payload(y: pd.Series, horizon: int, history_days: int) -> dict:
    if y.empty:
        return {"history": [], "forecast": [], "model": "none", "mape": None}
    res = fit_forecast(y, horizon)
    m = backtest_mape(y)
    hist = y.iloc[-history_days:]
    return {
        "history": [{"date": d.date().isoformat(), "value": round(float(v), 1)} for d, v in hist.items()],
        "forecast": [
            {
                "date": d.isoformat(),
                "value": round(max(float(mu), 0.0), 1),
                "lower": round(max(float(lo), 0.0), 1),
                "upper": round(max(float(hi), 0.0), 1),
            }
            for d, mu, lo, hi in zip(res.dates, res.mean, res.lower, res.upper, strict=True)
        ],
        "model": res.model,
        "mape": round(m, 2) if m is not None else None,
    }
