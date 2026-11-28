"""In-process mock ZRA VSDC for development and tests (packages/zra-client/src/mock.ts).

Endpoints (see spec.py): selectInitInfo, saveItem, saveStockItems, saveStockMaster, saveSales.
Behaviour:
  - deterministic receipt numbers (sequential per tpin+bhfId) and signatures (HMAC of the invoice);
  - idempotent on cisInvcNo: a repeat returns resultCd '994' (duplicate) WITH the original receipt data;
  - basic payload validation -> resultCd '910';
  - failure injection via GET/POST /__mock/fail?mode=timeout|5xx|reject|duplicate_nodata|vsdc_error&count=N
    (or MockVsdc.fail());
  - GET /__mock/state (counters, receipts), POST /__mock/reset, GET /healthz.

    mock = start_mock_vsdc()          # ephemeral port on 127.0.0.1
    mock.url, mock.fail("5xx", 1), mock.state(), mock.reset(), mock.close()
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import math
import re
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Self
from urllib.parse import parse_qs, quote, urlsplit

from ..jscompat import js_dumps, js_number, js_round, js_str, js_sum, js_truthy
from .spec import VSDC_SPEC
from .vsdctime import format_vsdc_datetime

FAIL_MODES = ["timeout", "5xx", "reject", "duplicate_nodata", "vsdc_error"]
_D14 = re.compile(r"[0-9]{14}")
_D8 = re.compile(r"[0-9]{8}")


def _encode_uri_component(s: str) -> str:
    return quote(s, safe="-_.!~*'()")


class MockVsdc:
    def __init__(
        self,
        port: int = 0,
        host: str = "127.0.0.1",
        signing_key: str = "mock-vsdc-signing-key",
        fail_mode: str | None = None,
        fail_count: int = 0,
        now: Callable[[], dt.datetime] | None = None,
        log: Callable[..., None] | None = None,
    ) -> None:
        self._signing_key = signing_key
        self._initial_fail = (fail_mode, fail_count)
        self._now = now or (lambda: dt.datetime.now(dt.UTC))
        self._log = log or (lambda *a, **k: None)
        self._lock = threading.RLock()
        self._closing = threading.Event()
        self._counters: dict[str, int] = {}
        self._state: dict[str, Any] = {}
        self.reset()

        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def _any(self) -> None:
                mock._handle(self)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _any

        self._server = ThreadingHTTPServer((host, port), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        h = host if host not in ("0.0.0.0", "::", "") else "127.0.0.1"
        self.url = f"http://{h}:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, name="mock-vsdc", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------ control

    def reset(self) -> None:
        with self._lock:
            mode, count = self._initial_fail
            self._state = {"requests": {}, "receipts": {}, "items": [], "fail": {"mode": mode, "remaining": count}}
            if self._state["fail"]["mode"] and self._state["fail"]["remaining"] <= 0:
                self._state["fail"]["remaining"] = math.inf
            self._counters.clear()

    def fail(self, mode: str | None, count: float = 1) -> None:
        """Programmatic failure injection (same as /__mock/fail). count <= 0 means forever."""
        with self._lock:
            self._state["fail"] = {"mode": mode, "remaining": count if count > 0 else math.inf} if mode else {"mode": None, "remaining": 0}

    def state(self) -> dict[str, Any]:
        return self._state

    def close(self) -> None:
        self._closing.set()  # releases held ('timeout') requests without answering
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------ helpers

    def _sign(self, s: str, length: int = 16) -> str:
        return hmac.new(self._signing_key.encode(), s.encode(), hashlib.sha256).hexdigest()[:length].upper()

    @staticmethod
    def _group(s: str) -> str:
        return "-".join(s[i : i + 4] for i in range(0, len(s), 4))

    def _take_failure(self) -> str | None:
        with self._lock:
            f = self._state["fail"]
            if not f["mode"] or f["remaining"] <= 0:
                return None
            f["remaining"] -= 1
            m = f["mode"]
            if f["remaining"] <= 0:
                f["mode"] = None
            return m

    # ------------------------------------------------------------ http

    def _send(self, h: BaseHTTPRequestHandler, status: int, body: Any) -> None:
        text = js_dumps(body).encode("utf-8")
        h.send_response(status)
        h.send_header("content-type", "application/json")
        h.send_header("content-length", str(len(text)))
        h.end_headers()
        if h.command != "HEAD":
            h.wfile.write(text)

    def _vsdc(self, h: BaseHTTPRequestHandler, result_cd: str, result_msg: str, data: Any = None) -> None:
        self._send(h, 200, {"resultCd": result_cd, "resultMsg": result_msg, "resultDt": format_vsdc_datetime(self._now()), "data": data})

    def _hold(self, h: BaseHTTPRequestHandler) -> None:
        # Never answer; the connection is dropped when the mock closes.
        self._closing.wait()
        h.close_connection = True

    def _handle(self, h: BaseHTTPRequestHandler) -> None:
        try:
            u = urlsplit(h.path)
            path = u.path
            qs = parse_qs(u.query, keep_blank_values=True)
            if path == "/healthz":
                return self._send(h, 200, {"ok": True})
            if path == "/__mock/state":
                with self._lock:
                    return self._send(h, 200, self._state)
            if path == "/__mock/reset":
                self.reset()
                return self._send(h, 200, {"ok": True})
            if path == "/__mock/fail":
                mode = qs["mode"][0] if "mode" in qs else None
                with self._lock:
                    if mode == "none" or mode is None:
                        self._state["fail"] = {"mode": None, "remaining": 0}
                    elif mode in FAIL_MODES:
                        count = js_number(qs["count"][0] if "count" in qs else "1")
                        self._state["fail"] = {"mode": mode, "remaining": count if count > 0 else math.inf}
                    else:
                        return self._send(h, 400, {"error": f"unknown mode {mode}", "modes": FAIL_MODES})
                    return self._send(h, 200, {"ok": True, "fail": self._state["fail"]})
            if h.command != "POST":
                return self._send(h, 405, {"error": "method not allowed"})

            length = int(h.headers.get("content-length") or 0)
            raw = h.rfile.read(length).decode("utf-8") if length else ""
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                return self._vsdc(h, "911", "There is no request full text")
            if not isinstance(body, dict):
                body = {}
            with self._lock:
                self._state["requests"][path] = self._state["requests"].get(path, 0) + 1
            self._log("mock-vsdc request", {"path": path, "cisInvcNo": body.get("cisInvcNo")})

            p = VSDC_SPEC.paths
            if path not in p.all():
                return self._send(h, 404, {"error": "not found"})

            failure = self._take_failure()
            if failure == "5xx":
                return self._send(h, 503, {"error": "injected 5xx"})
            if failure == "reject":
                return self._vsdc(h, "910", "Request parameter error (injected)")
            if failure == "vsdc_error":
                return self._vsdc(h, "894", "Unable to connect to the server (injected)")
            if failure == "timeout" and path != p.saveSales:
                return self._hold(h)

            if path == p.selectInitInfo:
                if not js_truthy(body.get("tpin")) or not js_truthy(body.get("bhfId")) or not js_truthy(body.get("dvcSrlNo")):
                    return self._vsdc(h, "910", "Request parameter error")
                tpin, bhf = js_str(body["tpin"]), js_str(body["bhfId"])
                return self._vsdc(
                    h,
                    "000",
                    "It is succeeded",
                    {
                        "info": {
                            "tpin": body["tpin"],
                            "taxprNm": "MOCK TAXPAYER",
                            "bhfId": body["bhfId"],
                            "bhfNm": f"Branch {bhf}",
                            "sdcId": f"SDC0{bhf}{tpin[-4:]}",
                            "mrcNo": f"MRC{tpin[-4:]}{bhf}01",
                            "dvcSrlNo": body["dvcSrlNo"],
                            "lastSaleInvcNo": self._counters.get(f"{tpin}:{bhf}", 0),
                        }
                    },
                )
            if path == p.saveItem:
                if not js_truthy(body.get("itemCd")) or not js_truthy(body.get("itemNm")):
                    return self._vsdc(h, "910", "Request parameter error")
                with self._lock:
                    if js_str(body["itemCd"]) not in self._state["items"]:
                        self._state["items"].append(js_str(body["itemCd"]))
                return self._vsdc(h, "000", "It is succeeded")
            if path in (p.saveStockItems, p.saveStockMaster):
                return self._vsdc(h, "000", "It is succeeded")
            if path == p.saveSales:
                return self._handle_sale(h, body, failure)
            return self._send(h, 404, {"error": "not found"})
        except Exception as err:  # noqa: BLE001
            try:
                self._send(h, 500, {"error": str(err)})
            except Exception:  # noqa: BLE001, S110
                pass

    def _handle_sale(self, h: BaseHTTPRequestHandler, body: dict[str, Any], failure: str | None) -> None:
        errors: list[str] = []
        if not js_truthy(body.get("tpin")):
            errors.append("tpin")
        if not js_truthy(body.get("bhfId")):
            errors.append("bhfId")
        if not js_truthy(body.get("cisInvcNo")):
            errors.append("cisInvcNo")
        cfm = body.get("cfmDt")
        if not _D14.fullmatch("" if cfm is None else js_str(cfm)):
            errors.append("cfmDt")
        sdt = body.get("salesDt")
        if not _D8.fullmatch("" if sdt is None else js_str(sdt)):
            errors.append("salesDt")
        items = body.get("itemList")
        if not isinstance(items, list) or len(items) == 0:
            errors.append("itemList")
        else:
            if body.get("totItemCnt") != len(items) or isinstance(body.get("totItemCnt"), bool):
                errors.append("totItemCnt")
            total = js_sum(js_number(i.get("totAmt") if isinstance(i, dict) else None) for i in items)
            s = js_round(total * 100) / 100
            if abs(s - js_number(body.get("totAmt"))) > 0.01:
                errors.append("totAmt")
        if errors:
            return self._vsdc(h, "910", f"Request parameter error: {', '.join(errors)}")

        tpin, bhf = js_str(body["tpin"]), js_str(body["bhfId"])
        key = f"{tpin}:{bhf}:{js_str(body['cisInvcNo'])}"
        with self._lock:
            existing = self._state["receipts"].get(key)
            if existing is None:
                ck = f"{tpin}:{bhf}"
                rcpt_no = self._counters.get(ck, 0) + 1
                self._counters[ck] = rcpt_no
                sdc_id = f"SDC0{bhf}{tpin[-4:]}"
                rcpt_sign = self._group(self._sign(f"sign:{key}:{rcpt_no}"))
                receipt = {
                    "rcptNo": rcpt_no,
                    "intrlData": self._group(self._sign(f"intrl:{key}:{rcpt_no}", 26)),
                    "rcptSign": rcpt_sign,
                    "totRcptNo": rcpt_no,
                    "vsdcRcptPbctDate": format_vsdc_datetime(self._now()),
                    "sdcId": sdc_id,
                    "mrcNo": f"MRC{tpin[-4:]}{bhf}01",
                    "qrCodeUrl": f"{self.url}/qr?sdcId={_encode_uri_component(sdc_id)}&rcptNo={rcpt_no}&sign={_encode_uri_component(rcpt_sign)}",
                }
                self._state["receipts"][key] = receipt
        if existing is not None:
            if failure == "duplicate_nodata":
                return self._vsdc(h, "994", "Overlapped data")
            return self._vsdc(h, "994", "Overlapped data", existing)
        # 'timeout' after commit simulates the worst case: ZRA signed it but the client never saw the answer.
        if failure == "timeout":
            return self._hold(h)
        return self._vsdc(h, "000", "It is succeeded", receipt)


def start_mock_vsdc(port: int = 0, host: str = "127.0.0.1", **kw: Any) -> MockVsdc:
    """startMockVsdc: start the mock on host:port (0 = ephemeral) and return its handle."""
    return MockVsdc(port=port, host=host, **kw)
