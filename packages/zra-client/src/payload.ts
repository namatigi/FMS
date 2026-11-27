import type { FiscalSaleRequest } from '@fms/shared';
import { VSDC_SPEC, type VsdcSpec } from './spec.js';
import { formatVsdcDate, formatVsdcDateTime } from './time.js';
import type { VsdcItemLine, VsdcSaleRequest } from './types.js';

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000;

export interface VatBreakdown {
  category: string;
  rate: number;          // percent
  taxable: number;       // ZMW, excl. VAT
  tax: number;           // ZMW
  total: number;         // ZMW, incl. VAT
}

/** Split a tax-inclusive amount into taxable + VAT for the given rate (percent). */
export function splitInclusive(total: number, ratePct: number): { taxable: number; tax: number } {
  const taxable = round2(total / (1 + ratePct / 100));
  return { taxable, tax: round2(total - taxable) };
}

function rateFor(category: string, rates: Record<string, number>): number {
  const r = rates[category];
  if (r === undefined) throw new RangeError(`No VAT rate configured for category '${category}'`);
  return r;
}

/** VAT breakdown per category for tax-inclusive sale lines. */
export function vatBreakdown(lines: FiscalSaleRequest['lines'], rates: Record<string, number> = VSDC_SPEC.defaultVatRates): VatBreakdown[] {
  const by = new Map<string, VatBreakdown>();
  for (const l of lines) {
    const rate = rateFor(l.vat_category, rates);
    const { taxable, tax } = splitInclusive(l.total, rate);
    const b = by.get(l.vat_category) ?? { category: l.vat_category, rate, taxable: 0, tax: 0, total: 0 };
    b.taxable = round2(b.taxable + taxable);
    b.tax = round2(b.tax + tax);
    b.total = round2(b.total + l.total);
    by.set(l.vat_category, b);
  }
  return [...by.values()];
}

export interface BuildSaleOptions {
  spec?: VsdcSpec;
  vatRates?: Record<string, number>;
  timeZone?: string;
  /** Fallbacks when the request does not carry tpin / branch_id. */
  tpin?: string;
  bhfId?: string;
  /** Used for regrId/modrId when the request has no cashier. */
  systemUserId?: string;
}

/** Map an FMS FiscalSaleRequest onto the VSDC trnsSales/saveSales payload. */
export function buildSalePayload(req: FiscalSaleRequest, opts: BuildSaleOptions = {}): VsdcSaleRequest {
  const spec = opts.spec ?? VSDC_SPEC;
  const rates = { ...spec.defaultVatRates, ...(opts.vatRates ?? {}) };
  const tz = opts.timeZone ?? spec.timeZone;
  const tpin = req.tpin || opts.tpin;
  const bhfId = req.branch_id || opts.bhfId;
  if (!tpin) throw new TypeError('FiscalSaleRequest.tpin is required');
  if (!bhfId) throw new TypeError('FiscalSaleRequest.branch_id is required');
  if (!req.invoice_no) throw new TypeError('FiscalSaleRequest.invoice_no is required');
  if (!req.lines.length) throw new TypeError('FiscalSaleRequest.lines must not be empty');

  const pmtTyCd = spec.paymentTypeCodes[req.payment_type] ?? spec.paymentTypeCodes.other;
  const user = req.cashier_id || opts.systemUserId || 'FMS';

  const itemList: VsdcItemLine[] = req.lines.map((l, i) => {
    const rate = rateFor(l.vat_category, rates);
    const { taxable, tax } = splitInclusive(l.total, rate);
    return {
      itemSeq: i + 1,
      itemCd: l.item_code,
      itemClsCd: l.item_class_code ?? '',
      itemNm: l.item_name,
      bcd: null,
      pkgUnitCd: spec.sale.pkgUnitCd,
      pkg: round3(l.qty),
      qtyUnitCd: spec.sale.qtyUnitCd,
      qty: round3(l.qty),
      prc: round2(l.unit_price),
      splyAmt: round2(l.total),
      dcRt: 0,
      dcAmt: 0,
      vatCatCd: l.vat_category,
      vatTaxblAmt: taxable,
      vatAmt: tax,
      totAmt: round2(l.total),
    };
  });

  const breakdown = vatBreakdown(req.lines, rates);
  const perCat: Record<string, number> = {};
  for (const cat of spec.vatCategories) {
    const b = breakdown.find((x) => x.category === cat);
    perCat[`taxblAmt${cat}`] = b?.taxable ?? 0;
    perCat[`taxRt${cat}`] = rates[cat] ?? 0;
    perCat[`taxAmt${cat}`] = b?.tax ?? 0;
  }
  for (const b of breakdown) {
    if (!spec.vatCategories.includes(b.category)) {
      perCat[`taxblAmt${b.category}`] = b.taxable;
      perCat[`taxRt${b.category}`] = b.rate;
      perCat[`taxAmt${b.category}`] = b.tax;
    }
  }

  const saleTime = req.sale_time;
  return {
    tpin,
    bhfId,
    orgInvcNo: 0,
    cisInvcNo: req.invoice_no,
    custTpin: req.customer_tpin ?? null,
    custNm: req.customer_name || spec.sale.defaultCustomerName,
    salesTyCd: spec.sale.salesTyCd,
    rcptTyCd: spec.sale.rcptTyCd,
    pmtTyCd,
    salesSttsCd: spec.sale.salesSttsCd,
    cfmDt: formatVsdcDateTime(saleTime, tz),
    salesDt: formatVsdcDate(saleTime, tz),
    stockRlsDt: formatVsdcDateTime(saleTime, tz),
    cnclReqDt: null,
    cnclDt: null,
    rfdDt: null,
    rfdRsnCd: null,
    totItemCnt: itemList.length,
    ...perCat,
    totTaxblAmt: round2(breakdown.reduce((s, b) => s + b.taxable, 0)),
    totTaxAmt: round2(breakdown.reduce((s, b) => s + b.tax, 0)),
    totAmt: round2(req.lines.reduce((s, l) => s + l.total, 0)),
    prchrAcptcYn: spec.sale.prchrAcptcYn,
    remark: null,
    regrId: user,
    regrNm: user,
    modrId: user,
    modrNm: user,
    saleCtyCd: spec.sale.saleCtyCd,
    currencyTyCd: spec.sale.currencyTyCd,
    exchangeRt: spec.sale.exchangeRt,
    itemList,
  };
}
