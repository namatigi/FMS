from __future__ import annotations

from datetime import date, timedelta

import pytest
from conftest import CEN_0001, COP_0001, LUS_0001, ZAMBEZI

STOCKOUT = "/analytics/v1/forecast/stockout"
RESERVE = "/analytics/v1/reserve/national"
KEYS = {
    "station_id",
    "station_name",
    "product_code",
    "stock_l",
    "avg_daily_sales_l",
    "days_of_cover",
    "predicted_stockout_date",
    "risk",
}


def test_stockout_shape_and_bands(client, auth, injected):
    r = client.get(STOCKOUT, headers=auth())
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 70
    for row in rows:
        assert KEYS <= set(row)
        doc = row["days_of_cover"]
        assert doc is not None
        assert row["risk"] == ("high" if doc < 2 else "medium" if doc < 5 else "low")
        assert row["days_of_cover"] == pytest.approx(row["stock_l"] / row["avg_daily_sales_l"], abs=0.01)
        expected = date.today() + timedelta(days=int(doc))
        assert abs((date.fromisoformat(row["predicted_stockout_date"]) - expected).days) <= 1
    by_key = {(x["station_id"], x["product_code"]): x for x in rows}
    for low in injected["low_stock"]:
        assert by_key[(low["station_id"], low["product_code"])]["risk"] == low["band"]
    # sorted by days of cover ascending
    docs = [x["days_of_cover"] for x in rows]
    assert docs == sorted(docs)


def test_stockout_filters(client, auth):
    rows = client.get(STOCKOUT, params={"province_id": 9, "product_code": "diesel"}, headers=auth()).json()
    assert rows and all(x["province_id"] == 9 and x["product_code"] == "DIESEL" for x in rows)
    rows = client.get(STOCKOUT, params={"station_id": COP_0001}, headers=auth()).json()
    assert {x["station_id"] for x in rows} == {COP_0001}
    assert client.get(STOCKOUT, params={"station_id": "nope"}, headers=auth()).status_code == 422


def test_stockout_owner_scope(client, auth):
    h = auth("owner", company_id=ZAMBEZI)
    rows = client.get(STOCKOUT, headers=h).json()
    assert rows
    own = client.get(STOCKOUT, params={"station_id": CEN_0001}, headers=h)
    assert own.status_code == 200 and {x["station_id"] for x in own.json()} == {CEN_0001}
    other = client.get(STOCKOUT, params={"station_id": COP_0001}, headers=h)
    assert other.status_code == 403
    assert COP_0001 not in {x["station_id"] for x in rows}


def test_stockout_manager_scope(client, auth, manager_id):
    h = auth("manager", sub=manager_id, company_id=ZAMBEZI)
    rows = client.get(STOCKOUT, headers=h).json()
    assert {x["station_id"] for x in rows} == {LUS_0001}
    assert client.get(STOCKOUT, params={"station_id": CEN_0001}, headers=h).status_code == 403
    assert client.get(STOCKOUT, params={"station_id": LUS_0001}, headers=h).status_code == 200


def test_stockout_provincial_forced(client, auth):
    rows = client.get(
        STOCKOUT, params={"province_id": 5}, headers=auth("erb_provincial", province_id=2)
    ).json()
    assert rows and {x["province_id"] for x in rows} == {2}
    r = client.get(STOCKOUT, params={"station_id": LUS_0001}, headers=auth("erb_provincial", province_id=2))
    assert r.status_code == 403


def test_reserve_national(client, auth):
    r = client.get(RESERVE, headers=auth())
    assert r.status_code == 200
    body = r.json()
    assert {"as_of", "by_product"} <= set(body)
    prods = {p["product_code"]: p for p in body["by_product"]}
    assert {"PETROL", "DIESEL", "KEROSENE"} <= set(prods)
    for p in prods.values():
        assert {
            "product_code",
            "stock_l",
            "capacity_l",
            "avg_daily_demand_l",
            "days_of_cover",
            "risk",
            "by_province",
        } <= set(p)
        d = p["days_of_cover"]
        assert p["risk"] == ("critical" if d < 3 else "high" if d < 7 else "medium" if d < 15 else "low")
        assert p["stock_l"] == pytest.approx(p["station_stock_l"] + p["depot_stock_l"], abs=1)
        assert p["stock_l"] == pytest.approx(
            sum(x["stock_l"] for x in p["by_province"])
            + sum(x["volume_l"] for x in p["depots"] if x["province_id"] is None),
            abs=5,
        )
    diesel = prods["DIESEL"]
    assert diesel["depot_stock_l"] == pytest.approx(2_000_000)
    assert len(diesel["by_province"]) == 10
    cop = next(x for x in diesel["by_province"] if x["province_id"] == 2)
    assert cop["depot_stock_l"] == pytest.approx(900_000)
    assert cop["province_name"] == "Copperbelt"
    print(f"\nreserve days_of_cover: { {k: v['days_of_cover'] for k, v in prods.items()} }")


def test_reserve_provincial_scope(client, auth):
    body = client.get(RESERVE, headers=auth("erb_provincial", province_id=5)).json()
    for p in body["by_product"]:
        assert {x["province_id"] for x in p["by_province"]} == {5}
        assert all(d["province_id"] == 5 for d in p["depots"])
