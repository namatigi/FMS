"""Byte-compatibility with the TypeScript packages. Expected values were produced by the
built packages (packages/zra-client/dist, packages/fiscal-printer/dist) under Node 20."""

from __future__ import annotations

import json

from fms_cloud.fiscal.config import load_config, parse_rates
from fms_cloud.fiscal.core import backoff_ms
from fms_cloud.fiscal.jscompat import js_dumps, js_number, js_round, js_str, to_fixed
from fms_cloud.fiscal.printer import render_receipt_text
from fms_cloud.fiscal.zra import BuildSaleOptions, build_invoice_no, build_sale_payload


def test_multi_line_sale_payload_matches_typescript():
    multi = {
        "tpin": "1000000001",
        "branch_id": "001",
        "invoice_no": "INV-M",
        "sale_time": "2026-11-27T08:15:30Z",
        "payment_type": "card",
        "cashier_id": "C7",
        "lines": [
            {
                "item_code": "X1",
                "item_class_code": None,
                "item_name": "Diesel",
                "qty": 33.3333,
                "unit_price": 29.999,
                "total": 999.995,
                "vat_category": "A",
            },
            {"item_code": "X2", "item_class_code": "c", "item_name": "Lub", "qty": 1, "unit_price": 100, "total": 100, "vat_category": "D"},
            {
                "item_code": "X3",
                "item_class_code": "c",
                "item_name": "Odd",
                "qty": 0.1,
                "unit_price": 0.3,
                "total": 0.03,
                "vat_category": "Z",
            },
        ],
    }
    expected = (
        '{"tpin":"1000000001","bhfId":"001","orgInvcNo":0,"cisInvcNo":"INV-M","custTpin":null,"custNm":"Walk-in customer","salesTyCd":"N",'
        '"rcptTyCd":"S","pmtTyCd":"05","salesSttsCd":"02","cfmDt":"20261127101530","salesDt":"20261127","stockRlsDt":"20261127101530",'
        '"cnclReqDt":null,"cnclDt":null,"rfdDt":null,"rfdRsnCd":null,"totItemCnt":3,"taxblAmtA":862.06,"taxRtA":16,"taxAmtA":137.94,'
        '"taxblAmtB":0,"taxRtB":16,"taxAmtB":0,"taxblAmtC1":0,"taxRtC1":0,"taxAmtC1":0,"taxblAmtC2":0,"taxRtC2":0,"taxAmtC2":0,'
        '"taxblAmtC3":0,"taxRtC3":0,"taxAmtC3":0,"taxblAmtD":100,"taxRtD":0,"taxAmtD":0,"taxblAmtE":0,"taxRtE":0,"taxAmtE":0,'
        '"taxblAmtRVAT":0,"taxRtRVAT":16,"taxAmtRVAT":0,"taxblAmtZ":0.03,"taxRtZ":7.5,"taxAmtZ":0,"totTaxblAmt":962.09,"totTaxAmt":137.94,'
        '"totAmt":1100.02,"prchrAcptcYn":"N","remark":null,"regrId":"C7","regrNm":"C7","modrId":"C7","modrNm":"C7","saleCtyCd":"1",'
        '"currencyTyCd":"ZMW","exchangeRt":"1","itemList":[{"itemSeq":1,"itemCd":"X1","itemClsCd":"","itemNm":"Diesel","bcd":null,'
        '"pkgUnitCd":"NT","pkg":33.333,"qtyUnitCd":"LTR","qty":33.333,"prc":30,"splyAmt":1000,"dcRt":0,"dcAmt":0,"vatCatCd":"A",'
        '"vatTaxblAmt":862.06,"vatAmt":137.94,"totAmt":1000},{"itemSeq":2,"itemCd":"X2","itemClsCd":"c","itemNm":"Lub","bcd":null,'
        '"pkgUnitCd":"NT","pkg":1,"qtyUnitCd":"LTR","qty":1,"prc":100,"splyAmt":100,"dcRt":0,"dcAmt":0,"vatCatCd":"D","vatTaxblAmt":100,'
        '"vatAmt":0,"totAmt":100},{"itemSeq":3,"itemCd":"X3","itemClsCd":"c","itemNm":"Odd","bcd":null,"pkgUnitCd":"NT","pkg":0.1,'
        '"qtyUnitCd":"LTR","qty":0.1,"prc":0.3,"splyAmt":0.03,"dcRt":0,"dcAmt":0,"vatCatCd":"Z","vatTaxblAmt":0.03,"vatAmt":0,"totAmt":0.03}]}'
    )
    assert js_dumps(build_sale_payload(multi, BuildSaleOptions(vat_rates={"Z": 7.5}))) == expected


def test_invoice_number_across_new_year_in_lusaka():
    assert build_invoice_no("LUS-0001", 3, 1234, "2026-12-31T22:59:59.999Z") == "LUS-0001-P3-1234-20270101005959"


