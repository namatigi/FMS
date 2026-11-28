"""Port of packages/zra-client/src/client.test.ts."""

from __future__ import annotations

import re

import httpx
import pytest

from fms_cloud.fiscal.jscompat import js_dumps
from fms_cloud.fiscal.zra import (
    ZRA_ERROR_CODES,
    BuildSaleOptions,
    FiscalError,
    ZraVsdcClient,
    build_invoice_no,
    build_sale_payload,
    format_vsdc_date,
    format_vsdc_datetime,
    parse_vsdc_datetime,
    split_inclusive,
)
from fms_cloud.fiscal.zra.mock import start_mock_vsdc


def sale(invoice_no: str, **overrides):
    s = {
        "tpin": "1000000001",
        "branch_id": "001",
        "invoice_no": invoice_no,
        "sale_time": "2026-11-27T08:15:30Z",  # 10:15:30 in Lusaka
        "payment_type": "mobile_money",
        "lines": [
            {
                "item_code": "ZM1NTLTR0000001",
                "item_class_code": "15101500",
                "item_name": "Unleaded Petrol",
                "qty": 20.5,
                "unit_price": 31.85,
                "total": 652.93,
                "vat_category": "A",
            }
        ],
    }
    s.update(overrides)
    return s


# ---------------------------------------------------------------- time + payload helpers


def test_formats_vsdc_dates_in_lusaka():
    assert format_vsdc_datetime("2026-11-27T22:30:00Z") == "20261128003000"
    assert format_vsdc_date("2026-11-27T22:30:00Z") == "20261128"
    assert parse_vsdc_datetime("20261128003000") == "2026-11-28T00:30:00+02:00"
    assert parse_vsdc_datetime("bad") is None


def test_builds_deterministic_invoice_numbers():
    assert build_invoice_no("CEN-0001", 2, 4711, "2026-11-27T08:15:30.123Z") == "CEN-0001-P2-4711-20261127101530"


def test_maps_sale_to_save_sales_payload_with_tax_inclusive_vat():
    p = build_sale_payload(sale("INV-1"))
    assert p["cisInvcNo"] == "INV-1"
    assert p["pmtTyCd"] == "06"
    assert p["salesTyCd"] == "N"
    assert p["rcptTyCd"] == "S"
    assert p["salesSttsCd"] == "02"
    assert p["cfmDt"] == "20261127101530"
    assert p["salesDt"] == "20261127"
    assert p["totItemCnt"] == 1
    s = split_inclusive(652.93, 16)
    taxable, tax = s["taxable"], s["tax"]
    assert taxable == 562.87
    assert tax == 90.06
    assert p["taxblAmtA"] == taxable
    assert p["taxAmtA"] == tax
    assert p["taxRtA"] == 16
    assert p["taxblAmtB"] == 0
    assert p["totTaxblAmt"] == taxable
    assert p["totTaxAmt"] == tax
    assert p["totAmt"] == 652.93
    item = p["itemList"][0]
    assert {k: item[k] for k in ("itemSeq", "itemCd", "qtyUnitCd", "qty", "prc", "vatCatCd", "vatTaxblAmt", "vatAmt", "totAmt")} == {
        "itemSeq": 1,
        "itemCd": "ZM1NTLTR0000001",
        "qtyUnitCd": "LTR",
        "qty": 20.5,
        "prc": 31.85,
        "vatCatCd": "A",
        "vatTaxblAmt": taxable,
        "vatAmt": tax,
        "totAmt": 652.93,
    }


def test_honours_configurable_vat_rates():
    p = build_sale_payload(sale("INV-2"), BuildSaleOptions(vat_rates={"A": 0}))
    assert p["totTaxAmt"] == 0
    assert p["totTaxblAmt"] == 652.93


def test_sale_payload_json_is_byte_compatible_with_typescript():
    # JSON.stringify(buildSalePayload(sale('INV-1'))) from packages/zra-client (key order and number rendering).
    expected = (
        '{"tpin":"1000000001","bhfId":"001","orgInvcNo":0,"cisInvcNo":"INV-1","custTpin":null,"custNm":"Walk-in customer",'
        '"salesTyCd":"N","rcptTyCd":"S","pmtTyCd":"06","salesSttsCd":"02","cfmDt":"20261127101530","salesDt":"20261127",'
        '"stockRlsDt":"20261127101530","cnclReqDt":null,"cnclDt":null,"rfdDt":null,"rfdRsnCd":null,"totItemCnt":1,'
        '"taxblAmtA":562.87,"taxRtA":16,"taxAmtA":90.06,"taxblAmtB":0,"taxRtB":16,"taxAmtB":0,"taxblAmtC1":0,"taxRtC1":0,"taxAmtC1":0,'
        '"taxblAmtC2":0,"taxRtC2":0,"taxAmtC2":0,"taxblAmtC3":0,"taxRtC3":0,"taxAmtC3":0,"taxblAmtD":0,"taxRtD":0,"taxAmtD":0,'
        '"taxblAmtE":0,"taxRtE":0,"taxAmtE":0,"taxblAmtRVAT":0,"taxRtRVAT":16,"taxAmtRVAT":0,"totTaxblAmt":562.87,"totTaxAmt":90.06,'
        '"totAmt":652.93,"prchrAcptcYn":"N","remark":null,"regrId":"FMS","regrNm":"FMS","modrId":"FMS","modrNm":"FMS","saleCtyCd":"1",'
        '"currencyTyCd":"ZMW","exchangeRt":"1","itemList":[{"itemSeq":1,"itemCd":"ZM1NTLTR0000001","itemClsCd":"15101500",'
        '"itemNm":"Unleaded Petrol","bcd":null,"pkgUnitCd":"NT","pkg":20.5,"qtyUnitCd":"LTR","qty":20.5,"prc":31.85,"splyAmt":652.93,'
        '"dcRt":0,"dcAmt":0,"vatCatCd":"A","vatTaxblAmt":562.87,"vatAmt":90.06,"totAmt":652.93}]}'
    )
    assert js_dumps(build_sale_payload(sale("INV-1"))) == expected


