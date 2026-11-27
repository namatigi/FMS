"""ERB-style fuel price cost build-up (illustrative; parameters from PRICING_CONFIG)."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .errors import ApiError

MODEL_NAME = "erb_cost_buildup_v1"


class PricingRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    product_code: str = Field(..., min_length=2, max_length=16)
    fob_usd_per_mt: float | None = Field(None, ge=0)
    fx_rate: float | None = Field(None, gt=0, description="ZMW per USD")
    density_kg_l: float | None = Field(None, gt=0, lt=2)
    freight: float | None = Field(None, ge=0, description="Freight USD per metric tonne")
    insurance_pct: float | None = Field(None, ge=0, le=100)
    taxes: dict[str, float | dict[str, Any]] | None = None
    vat_pct: float | None = Field(None, ge=0, le=100)
    margins: dict[str, float] | None = None
    supply_chain: dict[str, float] | None = None


def load_pricing_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def simulate(req: PricingRequest, cfg: dict[str, Any]) -> dict[str, Any]:
    code = req.product_code.upper()
    products = cfg.get("products", {})
    if code not in products:
        raise ApiError(400, "unknown_product", f"No pricing defaults for product {code}")
    params = _merge(cfg, cfg.get("product_overrides", {}).get(code, {}))
    prod = products[code]

    fob = req.fob_usd_per_mt if req.fob_usd_per_mt is not None else float(prod["fob_usd_per_mt"])
    density = req.density_kg_l if req.density_kg_l is not None else float(prod["density_kg_l"])
    freight = req.freight if req.freight is not None else float(prod.get("freight_usd_per_mt", 0))
    ins_pct = req.insurance_pct if req.insurance_pct is not None else float(prod.get("insurance_pct", 0))
    fx = req.fx_rate if req.fx_rate is not None else float(params["fx_rate_zmw_per_usd"])

    lines: list[dict[str, Any]] = []

    def add(component: str, group: str, zmw: float, basis: str) -> None:
        lines.append({"component": component, "group": group, "zmw_per_l": round(zmw, 4), "basis": basis})

    l_per_mt = 1000.0 / density
    fob_l = fob / l_per_mt
    freight_l = freight / l_per_mt
    ins_l = (fob_l + freight_l) * ins_pct / 100
    add("fob", "landed_cost", fob_l * fx, f"{fob:.2f} USD/MT at {density} kg/L x FX {fx}")
    add("freight", "landed_cost", freight_l * fx, f"{freight:.2f} USD/MT")
    add("insurance", "landed_cost", ins_l * fx, f"{ins_pct}% of FOB+freight")
    cif_zmw = (fob_l + freight_l + ins_l) * fx

    supply = dict(params.get("supply_chain", {}))
    supply.update(req.supply_chain or {})
    for name, val in supply.items():
        add(name, "supply_chain", float(val), "ZMW/L")

    taxes: dict[str, dict[str, Any]] = {
        k: (dict(v) if isinstance(v, dict) else {"type": "per_litre", "value": float(v)})
        for k, v in params.get("taxes", {}).items()
    }
    for name, val in (req.taxes or {}).items():
        if isinstance(val, dict):
            taxes[name] = {"type": val.get("type", "per_litre"), "value": float(val.get("value", 0))}
        else:  # bare number keeps the configured type of an existing tax, else per-litre
            taxes[name] = {"type": taxes.get(name, {}).get("type", "per_litre"), "value": float(val)}
    for name, t in taxes.items():
        if t["type"] == "pct":
            add(name, "taxes_levies", cif_zmw * t["value"] / 100, f"{t['value']}% of CIF")
        elif t["type"] == "per_litre":
            add(name, "taxes_levies", float(t["value"]), "ZMW/L")
        else:
            raise ApiError(400, "invalid_tax", f"Tax {name}: type must be per_litre or pct")

    margins = dict(params.get("margins", {}))
    margins.update(req.margins or {})
    for name, val in margins.items():
        add(name, "margins", float(val), "ZMW/L")

    pre_vat = sum(x["zmw_per_l"] for x in lines)
    vat_pct = req.vat_pct if req.vat_pct is not None else float(params.get("vat_pct", 0))
    add("vat", "taxes_levies", pre_vat * vat_pct / 100, f"{vat_pct}% of pre-VAT price")
    total = sum(x["zmw_per_l"] for x in lines)

    return {
        "product_code": code,
        "indicative_price": round(total, 2),
        "currency": params.get("currency", "ZMW"),
        "unit": "per_litre",
        "breakdown": lines,
        "subtotals": {
            "landed_cost": round(cif_zmw, 4),
            "pre_vat": round(pre_vat, 4),
            "taxes_levies": round(sum(x["zmw_per_l"] for x in lines if x["group"] == "taxes_levies"), 4),
            "margins": round(sum(x["zmw_per_l"] for x in lines if x["group"] == "margins"), 4),
        },
        "assumptions": {
            "fob_usd_per_mt": fob,
            "fx_rate": fx,
            "density_kg_l": density,
            "freight_usd_per_mt": freight,
            "insurance_pct": ins_pct,
            "vat_pct": vat_pct,
        },
        "model": MODEL_NAME,
        "illustrative": True,
        "disclaimer": params.get("disclaimer", "Illustrative only; not official figures."),
    }
