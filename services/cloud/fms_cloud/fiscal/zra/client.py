"""ZRA Smart Invoice client speaking to a VSDC (packages/zra-client/src/client.ts).

Implements the shared FiscalClient contract (sign_sale, health); idempotent on invoice_no
(cisInvcNo). Errors are FiscalError with the retryable flag and code set exactly like the
TypeScript client. Retries are the caller's job (the worker's job queue).
"""

from __future__ import annotations

import datetime as dt
import json
from typing import Any

import httpx

from fms_cloud.common.jsonutil import iso

from ..jscompat import js_dumps, js_str
from .errors import FiscalError
from .payload import BuildSaleOptions, build_sale_payload
from .spec import VSDC_SPEC, VsdcSpec
from .vsdctime import parse_vsdc_datetime

# Error codes set on FiscalError.code by this client.
ZRA_ERROR_CODES = {
    "TIMEOUT": "VSDC_TIMEOUT",
    "NETWORK": "VSDC_NETWORK",
    "HTTP_5XX": "VSDC_HTTP_5XX",
    "HTTP_4XX": "VSDC_HTTP_4XX",
    "BAD_RESPONSE": "VSDC_BAD_RESPONSE",
    "DUPLICATE_NO_DATA": "VSDC_DUPLICATE_NO_DATA",
    "INVALID_REQUEST": "VSDC_INVALID_REQUEST",
}


def _tpl(d: dict[str, Any], key: str) -> str:
    """`${obj.key}` (undefined / null rendered like JavaScript)."""
    return "undefined" if key not in d else js_str(d[key])


