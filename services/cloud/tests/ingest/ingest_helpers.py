"""ingest-api test helpers (port of services/ingest-api/test/helpers.ts)."""

from __future__ import annotations

import datetime as dt
import gzip
import json
import secrets
import uuid
from dataclasses import dataclass, replace
from typing import Any

from fms_cloud.common.crypto import sha256_hex
from fms_cloud.common.jsonutil import iso

SEED: dict[str, dict[str, str]] = {
    "lus": {
        "stationId": "aaaaaaaa-0000-0000-0000-000000000001",
        "code": "LUS-0001",
        "ptsId": "003B00265030500420303531",
        "secret": "devsecret-lus-0001",
        "gw": "GW-LUS-0001",
        "gwKey": "gwLUS001.dev-gateway-key-lus-0001",
    },
    "cen": {"stationId": "aaaaaaaa-0000-0000-0000-000000000002", "code": "CEN-0001", "ptsId": "003B00265030500420303532"},
}

EDGE_URL = "/ingest/v1/edge/batches"
PTS_URL = "/ingest/pts"


@dataclass(frozen=True)
class Fixture:
    stationId: str
    code: str
    ptsId: str
    gw: str
    gwKey: str

    def but(self, **kw: Any) -> Fixture:
        return replace(self, **kw)


LUS = Fixture(**{k: SEED["lus"][k] for k in ("stationId", "code", "ptsId", "gw", "gwKey")})


def now_utc() -> dt.datetime:
    d = dt.datetime.now(dt.UTC)
    return d.replace(microsecond=(d.microsecond // 1000) * 1000)


def iso_ago(ms: int) -> str:
    """new Date(Date.now() - ms).toISOString()"""
    return iso(now_utc() - dt.timedelta(milliseconds=ms))


def pts_local(d: dt.datetime) -> str:
    """PTS-2 local wall-clock string (Africa/Lusaka, UTC+2, no offset) for an instant."""
    return (d.astimezone(dt.UTC) + dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")


def random_recent() -> dt.datetime:
    """Random instant in the last ~20 days, second precision."""
    d = now_utc() - dt.timedelta(seconds=3600 + secrets.randbelow(20 * 86400 - 3600))
    return d.replace(microsecond=0)


def random_tx_no() -> int:
    return 1 + secrets.randbelow(2_000_000_000 - 1)


def create_fixture_station(db, mode: str = "edge", hmac_secret: str | None = None) -> Fixture:
    """Isolated station (2 tanks, 2 grades, 2 pumps x 2 nozzles, one controller, one gateway)."""
    suffix = secrets.token_hex(4).upper()
    code = f"TST-{suffix}"
    pts_id = f"FF{secrets.token_hex(11).upper()}"
    gw = f"GW-{code}"
    gw_key = f"tst.{secrets.token_hex(16)}"
    station_id = db.scalar(
        """INSERT INTO fms.stations (company_id, code, name, province_id, connection_mode)
     VALUES ('11111111-1111-1111-1111-111111111111', $1, $2, 5, $3) RETURNING id""",
        [code, f"Test station {suffix}", mode],
    )
    db.execute("INSERT INTO fms.controllers (station_id, pts_id, hmac_secret) VALUES ($1, $2, $3)", [station_id, pts_id, hmac_secret])
    db.execute(
        "INSERT INTO fms.edge_gateways (station_id, gateway_code, api_key_hash) VALUES ($1, $2, $3)", [station_id, gw, sha256_hex(gw_key)]
    )
    db.execute(
        """INSERT INTO fms.tanks (station_id, tank_no, product_code, capacity_l, low_level_l)
     VALUES ($1, 1, 'PETROL', 30000, 6000), ($1, 2, 'DIESEL', 40000, 8000)""",
        [station_id],
    )
    db.execute(
        """INSERT INTO fms.fuel_grades (station_id, pts_grade_id, name, product_code, price)
     VALUES ($1, 1, 'Unleaded Petrol', 'PETROL', 31.85), ($1, 2, 'Diesel LSD', 'DIESEL', 29.95)""",
        [station_id],
    )
    db.execute(
        """INSERT INTO fms.nozzles (station_id, pump_no, nozzle_no, fuel_grade_id, tank_id)
     SELECT $1, p.no, n.no, g.id, t.id
       FROM (VALUES (1),(2)) p(no) CROSS JOIN (VALUES (1),(2)) n(no)
       JOIN fms.fuel_grades g ON g.station_id = $1 AND g.pts_grade_id = n.no
       JOIN fms.tanks t ON t.station_id = $1 AND t.tank_no = n.no""",
        [station_id],
    )
    return Fixture(stationId=station_id, code=code, ptsId=pts_id, gw=gw, gwKey=gw_key)


def edge_batch(f: Fixture, records: list[dict[str, Any]]) -> dict[str, Any]:
    return {"gateway_code": f.gw, "station_code": f.code, "batch_id": str(uuid.uuid4()), "sent_at": iso(now_utc()), "records": records}


def edge_headers(f: Fixture) -> dict[str, str]:
    return {"authorization": f"Bearer {f.gwKey}", "x-gateway-code": f.gw}


def gz(o: Any) -> bytes:
    return gzip.compress(json.dumps(o).encode())


def post(client, url: str, body: Any, headers: dict[str, str] | None = None, content_type: str = "application/json"):
    data = body if isinstance(body, (bytes, str)) else json.dumps(body)
    return client.generic("POST", url, data, content_type=content_type, headers=headers or {})


def pump_tx(pts_id: str, **o: Any) -> dict[str, Any]:
    return {
        "kind": "pump_transaction",
        "data": {
            "pts_id": pts_id,
            "pts_transaction_no": random_tx_no(),
            "pump_no": 1,
            "nozzle_no": 1,
            "pts_grade_id": 1,
            "grade_name": "Unleaded Petrol",
            "started_at": None,
            "ended_at": iso(now_utc()),
            "volume_l": 20,
            "tc_volume_l": None,
            "price": 31.85,
            "amount": 637,
            "total_volume_l": None,
            "total_amount": None,
            "tag": None,
            "pts_user_id": None,
            **o,
        },
    }


def tank_measurement(pts_id: str, **o: Any) -> dict[str, Any]:
    return {
        "kind": "tank_measurement",
        "data": {
            "pts_id": pts_id,
            "tank_no": 1,
            "measured_at": iso(now_utc()),
            "pts_grade_id": 1,
            "probe_status": "OK",
            "alarms": [],
            "product_height_mm": 1200,
            "water_height_mm": 3,
            "temperature_c": 24.5,
            "product_volume_l": 15000,
            "water_volume_l": 10,
            "ullage_l": 15000,
            "tc_volume_l": 14900,
            "density_kg_m3": 740,
            "mass_kg": 11100,
            **o,
        },
    }
