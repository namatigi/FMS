"""HTTP routes, base path /analytics/v1 (see docs/api/CONTRACTS.md, section analytics)."""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from . import analytics
from .auth import Principal, require_regulator, require_regulator_or_station
from .config import business_today
from .errors import ApiError
from .pricing import PricingRequest, simulate

router = APIRouter(prefix="/analytics/v1")

ProductQ = Query(None, min_length=2, max_length=16, pattern=r"^[A-Za-z0-9_]+$")
ProvinceQ = Query(None, ge=1, le=32767)


def _product(code: str | None) -> str | None:
    return code.upper() if code else None


@router.get("/forecast/demand")
async def forecast_demand(
    request: Request,
    province_id: int | None = ProvinceQ,
    product_code: str | None = ProductQ,
    horizon_days: int = Query(14, ge=1, le=90),
    history_days: int = Query(90, ge=7, le=400),
    p: Principal = Depends(require_regulator),
) -> dict[str, Any]:
    st = request.app.state
    return await analytics.demand_forecast(
        st.db,
        st.forecast_cache,
        p.scoped_province(province_id),
        _product(product_code),
        horizon_days,
        history_days,
    )


@router.get("/forecast/stockout")
async def forecast_stockout(
    request: Request,
    province_id: int | None = ProvinceQ,
    product_code: str | None = ProductQ,
    station_id: str | None = Query(None),
    p: Principal = Depends(require_regulator_or_station),
) -> list[dict[str, Any]]:
    if station_id is not None:
        try:
            station_id = str(uuid.UUID(station_id))
        except ValueError as exc:
            raise ApiError(422, "invalid_station_id", "station_id must be a UUID") from exc
    return await analytics.stockout(
        request.app.state.db, p, p.scoped_province(province_id), _product(product_code), station_id
    )


@router.get("/reserve/national")
async def reserve_national(
    request: Request,
    province_id: int | None = ProvinceQ,
    p: Principal = Depends(require_regulator),
) -> dict[str, Any]:
    return await analytics.national_reserve(request.app.state.db, p.scoped_province(province_id))


@router.get("/anomalies")
async def get_anomalies(
    request: Request,
    province_id: int | None = ProvinceQ,
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    p: Principal = Depends(require_regulator),
) -> list[dict[str, Any]]:
    end = to or business_today() - timedelta(days=1)
    start = from_ or end - timedelta(days=29)
    if start > end:
        raise ApiError(400, "invalid_range", "'from' must be on or before 'to'")
    if (end - start).days > 366:
        raise ApiError(400, "invalid_range", "Window may not exceed 366 days")
    return await analytics.anomalies(request.app.state.db, p.scoped_province(province_id), start, end)


@router.post("/pricing/simulate")
async def pricing_simulate(
    request: Request, body: PricingRequest, p: Principal = Depends(require_regulator)
) -> dict[str, Any]:
    st = request.app.state
    result = simulate(body, st.pricing_config)
    result["custom_model"] = None
    if st.registry.available("pricing"):
        extra = body.model_extra or {}
        inputs = {"product_code": result["product_code"], "horizon_days": int(extra.get("horizon_days", 30))}
        try:
            result["custom_model"] = await st.registry.predict("pricing", inputs)
        except ApiError as exc:
            result["custom_model"] = {"model": "pricing", "error": {"code": exc.code, "message": exc.message}}
    return result


@router.get("/models")
async def list_models(request: Request, p: Principal = Depends(require_regulator)) -> dict[str, Any]:
    return {"items": request.app.state.registry.list(), "next_cursor": None}


class PredictBody(BaseModel):
    inputs: dict[str, Any] = Field(default_factory=dict)


@router.post("/models/{name}/predict")
async def model_predict(
    name: str, request: Request, body: PredictBody, p: Principal = Depends(require_regulator)
) -> dict[str, Any]:
    return await request.app.state.registry.predict(name, body.inputs)