class ZraVsdcClient:
    def __init__(
        self,
        base_url: str,
        tpin: str,
        bhf_id: str,
        device_serial: str,
        timeout_ms: float = 15_000,
        http: httpx.Client | None = None,
        vat_rates: dict[str, float] | None = None,
        spec: VsdcSpec | None = None,
        cmc_key: str | None = None,
    ) -> None:
        if not base_url:
            raise TypeError("ZraVsdcClient: baseUrl is required")
        self.base_url = base_url.rstrip("/")
        self.tpin = tpin
        self.bhf_id = bhf_id
        self.device_serial = device_serial
        self.timeout_ms = timeout_ms
        self._http = http or httpx.Client()
        self.spec = spec or VSDC_SPEC
        self.vat_rates = {**self.spec.defaultVatRates, **(vat_rates or {})}
        self.cmc_key = cmc_key

    def close(self) -> None:
        self._http.close()

    # ------------------------------------------------------------------ API

    def initialize(self) -> dict[str, Any]:
        """selectInitInfo: device initialisation / info lookup."""
        res = self._post(self.spec.paths.selectInitInfo, {"tpin": self.tpin, "bhfId": self.bhf_id, "dvcSrlNo": self.device_serial})
        rc = self.spec.resultCodes
        if res["resultCd"] not in rc.success and res["resultCd"] not in rc.alreadyInitialised:
            raise self._rejection(res)
        return res

    def save_item(self, item: dict[str, Any]) -> dict[str, Any]:
        """saveItem: register a fuel item (fuel_grades.zra_item_code) with ZRA."""
        return self._expect_success(self._post(self.spec.paths.saveItem, {"tpin": self.tpin, "bhfId": self.bhf_id, **item}))

    def save_stock_items(self, req: dict[str, Any]) -> dict[str, Any]:
        """saveStockItems: report a stock movement (e.g. ATG-detected delivery)."""
        return self._expect_success(self._post(self.spec.paths.saveStockItems, {"tpin": self.tpin, "bhfId": self.bhf_id, **req}))

    def save_stock_master(self, req: dict[str, Any]) -> dict[str, Any]:
        """saveStockMaster: report the remaining stock quantity of an item."""
        return self._expect_success(self._post(self.spec.paths.saveStockMaster, {"tpin": self.tpin, "bhfId": self.bhf_id, **req}))

    def build_sale_payload(self, req: dict[str, Any]) -> dict[str, Any]:
        """Build (without sending) the saveSales payload."""
        return build_sale_payload(req, BuildSaleOptions(spec=self.spec, vat_rates=self.vat_rates, tpin=self.tpin, bhf_id=self.bhf_id))

    def sign_sale(self, req: dict[str, Any]) -> dict[str, Any]:
        """trnsSales/saveSales: sign a sale. Raises FiscalError (retryable flag set). Returns a FiscalSignature dict."""
        try:
            payload = self.build_sale_payload(req)
        except Exception as err:
            raise FiscalError(f"Invalid sale request: {err}", False, ZRA_ERROR_CODES["INVALID_REQUEST"]) from err
        res = self._post(self.spec.paths.saveSales, payload)
        rc = self.spec.resultCodes
        data = res.get("data")
        if res["resultCd"] in rc.success:
            if not _has_receipt(data):
                raise FiscalError(f"VSDC success without receipt data ({_tpl(res, 'resultMsg')})", True, ZRA_ERROR_CODES["BAD_RESPONSE"])
            return _to_signature(res, data)
        if res["resultCd"] in rc.duplicate:
            # Invoice already signed by ZRA (e.g. a previous attempt timed out after the VSDC committed it).
            if _has_receipt(data):
                return _to_signature(res, data)
            raise FiscalError(
                f"VSDC reports duplicate invoice {js_str(req.get('invoice_no'))} without receipt data "
                f"({res['resultCd']} {_tpl(res, 'resultMsg')}); manual retrieval required",
                False,
                ZRA_ERROR_CODES["DUPLICATE_NO_DATA"],
            )
        raise self._rejection(res)

    def health(self) -> dict[str, Any]:
        """Liveness of the VSDC: selectInitInfo must answer with success / already-initialised."""
        try:
            res = self.initialize()
            return {"ok": True, "detail": f"{res['resultCd']} {_tpl(res, 'resultMsg')}"}
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "detail": getattr(err, "message", None) or str(err)}

    # ------------------------------------------------------------- internals

    def _expect_success(self, res: dict[str, Any]) -> dict[str, Any]:
        if res["resultCd"] not in self.spec.resultCodes.success:
            raise self._rejection(res)
        return res

    def _rejection(self, res: dict[str, Any]) -> FiscalError:
        retryable = res["resultCd"] in self.spec.resultCodes.retryable
        return FiscalError(f"VSDC {res['resultCd']}: {_tpl(res, 'resultMsg')}", retryable, res["resultCd"])

    def _post(self, path: str, body: Any) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"content-type": "application/json", "accept": "application/json", "tpin": self.tpin, "bhfId": self.bhf_id}
        if self.cmc_key:
            headers["cmcKey"] = self.cmc_key
        try:
            resp = self._http.post(url, headers=headers, content=js_dumps(body).encode("utf-8"), timeout=self.timeout_ms / 1000)
            text = resp.content.decode("utf-8", errors="replace")
        except httpx.TimeoutException as err:
            raise FiscalError(f"VSDC timeout after {js_str(self.timeout_ms)} ms ({path})", True, ZRA_ERROR_CODES["TIMEOUT"]) from err
        except Exception as err:
            raise FiscalError(f"VSDC network error ({path}): {err}", True, ZRA_ERROR_CODES["NETWORK"]) from err
        status = resp.status_code
        ok = 200 <= status <= 299
        if status >= 500:
            raise FiscalError(f"VSDC HTTP {status} ({path})", True, ZRA_ERROR_CODES["HTTP_5XX"])
        if status in (408, 429):
            raise FiscalError(f"VSDC HTTP {status} ({path})", True, ZRA_ERROR_CODES["HTTP_4XX"])
        try:
            parsed = json.loads(text)
        except ValueError:
            raise FiscalError(f"VSDC returned non-JSON (HTTP {status}, {path})", ok, ZRA_ERROR_CODES["BAD_RESPONSE"]) from None
        if not isinstance(parsed, dict) or not isinstance(parsed.get("resultCd"), str):
            if not ok:
                raise FiscalError(f"VSDC HTTP {status} ({path})", False, ZRA_ERROR_CODES["HTTP_4XX"])
            raise FiscalError(f"VSDC response without resultCd ({path})", True, ZRA_ERROR_CODES["BAD_RESPONSE"])
        return parsed


def _has_receipt(d: Any) -> bool:
    if not isinstance(d, dict):
        return False
    sign = d.get("rcptSign")
    return d.get("rcptNo") is not None and isinstance(sign, str) and len(sign) > 0


def _to_signature(res: dict[str, Any], d: dict[str, Any]) -> dict[str, Any]:
    def s(v: Any) -> str | None:
        return None if v is None or v == "" else js_str(v)

    signed_at = parse_vsdc_datetime(d.get("vsdcRcptPbctDate")) or parse_vsdc_datetime(res.get("resultDt")) or iso(dt.datetime.now(dt.UTC))
    return {
        "receipt_no": js_str(d["rcptNo"]),
        "total_receipt_no": s(d.get("totRcptNo")),
        "internal_data": s(d.get("intrlData")),
        "signature": d["rcptSign"],
        "sdc_id": s(d.get("sdcId")),
        "mrc_no": s(d.get("mrcNo")),
        "qr_url": s(d.get("qrCodeUrl")),
        "signed_at": signed_at,
        "raw_response": res,
    }