def test_receipt_text_matches_fiscal_printer():
    doc = {
        "station_name": "Lusaka Central Filling Station",
        "station_address": "Cairo Road, Lusaka",
        "tpin": "1000000001",
        "invoice_no": "LUS-0001-P1-42-20261127101530",
        "sale_time": "2026-11-27T08:15:30.000Z",
        "pump_no": 1,
        "nozzle_no": 2,
        "attendant": "TAG-77",
        "lines": [
            {
                "item_code": "X",
                "item_class_code": None,
                "item_name": "Unleaded Petrol",
                "qty": 20.5,
                "unit_price": 31.85,
                "total": 652.93,
                "vat_category": "A",
            },
            {
                "item_code": "Y",
                "item_class_code": None,
                "item_name": "Engine Oil 1L",
                "qty": 1,
                "unit_price": 0.125,
                "total": 0.125,
                "vat_category": "B",
            },
        ],
        "total": 653.055,
        "vat_total": 90.08,
        "payment_type": "mobile_money",
        "signature": {
            "receipt_no": "7",
            "total_receipt_no": "7",
            "internal_data": "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ",
            "signature": "1A2B-3C4D-5E6F-7A8B",
            "sdc_id": "SDC00010001",
            "mrc_no": "MRC000100101",
            "qr_url": "http://127.0.0.1:9/qr?sdcId=SDC00010001&rcptNo=7&sign=1A2B-3C4D-5E6F-7A8B-very-long-signature-value",
            "signed_at": "2026-11-27T10:15:31+02:00",
            "raw_response": None,
        },
    }
    expected = json.loads(
        '"      Lusaka Central Filling Station\\n            Cairo Road, Lusaka\\n             TPIN: 1000000001\\n               TAX INVOICE\\n'
        "------------------------------------------\\nInvoice:     LUS-0001-P1-42-20261127101530\\nDate:                  27/11/2026 10:15:30\\n"
        "Pump/Nozzle:                           1/2\\nAttendant:                          TAG-77\\n------------------------------------------\\n"
        "Unleaded Petrol [A]\\n  20.500 L x 31.85                  652.93\\nEngine Oil 1L [B]\\n  1.000 L x 0.13                      0.13\\n"
        "------------------------------------------\\nTaxable A (16%)                     562.87\\nVAT A                                90.06\\n"
        "Taxable B (18%)                       0.11\\nVAT B                                 0.02\\nTotal VAT                            90.08\\n"
        "TOTAL ZMW                           653.05\\nPayment:                      MOBILE MONEY\\n==========================================\\n"
        "            ZRA SMART INVOICE\\nSDC ID:                        SDC00010001\\nReceipt No:                            7/7\\n"
        "Internal Data:\\nABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ\\nReceipt Signature:\\n1A2B-3C4D-5E6F-7A8B\\nMRC No:                       MRC000100101\\n"
        "Signed:                27/11/2026 10:15:31\\nQR:\\nhttp://127.0.0.1:9/qr?sdcId=SDC00010001&rc\\nptNo=7&sign=1A2B-3C4D-5E6F-7A8B-very-long-\\n"
        'signature-value\\n==========================================\\n         Thank you. Drive safely.\\n"'
    )
    assert render_receipt_text(doc, 42) == expected


def test_js_number_semantics():
    assert js_round(2.5) == 3 and js_round(-2.5) == -2 and js_round(0.49999999999999994) == 0
    assert to_fixed(0.125, 2) == "0.13" and to_fixed(653.055, 2) == "653.05" and to_fixed(-0.0, 2) == "0.00"
    assert js_str(652.0) == "652" and js_str(1e-7) == "1e-7" and js_str(None) == "null"
    assert js_number(" 12 ") == 12 and js_number("0x10") == 16 and js_number("") == 0
    assert js_number("12px") != js_number("12px")  # NaN
    assert js_dumps({"a": 1.0, "b": float("nan"), "c": [0.1]}) == '{"a":1,"b":null,"c":[0.1]}'


def test_backoff_grows_exponentially_with_jitter_and_is_capped():
    # services/fiscal-worker/src/test/integration.test.ts "backoff"
    assert backoff_ms(1, 1000, 60_000, lambda: 0) == 500
    assert backoff_ms(1, 1000, 60_000, lambda: 1) == 1000
    assert backoff_ms(4, 1000, 60_000, lambda: 1) == 8000
    assert backoff_ms(30, 1000, 60_000, lambda: 1) == 60_000


def test_config_parsing_and_validation():
    assert parse_rates("A=16, B=16,D=0") == {"A": 16, "B": 16, "D": 0}
    for bad in ("A", "A=x", "=5"):
        try:
            parse_rates(bad)
        except ValueError as e:
            assert "Invalid ZRA_VAT_RATES entry" in str(e)
        else:
            raise AssertionError(bad)
    cfg = load_config(
        {
            "DATABASE_URL": "postgres://x@y/z",
            "SCHEDULER_DAILY_AT": "01:30",
            "WORKER_CONCURRENCY": "0",
            "ZRA_VSDC_DEVICES": '{"1000000001:001": {"baseUrl": "http://vsdc", "deviceSerial": "D1"}}',
            "ZRA_VAT_RATES": "A=16",
        }
    )
    assert (cfg.scheduler.daily_at.hour, cfg.scheduler.daily_at.minute) == (1, 30)
    assert cfg.concurrency == 1 and cfg.batch_size == 10 and cfg.metrics_port == 9464
    assert cfg.zra.devices["1000000001:001"]["deviceSerial"] == "D1" and cfg.zra.vat_rates == {"A": 16}
    assert cfg.scheduler.time_zone == "Africa/Lusaka" and cfg.kinds == ["fiscalise", "rollup", "webhook", "notify", "erb_export"]
    for env, msg in (
        ({}, "DATABASE_URL is required"),
        ({"DATABASE_URL": "x", "WORKER_KINDS": "fiscalise,bogus"}, "Unknown job kind in WORKER_KINDS: bogus"),
        ({"DATABASE_URL": "x", "FISCAL_DEFAULT_PAYMENT_TYPE": "bitcoin"}, "Invalid FISCAL_DEFAULT_PAYMENT_TYPE: bitcoin"),
        ({"DATABASE_URL": "x", "JOB_TIMEOUT_MS": "soon"}, "Invalid number for JOB_TIMEOUT_MS: soon"),
    ):
        try:
            load_config(env)
        except ValueError as e:
            assert str(e) == msg
        else:
            raise AssertionError(env)