# ------------------------------------------------------------ client against mock VSDC


@pytest.fixture(scope="module")
def mock():
    m = start_mock_vsdc()
    yield m
    m.close()


@pytest.fixture(scope="module")
def client(mock):
    c = ZraVsdcClient(base_url=mock.url, tpin="1000000001", bhf_id="001", device_serial="DVC-TEST-1", timeout_ms=5000)
    c.health()  # warm up the HTTP connection pool
    return c


@pytest.fixture(scope="module")
def fast_client(mock):
    return ZraVsdcClient(base_url=mock.url, tpin="1000000001", bhf_id="001", device_serial="DVC-TEST-1", timeout_ms=500)


@pytest.fixture(autouse=True)
def _reset(request):
    if "mock" in request.fixturenames:
        request.getfixturevalue("mock").reset()


def test_initialises_and_reports_healthy(client, mock):
    init = client.initialize()
    assert init["resultCd"] == "000"
    assert client.health() == {"ok": True, "detail": "000 It is succeeded"}


def test_registers_an_item(client, mock):
    client.save_item(
        {
            "itemCd": "ZM1NTLTR0000001",
            "itemClsCd": "15101500",
            "itemTyCd": "2",
            "itemNm": "Unleaded Petrol",
            "orgnNatCd": "ZM",
            "pkgUnitCd": "NT",
            "qtyUnitCd": "LTR",
            "vatCatCd": "A",
            "dftPrc": 31.85,
            "useYn": "Y",
            "regrId": "FMS",
            "regrNm": "FMS",
            "modrId": "FMS",
            "modrNm": "FMS",
        }
    )
    assert mock.state()["items"] == ["ZM1NTLTR0000001"]


def test_signs_a_sale(client, mock):
    sig = client.sign_sale(sale("CEN-0001-P1-1-20261127101530"))
    assert sig["receipt_no"] == "1"
    assert re.fullmatch(r"[0-9A-F]{4}(-[0-9A-F]{4}){3}", sig["signature"])
    assert sig["internal_data"]
    assert sig["sdc_id"] and sig["sdc_id"].startswith("SDC0")
    assert sig["mrc_no"]
    assert sig["qr_url"] and sig["qr_url"].startswith(mock.url)
    assert sig["signed_at"].endswith("+02:00")


def test_is_idempotent_on_invoice_no(client, mock):
    a = client.sign_sale(sale("INV-IDEMP"))
    b = client.sign_sale(sale("INV-IDEMP"))
    assert b["receipt_no"] == a["receipt_no"]
    assert b["signature"] == a["signature"]
    assert b["raw_response"]["resultCd"] == "994"
    assert len(mock.state()["receipts"]) == 1


def test_timeout_is_retryable_and_retry_recovers_receipt(client, fast_client, mock):
    mock.fail("timeout", 1)
    with pytest.raises(FiscalError) as ei:
        fast_client.sign_sale(sale("INV-TIMEOUT"))
    assert ei.value.retryable is True
    assert ei.value.code == ZRA_ERROR_CODES["TIMEOUT"]
    sig = client.sign_sale(sale("INV-TIMEOUT"))
    assert sig["receipt_no"] == "1"


def test_maps_5xx_to_retryable_and_rejects_to_non_retryable(client, mock):
    mock.fail("5xx", 1)
    with pytest.raises(FiscalError) as e1:
        client.sign_sale(sale("INV-5XX"))
    assert e1.value.retryable and e1.value.code == ZRA_ERROR_CODES["HTTP_5XX"]
    mock.fail("reject", 1)
    with pytest.raises(FiscalError) as e2:
        client.sign_sale(sale("INV-REJ"))
    assert not e2.value.retryable and e2.value.code == "910"
    mock.fail("vsdc_error", 1)
    with pytest.raises(FiscalError) as e3:
        client.sign_sale(sale("INV-894"))
    assert e3.value.retryable and e3.value.code == "894"


def test_duplicate_without_receipt_data_is_non_retryable(client, mock):
    client.sign_sale(sale("INV-DUP"))
    mock.fail("duplicate_nodata", 1)
    with pytest.raises(FiscalError) as ei:
        client.sign_sale(sale("INV-DUP"))
    assert not ei.value.retryable and ei.value.code == ZRA_ERROR_CODES["DUPLICATE_NO_DATA"]


def test_connection_refused_is_retryable_network_error():
    dead = ZraVsdcClient(base_url="http://127.0.0.1:1", tpin="1", bhf_id="000", device_serial="x", timeout_ms=500)
    with pytest.raises(FiscalError) as ei:
        dead.sign_sale(sale("INV-NET"))
    assert ei.value.retryable and ei.value.code in (ZRA_ERROR_CODES["NETWORK"], ZRA_ERROR_CODES["TIMEOUT"])
    assert dead.health()["ok"] is False


def test_failure_injection_over_http_control_endpoint(client, mock):
    r = httpx.get(f"{mock.url}/__mock/fail?mode=5xx&count=2")
    assert r.status_code == 200
    with pytest.raises(FiscalError):
        client.sign_sale(sale("INV-CTL"))
    with pytest.raises(FiscalError):
        client.sign_sale(sale("INV-CTL"))
    sig = client.sign_sale(sale("INV-CTL"))
    assert sig["receipt_no"] == "1"
