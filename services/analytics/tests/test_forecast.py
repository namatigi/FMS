from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from fms_analytics.forecasting import backtest_mape, fit_forecast, forecast_payload, prepare_series

URL = "/analytics/v1/forecast/demand"


def _check_shape(body: dict, horizon: int) -> None:
    assert set(body) == {"history", "forecast", "model", "mape"}
    assert len(body["forecast"]) == horizon
    assert body["history"], "history must not be empty"
    last_hist = date.fromisoformat(body["history"][-1]["date"])
    assert date.fromisoformat(body["forecast"][0]["date"]) == last_hist + timedelta(days=1)
    for pt in body["forecast"]:
        assert set(pt) == {"date", "value", "lower", "upper"}
        assert 0 <= pt["lower"] <= pt["value"] <= pt["upper"]
    for pt in body["history"]:
        assert set(pt) == {"date", "value"}


@pytest.mark.parametrize("product", ["PETROL", "DIESEL"])
def test_national_forecast(client, auth, product):
    r = client.get(URL, params={"product_code": product, "horizon_days": 14}, headers=auth())
    assert r.status_code == 200, r.text
    body = r.json()
    _check_shape(body, 14)
    assert body["model"] == "holt_winters_additive_weekly"
    assert body["mape"] is not None and body["mape"] < 10, body["mape"]
    print(f"\nnational {product} MAPE={body['mape']}%")


@pytest.mark.parametrize("province", [2, 5, 9])
def test_provincial_forecast(client, auth, province):
    r = client.get(
        URL, params={"province_id": province, "product_code": "PETROL", "horizon_days": 30}, headers=auth()
    )
    assert r.status_code == 200
    body = r.json()
    _check_shape(body, 30)
    assert body["mape"] is not None and body["mape"] < 15
    print(f"\nprovince {province} PETROL MAPE={body['mape']}%")


def test_provincial_user_forced_to_own_province(client, auth):
    own = client.get(URL, params={"province_id": 2, "product_code": "DIESEL"}, headers=auth()).json()
    forced = client.get(
        URL,
        params={"province_id": 5, "product_code": "DIESEL"},
        headers=auth("erb_provincial", province_id=2),
    ).json()
    assert forced["history"] == own["history"]


def test_forecast_cache(client, auth):
    cache = client.app.state.forecast_cache
    params = {"product_code": "KEROSENE", "horizon_days": 7}
    client.get(URL, params=params, headers=auth())
    n = len(cache)
    r2 = client.get(URL, params=params, headers=auth())
    assert r2.status_code == 200 and len(cache) == n
    assert any(k[2] == "KEROSENE" and k[3] == 7 for k in cache._data)


def test_unknown_product_empty(client, auth):
    body = client.get(URL, params={"product_code": "JETA1"}, headers=auth()).json()
    assert body == {"history": [], "forecast": [], "model": "none", "mape": None}


def test_invalid_horizon(client, auth):
    r = client.get(URL, params={"horizon_days": 0}, headers=auth())
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


# ---------------------------------------------------------------- pure functions
def _synthetic(n: int, seed: int = 1) -> pd.Series:
    rng = np.random.default_rng(seed)
    days = pd.date_range("2026-01-01", periods=n, freq="D")
    week = np.array([1.0, 0.95, 0.97, 1.0, 1.15, 1.1, 0.85])
    vals = 1000 * week[days.dayofweek] * (1 + 0.001 * np.arange(n)) * rng.normal(1, 0.03, n)
    return prepare_series(list(zip(days.date, vals, strict=True)))


def test_fallbacks_for_short_history():
    assert fit_forecast(_synthetic(5), 7).model == "historical_mean"
    assert fit_forecast(_synthetic(14), 7).model == "seasonal_naive_weekly"
    assert fit_forecast(_synthetic(60), 7).model == "holt_winters_additive_weekly"
    assert backtest_mape(_synthetic(15)) is None
    m = backtest_mape(_synthetic(120))
    assert m is not None and m < 6


def test_gaps_are_interpolated():
    s = prepare_series([(date(2026, 1, 1), 10.0), (date(2026, 1, 4), 40.0)])
    assert list(s.values) == [10.0, 20.0, 30.0, 40.0]


def test_payload_short_history():
    body = forecast_payload(_synthetic(10), 5, 90)
    assert body["model"] == "seasonal_naive_weekly" and len(body["forecast"]) == 5 and body["mape"] is None
