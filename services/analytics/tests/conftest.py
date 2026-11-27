from __future__ import annotations

import asyncio
import os
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import jwt
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

TEST_DSN = os.environ.get("TEST_DATABASE_URL", "postgres://postgres@localhost:55432/fms_analytics")
SECRET = "test-secret-analytics"
os.environ.setdefault("DATABASE_URL", TEST_DSN)
os.environ["JWT_SECRET"] = SECRET
os.environ.setdefault("LOG_LEVEL", "WARNING")

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import generate_history  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from fms_analytics.config import Settings  # noqa: E402
from fms_analytics.main import create_app  # noqa: E402

ZAMBEZI = "11111111-1111-1111-1111-111111111111"
COPPER = "22222222-2222-2222-2222-222222222222"
LUS_0001 = "aaaaaaaa-0000-0000-0000-000000000001"
CEN_0001 = "aaaaaaaa-0000-0000-0000-000000000002"
COP_0001 = "aaaaaaaa-0000-0000-0000-000000000003"


@pytest.fixture(scope="session")
def injected() -> dict[str, Any]:
    return generate_history.generate(TEST_DSN, days=180, seed=42)


@pytest.fixture(scope="session")
def client(injected: dict[str, Any]) -> Iterator[TestClient]:
    settings = Settings.from_env()
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def make_token(
    role: str,
    *,
    sub: str = "00000000-0000-0000-0000-000000000001",
    company_id: str | None = None,
    province_id: int | None = None,
    exp_in: int = 900,
    secret: str = SECRET,
) -> str:
    now = int(time.time())
    claims = {
        "sub": sub,
        "role": role,
        "company_id": company_id,
        "province_id": province_id,
        "name": f"Test {role}",
        "iat": now,
        "exp": now + exp_in,
    }
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture(scope="session")
def manager_id(client: TestClient) -> str:
    import psycopg

    with psycopg.connect(TEST_DSN) as conn:
        row = conn.execute("SELECT id::text FROM fms.users WHERE email = 'manager@zambezi.local'").fetchone()
    assert row
    return row[0]


@pytest.fixture(scope="session")
def auth() -> Callable[..., dict[str, str]]:
    def _h(role: str = "erb_national", **kw: Any) -> dict[str, str]:
        return {"Authorization": f"Bearer {make_token(role, **kw)}"}

    return _h
