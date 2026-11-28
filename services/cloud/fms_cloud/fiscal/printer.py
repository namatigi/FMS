"""Receipt archive: the `file` driver of packages/fiscal-printer with its plain-text renderer
(src/drivers/simple.ts FilePrinter, src/render.ts). Output is identical to the TypeScript
renderer, so archived receipts look the same whichever path signed them.

ReceiptDocument is a dict with the fields of packages/shared/src/fiscal.ts.
"""

from __future__ import annotations

import os
import re
from typing import Any

from .jscompat import js_round, js_str, parse_date, to_fixed
from .zra.vsdctime import zoned_parts

LUSAKA = "Africa/Lusaka"

PAYMENT_LABELS = {"cash": "CASH", "card": "CARD", "mobile_money": "MOBILE MONEY", "credit": "CREDIT", "other": "OTHER"}


def _money(n: float) -> str:
    return to_fixed(n, 2)


def _qty(n: float) -> str:
    return to_fixed(n, 3)


def format_sale_time(iso_s: str, time_zone: str | None = None) -> str:
    d = parse_date(iso_s)
    if d is None:
        return iso_s
    p = zoned_parts(d, time_zone or LUSAKA)
    return f"{p['d']}/{p['M']}/{p['y']} {p['H']}:{p['m']}:{p['s']}"


def vat_lines(doc: dict[str, Any], rates: dict[str, float] | None = None) -> list[dict[str, Any]]:
    """Tax-inclusive VAT split per category."""
    by: dict[str, dict[str, Any]] = {}
    for line in doc["lines"]:
        cat = line["vat_category"]
        e = by.get(cat) or {"total": 0, "rate": (rates or {}).get(cat)}
        e["total"] += line["total"]
        by[cat] = e
    out: list[dict[str, Any]] = []
    remaining = doc["vat_total"]
    entries = list(by.items())
    for i, (category, e) in enumerate(entries):
        if e["rate"] is not None:
            vat = js_round((e["total"] - e["total"] / (1 + e["rate"] / 100)) * 100) / 100
        elif len(entries) == 1:
            vat = doc["vat_total"]
        else:
            vat = remaining if i == len(entries) - 1 else js_round((doc["vat_total"] * (e["total"] / doc["total"])) * 100) / 100
        remaining = js_round((remaining - vat) * 100) / 100
        taxable = js_round((e["total"] - vat) * 100) / 100
        rate = e["rate"] if e["rate"] is not None else (js_round((vat / taxable) * 100) if taxable > 0 else 0)
        out.append({"category": category, "rate": rate, "taxable": taxable, "vat": vat})
    return out


