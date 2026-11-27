"""Python model entry points used by the registry tests."""

from __future__ import annotations

import asyncio
import time
from typing import Any


def echo(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    rows = ctx.db.fetch_all("SELECT count(*) AS n FROM fms.provinces")
    return {"echo": inputs, "provinces": rows[0]["n"], "model": ctx.name}


def echo_no_ctx(inputs: dict[str, Any]) -> dict[str, Any]:
    return {"keys": sorted(inputs)}


async def async_echo(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    rows = await ctx.db.afetch_all("SELECT 1 AS one")
    return {"one": rows[0]["one"], "x": inputs.get("x")}


def slow(inputs: dict[str, Any]) -> dict[str, Any]:
    time.sleep(float(inputs.get("sleep_s", 2)))
    return {"done": True}


async def slow_async(inputs: dict[str, Any]) -> dict[str, Any]:
    await asyncio.sleep(float(inputs.get("sleep_s", 2)))
    return {"done": True}


def bad_output(inputs: dict[str, Any]) -> list[int]:
    return [1, 2, 3]


def boom(inputs: dict[str, Any]) -> dict[str, Any]:
    raise RuntimeError("kaboom")


def try_write(inputs: dict[str, Any], ctx: Any) -> dict[str, Any]:
    ctx.db.fetch_all("CREATE TABLE fms.should_not_exist (id int)")
    return {"wrote": True}
