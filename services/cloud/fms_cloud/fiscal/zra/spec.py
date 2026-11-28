"""
============================================================================
 ZRA SMART INVOICE / VSDC PROTOCOL CONFIGURATION - VERIFY BEFORE GO-LIVE
============================================================================
Port of packages/zra-client/src/spec.ts. Everything here encodes assumptions about
the ZRA VSDC REST API (endpoint paths, result codes, code tables, VAT categories).
They MUST be verified against the current official ZRA VSDC specification and the
ZRA sandbox (docs/DESIGN.md section 12 item 2). Keep the values identical to spec.ts:
the edge gateways (TypeScript) use the same constants against the same VSDC.
============================================================================
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class VsdcPaths:
    selectInitInfo: str = "/initializer/selectInitInfo"
    saveItem: str = "/items/saveItem"
    saveStockItems: str = "/stock/saveStockItems"
    saveStockMaster: str = "/stockMaster/saveStockMaster"
    saveSales: str = "/trnsSales/saveSales"

    def all(self) -> list[str]:
        return [self.selectInitInfo, self.saveItem, self.saveStockItems, self.saveStockMaster, self.saveSales]


@dataclass(frozen=True)
class VsdcResultCodes:
    # Request succeeded.
    success: tuple[str, ...] = ("000",)
    # Device already initialised (selectInitInfo): treated as healthy.
    alreadyInitialised: tuple[str, ...] = ("902",)
    # Duplicate / overlapped invoice. Idempotent success if the response carries receipt data.
    duplicate: tuple[str, ...] = ("994",)
    # Transient VSDC-side failures (VSDC could not reach ZRA, internal error): retry later.
    retryable: tuple[str, ...] = ("891", "892", "893", "894", "899", "999")
    # Anything else is a non-retryable rejection (validation, device, TPIN errors).


@dataclass(frozen=True)
class VsdcSaleCodes:
    salesTyCd: str = "N"  # N = Normal
    rcptTyCd: str = "S"  # S = Sale
    salesSttsCd: str = "02"  # 02 = Approved
    qtyUnitCd: str = "LTR"  # litre
    pkgUnitCd: str = "NT"  # net (no packaging): fuel is sold loose
    currencyTyCd: str = "ZMW"
    exchangeRt: str = "1"
    saleCtyCd: str = "1"  # 1 = local sale
    prchrAcptcYn: str = "N"  # purchaser acceptance flag
    defaultCustomerName: str = "Walk-in customer"


@dataclass(frozen=True)
class VsdcSpec:
    paths: VsdcPaths = field(default_factory=VsdcPaths)
    resultCodes: VsdcResultCodes = field(default_factory=VsdcResultCodes)
    # FiscalSaleRequest.payment_type -> pmtTyCd
    paymentTypeCodes: dict[str, str] = field(
        default_factory=lambda: {"cash": "01", "credit": "02", "card": "05", "mobile_money": "06", "other": "08"}
    )
    sale: VsdcSaleCodes = field(default_factory=VsdcSaleCodes)
    # VAT categories in the order the VSDC expects the taxblAmtX / taxRtX / taxAmtX fields.
    vatCategories: tuple[str, ...] = ("A", "B", "C1", "C2", "C3", "D", "E", "RVAT")
    # Default VAT rate per category, in percent. Overridable per client.
    defaultVatRates: dict[str, float] = field(
        default_factory=lambda: {"A": 16, "B": 16, "C1": 0, "C2": 0, "C3": 0, "D": 0, "E": 0, "RVAT": 16}
    )
    # IANA time zone used for cfmDt / salesDt / resultDt.
    timeZone: str = "Africa/Lusaka"
    # Fixed UTC offset of timeZone, used to parse VSDC timestamps back to ISO (Zambia has no DST).
    utcOffset: str = "+02:00"


VSDC_SPEC = VsdcSpec()
