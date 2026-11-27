from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from fms_analytics.analytics import robust_z

URL = "/analytics/v1/anomalies"
KEYS = {"station_id", "business_date", "product_code", "variance_l", "variance_pct", "zscore", "kind"}


def _get(client, auth, **params):
    r = client.get(URL, params=params, headers=auth())
    assert r.status_code == 200, r.text
    return r.json()


def test_detects_injected(client, auth, injected):
    rows = _get(client, auth)
    for row in rows:
        assert KEYS <= set(row)
        assert row["kind"] in {"stock_loss", "totalizer", "price"}
    got = {(x["kind"], x["station_id"], x.get("product_code"), x["business_date"]) for x in rows}
    for a in injected["stock_loss"]:
        assert ("stock_loss", a["station_id"], a["product_code"], a["business_date"]) in got, a
    for a in injected["price"]:
        assert ("price", a["station_id"], a["product_code"], a["business_date"]) in got, a
    for a in injected["totalizer"]:
        assert ("totalizer", a["station_id"], "PETROL", a["business_date"]) in got, a

    losses = [x for x in rows if x["kind"] == "stock_loss"]
    assert all(abs(x["zscore"]) > 3.5 for x in losses)
    injected_keys = {(a["station_id"], a["product_code"], a["business_date"]) for a in injected["stock_loss"]}
    false_pos = [
        x for x in losses if (x["station_id"], x["product_code"], x["business_date"]) not in injected_keys
    ]
    print(f"\nanomalies: {len(rows)} rows; stock_loss {len(losses)} (false positives {len(false_pos)})")
    assert len(false_pos) <= 5
    tot = [x for x in rows if x["kind"] == "totalizer"]
    assert all(x["variance_l"] and x["variance_l"] > 0 for x in tot)


def test_province_override_cap_respected(client, auth):
    """Lusaka PETROL sells above the national cap but below the Lusaka-specific cap: not flagged."""
    rows = _get(client, auth)
    prices = [x for x in rows if x["kind"] == "price"]
    assert prices
    assert len(prices) <= 3
    for x in prices:
        assert x["variance_pct"] > 0 and x["details"]["avg_price"] > x["details"]["cap_price"]


def test_window_and_scope(client, auth, injected):
    some = injected["stock_loss"][0]
    d = some["business_date"]
    rows = client.get(URL, params={"from": d, "to": d}, headers=auth()).json()
    assert rows and all(x["business_date"] == d for x in rows)
    prov = client.get(URL, params={"province_id": 7}, headers=auth("erb_provincial", province_id=2)).json()
    assert all(x["province_id"] == 2 for x in prov)
    bad = client.get(URL, params={"from": "2026-02-01", "to": "2026-01-01"}, headers=auth())
    assert bad.status_code == 400
    old = (date.today() - timedelta(days=300)).isoformat()
    assert client.get(URL, params={"from": old, "to": old}, headers=auth()).json() == []


def test_robust_z():
    x = np.array([0.1, 0.2, 0.15, 0.18, 0.22, 0.19, 5.0])
    z = robust_z(x)
    assert abs(z[-1]) > 3.5 and np.all(np.abs(z[:-1]) < 3.5)
    assert np.all(robust_z(np.ones(10)) == 0)
