import type { ReceiptDocument } from '@fms/shared';

const LUSAKA = 'Africa/Lusaka';

export interface RenderOptions {
  /** IANA zone used to print the sale time (default Africa/Lusaka). */
  timeZone?: string;
  /** Currency label (default ZMW). */
  currency?: string;
  /** VAT rates (percent) per category to print in the breakdown; derived from amounts when absent. */
  vatRates?: Record<string, number>;
  /** Footer lines printed after the fiscal block. */
  footer?: string[];
}

/** Structured receipt content: rendered as plain text, or as ESC/POS with styling + QR. */
export type ReceiptBlock =
  | { kind: 'text'; text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; size?: 1 | 2 }
  | { kind: 'rule'; char?: string }
  | { kind: 'pair'; left: string; right: string; bold?: boolean }
  | { kind: 'qr'; data: string }
  | { kind: 'feed'; lines: number };

const money = (n: number) => n.toFixed(2);
const qty = (n: number) => n.toFixed(3);

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'CASH',
  card: 'CARD',
  mobile_money: 'MOBILE MONEY',
  credit: 'CREDIT',
  other: 'OTHER',
};

export function formatSaleTime(iso: string, timeZone = LUSAKA): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) p[x.type] = x.value;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** Tax-inclusive VAT split per category. */
export function vatLines(doc: ReceiptDocument, rates?: Record<string, number>) {
  const by = new Map<string, { total: number; rate: number | null }>();
  for (const l of doc.lines) {
    const e = by.get(l.vat_category) ?? { total: 0, rate: rates?.[l.vat_category] ?? null };
    e.total += l.total;
    by.set(l.vat_category, e);
  }
  const out: Array<{ category: string; rate: number | null; taxable: number; vat: number }> = [];
  let remainingVat = doc.vat_total;
  const entries = [...by.entries()];
  entries.forEach(([category, e], i) => {
    let vat: number;
    if (e.rate !== null) vat = Math.round((e.total - e.total / (1 + e.rate / 100)) * 100) / 100;
    else if (entries.length === 1) vat = doc.vat_total;
    else vat = i === entries.length - 1 ? remainingVat : Math.round((doc.vat_total * (e.total / doc.total)) * 100) / 100;
    remainingVat = Math.round((remainingVat - vat) * 100) / 100;
    const taxable = Math.round((e.total - vat) * 100) / 100;
    const rate = e.rate ?? (taxable > 0 ? Math.round((vat / taxable) * 100) : 0);
    out.push({ category, rate, taxable, vat });
  });
  return out;
}

/** Build the fuel-receipt content as blocks (shared by the text and ESC/POS renderers). */
export function receiptBlocks(doc: ReceiptDocument, opts: RenderOptions = {}): ReceiptBlock[] {
  const cur = opts.currency ?? 'ZMW';
  const sig = doc.signature;
  const b: ReceiptBlock[] = [];
  b.push({ kind: 'text', text: doc.station_name, align: 'center', bold: true, size: 2 });
  if (doc.station_address) b.push({ kind: 'text', text: doc.station_address, align: 'center' });
  b.push({ kind: 'text', text: `TPIN: ${doc.tpin}`, align: 'center' });
  b.push({ kind: 'text', text: 'TAX INVOICE', align: 'center', bold: true });
  b.push({ kind: 'rule' });
  b.push({ kind: 'pair', left: 'Invoice:', right: doc.invoice_no });
  b.push({ kind: 'pair', left: 'Date:', right: formatSaleTime(doc.sale_time, opts.timeZone) });
  b.push({ kind: 'pair', left: 'Pump/Nozzle:', right: `${doc.pump_no}/${doc.nozzle_no}` });
  if (doc.attendant) b.push({ kind: 'pair', left: 'Attendant:', right: doc.attendant });
  b.push({ kind: 'rule' });
  for (const l of doc.lines) {
    b.push({ kind: 'text', text: `${l.item_name} [${l.vat_category}]`, bold: true });
    b.push({ kind: 'pair', left: `  ${qty(l.qty)} L x ${money(l.unit_price)}`, right: money(l.total) });
  }
  b.push({ kind: 'rule' });
  for (const v of vatLines(doc, opts.vatRates)) {
    b.push({ kind: 'pair', left: `Taxable ${v.category} (${v.rate}%)`, right: money(v.taxable) });
    b.push({ kind: 'pair', left: `VAT ${v.category}`, right: money(v.vat) });
  }
  b.push({ kind: 'pair', left: 'Total VAT', right: money(doc.vat_total) });
  b.push({ kind: 'pair', left: `TOTAL ${cur}`, right: money(doc.total), bold: true });
  b.push({ kind: 'pair', left: 'Payment:', right: PAYMENT_LABELS[doc.payment_type] ?? doc.payment_type.toUpperCase() });
  b.push({ kind: 'rule', char: '=' });
  b.push({ kind: 'text', text: 'ZRA SMART INVOICE', align: 'center', bold: true });
  if (sig.sdc_id) b.push({ kind: 'pair', left: 'SDC ID:', right: sig.sdc_id });
  b.push({ kind: 'pair', left: 'Receipt No:', right: sig.total_receipt_no ? `${sig.receipt_no}/${sig.total_receipt_no}` : sig.receipt_no });
  if (sig.internal_data) {
    b.push({ kind: 'text', text: 'Internal Data:' });
    b.push({ kind: 'text', text: sig.internal_data });
  }
  b.push({ kind: 'text', text: 'Receipt Signature:' });
  b.push({ kind: 'text', text: sig.signature });
  if (sig.mrc_no) b.push({ kind: 'pair', left: 'MRC No:', right: sig.mrc_no });
  b.push({ kind: 'pair', left: 'Signed:', right: formatSaleTime(sig.signed_at, opts.timeZone) });
  if (sig.qr_url) b.push({ kind: 'qr', data: sig.qr_url });
  b.push({ kind: 'rule', char: '=' });
  for (const f of opts.footer ?? ['Thank you. Drive safely.']) b.push({ kind: 'text', text: f, align: 'center' });
  return b;
}

/** Hard-wrap text to width (breaks long words such as signatures). */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export function alignLine(text: string, width: number, align: 'left' | 'center' | 'right' = 'left'): string {
  if (text.length >= width || align === 'left') return text;
  const pad = width - text.length;
  return align === 'right' ? ' '.repeat(pad) + text : ' '.repeat(Math.floor(pad / 2)) + text;
}

/** Left/right justified pair; wraps the right side onto its own line when it does not fit. */
export function pairLines(left: string, right: string, width: number): string[] {
  if (left.length + 1 + right.length <= width) return [left + ' '.repeat(width - left.length - right.length) + right];
  return [...wrap(left, width), ...wrap(right, width).map((r) => alignLine(r, width, 'right'))];
}

/** Render a plain-text fuel receipt (monospace, `width` columns; 42 = 80 mm paper Font A at 12 cpi, 32 = 58 mm). */
export function renderReceiptText(doc: ReceiptDocument, width = 42, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  for (const blk of receiptBlocks(doc, opts)) {
    switch (blk.kind) {
      case 'text':
        for (const l of wrap(blk.text, width)) lines.push(alignLine(l, width, blk.align));
        break;
      case 'rule':
        lines.push((blk.char ?? '-').repeat(width));
        break;
      case 'pair':
        lines.push(...pairLines(blk.left, blk.right, width));
        break;
      case 'qr':
        lines.push(...wrap(`QR: ${blk.data}`, width));
        break;
      case 'feed':
        for (let i = 0; i < blk.lines; i++) lines.push('');
        break;
    }
  }
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n') + '\n';
}