def receipt_blocks(doc: dict[str, Any], opts: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Fuel-receipt content as blocks (text / rule / pair / qr / feed)."""
    opts = opts or {}
    cur = opts.get("currency") or "ZMW"
    tz = opts.get("timeZone")
    sig = doc["signature"]
    b: list[dict[str, Any]] = []
    b.append({"kind": "text", "text": doc["station_name"], "align": "center", "bold": True, "size": 2})
    if doc.get("station_address"):
        b.append({"kind": "text", "text": doc["station_address"], "align": "center"})
    b.append({"kind": "text", "text": f"TPIN: {doc['tpin']}", "align": "center"})
    b.append({"kind": "text", "text": "TAX INVOICE", "align": "center", "bold": True})
    b.append({"kind": "rule"})
    b.append({"kind": "pair", "left": "Invoice:", "right": doc["invoice_no"]})
    b.append({"kind": "pair", "left": "Date:", "right": format_sale_time(doc["sale_time"], tz)})
    b.append({"kind": "pair", "left": "Pump/Nozzle:", "right": f"{js_str(doc['pump_no'])}/{js_str(doc['nozzle_no'])}"})
    if doc.get("attendant"):
        b.append({"kind": "pair", "left": "Attendant:", "right": doc["attendant"]})
    b.append({"kind": "rule"})
    for line in doc["lines"]:
        b.append({"kind": "text", "text": f"{line['item_name']} [{line['vat_category']}]", "bold": True})
        b.append({"kind": "pair", "left": f"  {_qty(line['qty'])} L x {_money(line['unit_price'])}", "right": _money(line["total"])})
    b.append({"kind": "rule"})
    for v in vat_lines(doc, opts.get("vatRates")):
        b.append({"kind": "pair", "left": f"Taxable {v['category']} ({js_str(v['rate'])}%)", "right": _money(v["taxable"])})
        b.append({"kind": "pair", "left": f"VAT {v['category']}", "right": _money(v["vat"])})
    b.append({"kind": "pair", "left": "Total VAT", "right": _money(doc["vat_total"])})
    b.append({"kind": "pair", "left": f"TOTAL {cur}", "right": _money(doc["total"]), "bold": True})
    pt = doc["payment_type"]
    b.append({"kind": "pair", "left": "Payment:", "right": PAYMENT_LABELS.get(pt) or pt.upper()})
    b.append({"kind": "rule", "char": "="})
    b.append({"kind": "text", "text": "ZRA SMART INVOICE", "align": "center", "bold": True})
    if sig.get("sdc_id"):
        b.append({"kind": "pair", "left": "SDC ID:", "right": sig["sdc_id"]})
    rn = f"{sig['receipt_no']}/{sig['total_receipt_no']}" if sig.get("total_receipt_no") else sig["receipt_no"]
    b.append({"kind": "pair", "left": "Receipt No:", "right": rn})
    if sig.get("internal_data"):
        b.append({"kind": "text", "text": "Internal Data:"})
        b.append({"kind": "text", "text": sig["internal_data"]})
    b.append({"kind": "text", "text": "Receipt Signature:"})
    b.append({"kind": "text", "text": sig["signature"]})
    if sig.get("mrc_no"):
        b.append({"kind": "pair", "left": "MRC No:", "right": sig["mrc_no"]})
    b.append({"kind": "pair", "left": "Signed:", "right": format_sale_time(sig["signed_at"], tz)})
    if sig.get("qr_url"):
        b.append({"kind": "qr", "data": sig["qr_url"]})
    b.append({"kind": "rule", "char": "="})
    footer = opts.get("footer")
    for f in footer if footer is not None else ["Thank you. Drive safely."]:
        b.append({"kind": "text", "text": f, "align": "center"})
    return b


_WS = re.compile(r"\s+")


def wrap(text: str, width: int) -> list[str]:
    """Hard-wrap text to width (breaks long words such as signatures)."""
    out: list[str] = []
    for para in text.split("\n"):
        line = ""
        for word in [w for w in _WS.split(para) if w]:
            w = word
            while len(w) > width:
                if line:
                    out.append(line)
                    line = ""
                out.append(w[:width])
                w = w[width:]
            if not line:
                line = w
            elif len(line) + 1 + len(w) <= width:
                line += f" {w}"
            else:
                out.append(line)
                line = w
        out.append(line)
    return out


def align_line(text: str, width: int, align: str = "left") -> str:
    if len(text) >= width or align == "left":
        return text
    pad = width - len(text)
    return " " * pad + text if align == "right" else " " * (pad // 2) + text


def pair_lines(left: str, right: str, width: int) -> list[str]:
    """Left/right justified pair; wraps the right side onto its own line when it does not fit."""
    if len(left) + 1 + len(right) <= width:
        return [left + " " * (width - len(left) - len(right)) + right]
    return [*wrap(left, width), *[align_line(r, width, "right") for r in wrap(right, width)]]


def render_receipt_text(doc: dict[str, Any], width: int = 42, opts: dict[str, Any] | None = None) -> str:
    """Plain-text fuel receipt (monospace, `width` columns; 42 = 80 mm paper, 32 = 58 mm)."""
    lines: list[str] = []
    for blk in receipt_blocks(doc, opts):
        k = blk["kind"]
        if k == "text":
            for ln in wrap(blk["text"], width):
                lines.append(align_line(ln, width, blk.get("align") or "left"))
        elif k == "rule":
            lines.append((blk.get("char") or "-") * width)
        elif k == "pair":
            lines.extend(pair_lines(blk["left"], blk["right"], width))
        elif k == "qr":
            lines.extend(wrap(f"QR: {blk['data']}", width))
        elif k == "feed":
            lines.extend([""] * blk["lines"])
    return "\n".join(re.sub(r"\s+$", "", ln) for ln in lines) + "\n"


def safe_file_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", s)


class FilePrinter:
    """Writes each receipt to <dir>/<invoice>.txt (digital receipt archive / print-spooler pick-up).

    Only the default `text` format of the TypeScript driver is ported (the worker never used `escpos`).
    """

    def __init__(self, directory: str, width: int | None = None, render: dict[str, Any] | None = None) -> None:
        if not directory:
            raise TypeError("file printer: dir is required")
        self.dir = directory
        self.width = width
        self.render = render

    def print(self, doc: dict[str, Any]) -> None:
        os.makedirs(self.dir, exist_ok=True)
        base = os.path.join(self.dir, safe_file_name(doc["invoice_no"]))
        width = self.width or (self.render or {}).get("width") or 42
        with open(f"{base}.txt", "wb") as f:
            f.write(render_receipt_text(doc, width, self.render).encode("utf-8"))

    def status(self) -> dict[str, Any]:
        try:
            os.makedirs(self.dir, exist_ok=True)
            if not os.access(self.dir, os.W_OK):
                raise PermissionError(f"EACCES: permission denied, access '{self.dir}'")
            return {"online": True, "paper": "ok"}
        except OSError as err:
            return {"online": False, "paper": "unknown", "detail": str(err)}


def create_printer(cfg: dict[str, Any]) -> FilePrinter:
    """createPrinter for the `file` driver: {"driver": "file", "dir": ...}."""
    if cfg.get("driver") != "file":
        raise ValueError(f"Unknown printer driver '{cfg.get('driver')}' (only 'file' is available in the cloud worker)")
    if cfg.get("format") not in (None, "text"):
        raise ValueError("file printer: only format 'text' is supported in the cloud worker")
    return FilePrinter(cfg.get("dir", ""), cfg.get("width"), cfg.get("render"))
