"""FiscalSaleRequest -> VSDC trnsSales/saveSales payload (packages/zra-client/src/payload.ts).

Requests and lines are plain dicts with the FiscalSaleRequest / FiscalSaleLine field names
of packages/shared/src/fiscal.ts. Key order and number rounding match the TypeScript build
so the JSON sent to the VSDC is byte-identical.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..jscompat import EPSILON, js_round, js_sum
from .spec import VSDC_SPEC, VsdcSpec


def round2(n: float) -> float:
    return js_round((n + EPSILON) * 100) / 100


def round3(n: float) -> float:
    return js_round((n + EPSILON) * 1000) / 1000


def split_inclusive(total: float, rate_pct: float) -> dict[str, float]:
    """Split a tax-inclusive amount into taxable + VAT for the given rate (percent)."""
    taxable = round2(total / (1 + rate_pct / 100))
    return {"taxable": taxable, "tax": round2(total - taxable)}


def _rate_for(category: str, rates: dict[str, float]) -> float:
    if category not in rates or rates[category] is None:
        raise ValueError(f"No VAT rate configured for category '{category}'")
    return rates[category]


def vat_breakdown(lines: list[dict[str, Any]], rates: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """VAT breakdown per category for tax-inclusive sale lines: [{category, rate, taxable, tax, total}]."""
    rates = VSDC_SPEC.defaultVatRates if rates is None else rates
    by: dict[str, dict[str, Any]] = {}
    for line in lines:
        cat = line["vat_category"]
        rate = _rate_for(cat, rates)
        s = split_inclusive(line["total"], rate)
        b = by.get(cat) or {"category": cat, "rate": rate, "taxable": 0, "tax": 0, "total": 0}
        b["taxable"] = round2(b["taxable"] + s["taxable"])
        b["tax"] = round2(b["tax"] + s["tax"])
        b["total"] = round2(b["total"] + line["total"])
        by[cat] = b
    return list(by.values())


@dataclass
class BuildSaleOptions:
    spec: VsdcSpec | None = None
    vat_rates: dict[str, float] | None = None
    time_zone: str | None = None
    # Fallbacks when the request does not carry tpin / branch_id.
    tpin: str | None = None
    bhf_id: str | None = None
    # Used for regrId/modrId when the request has no cashier.
    system_user_id: str | None = None


def build_sale_payload(req: dict[str, Any], opts: BuildSaleOptions | None = None) -> dict[str, Any]:
    """Map an FMS FiscalSaleRequest onto the VSDC trnsSales/saveSales payload."""
    from .vsdctime import format_vsdc_date, format_vsdc_datetime

    opts = opts or BuildSaleOptions()
    spec = opts.spec or VSDC_SPEC
    rates = {**spec.defaultVatRates, **(opts.vat_rates or {})}
    tz = opts.time_zone if opts.time_zone is not None else spec.timeZone
    tpin = req.get("tpin") or opts.tpin
    bhf_id = req.get("branch_id") or opts.bhf_id
    if not tpin:
        raise TypeError("FiscalSaleRequest.tpin is required")
    if not bhf_id:
        raise TypeError("FiscalSaleRequest.branch_id is required")
    if not req.get("invoice_no"):
        raise TypeError("FiscalSaleRequest.invoice_no is required")
    lines = req["lines"]
    if not lines:
        raise TypeError("FiscalSaleRequest.lines must not be empty")

    pmt = spec.paymentTypeCodes.get(req.get("payment_type"))  # type: ignore[arg-type]
    pmt_ty_cd = pmt if pmt is not None else spec.paymentTypeCodes["other"]
    user = req.get("cashier_id") or opts.system_user_id or "FMS"

    item_list: list[dict[str, Any]] = []
    for i, line in enumerate(lines):
        rate = _rate_for(line["vat_category"], rates)
        s = split_inclusive(line["total"], rate)
        cls = line.get("item_class_code")
        item_list.append(
            {
                "itemSeq": i + 1,
                "itemCd": line["item_code"],
                "itemClsCd": "" if cls is None else cls,
                "itemNm": line["item_name"],
                "bcd": None,
                "pkgUnitCd": spec.sale.pkgUnitCd,
                "pkg": round3(line["qty"]),
                "qtyUnitCd": spec.sale.qtyUnitCd,
                "qty": round3(line["qty"]),
                "prc": round2(line["unit_price"]),
                "splyAmt": round2(line["total"]),
                "dcRt": 0,
                "dcAmt": 0,
                "vatCatCd": line["vat_category"],
                "vatTaxblAmt": s["taxable"],
                "vatAmt": s["tax"],
                "totAmt": round2(line["total"]),
            }
        )

    breakdown = vat_breakdown(lines, rates)
    per_cat: dict[str, float] = {}
    for cat in spec.vatCategories:
        b = next((x for x in breakdown if x["category"] == cat), None)
        per_cat[f"taxblAmt{cat}"] = b["taxable"] if b else 0
        r = rates.get(cat)
        per_cat[f"taxRt{cat}"] = r if r is not None else 0
        per_cat[f"taxAmt{cat}"] = b["tax"] if b else 0
    for b in breakdown:
        if b["category"] not in spec.vatCategories:
            per_cat[f"taxblAmt{b['category']}"] = b["taxable"]
            per_cat[f"taxRt{b['category']}"] = b["rate"]
            per_cat[f"taxAmt{b['category']}"] = b["tax"]

    sale_time = req["sale_time"]
    cust_tpin = req.get("customer_tpin")
    return {
        "tpin": tpin,
        "bhfId": bhf_id,
        "orgInvcNo": 0,
        "cisInvcNo": req["invoice_no"],
        "custTpin": cust_tpin,
        "custNm": req.get("customer_name") or spec.sale.defaultCustomerName,
        "salesTyCd": spec.sale.salesTyCd,
        "rcptTyCd": spec.sale.rcptTyCd,
        "pmtTyCd": pmt_ty_cd,
        "salesSttsCd": spec.sale.salesSttsCd,
        "cfmDt": format_vsdc_datetime(sale_time, tz),
        "salesDt": format_vsdc_date(sale_time, tz),
        "stockRlsDt": format_vsdc_datetime(sale_time, tz),
        "cnclReqDt": None,
        "cnclDt": None,
        "rfdDt": None,
        "rfdRsnCd": None,
        "totItemCnt": len(item_list),
        **per_cat,
        "totTaxblAmt": round2(js_sum(b["taxable"] for b in breakdown)),
        "totTaxAmt": round2(js_sum(b["tax"] for b in breakdown)),
        "totAmt": round2(js_sum(line["total"] for line in lines)),
        "prchrAcptcYn": spec.sale.prchrAcptcYn,
        "remark": None,
        "regrId": user,
        "regrNm": user,
        "modrId": user,
        "modrNm": user,
        "saleCtyCd": spec.sale.saleCtyCd,
        "currencyTyCd": spec.sale.currencyTyCd,
        "exchangeRt": spec.sale.exchangeRt,
        "itemList": item_list,
    }
