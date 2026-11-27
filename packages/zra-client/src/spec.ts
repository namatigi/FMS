/**
 * ============================================================================
 *  ZRA SMART INVOICE / VSDC PROTOCOL CONFIGURATION — VERIFY BEFORE GO-LIVE
 * ============================================================================
 * Everything in this file encodes assumptions about the ZRA VSDC REST API
 * (endpoint paths, result codes, code tables, VAT categories). They follow the
 * published VSDC conventions but MUST be verified against the current official
 * ZRA VSDC specification and the ZRA sandbox (see docs/DESIGN.md §12 item 2).
 * Keep all protocol constants here so that verification is a one-file change.
 * ============================================================================
 */

export interface VsdcSpec {
  /** Endpoint paths, relative to the VSDC base URL. */
  paths: {
    selectInitInfo: string;
    saveItem: string;
    saveStockItems: string;
    saveStockMaster: string;
    saveSales: string;
  };
  /** VSDC resultCd values and how the client treats them. */
  resultCodes: {
    /** Request succeeded. */
    success: string[];
    /** Device already initialised (selectInitInfo) — treated as healthy. */
    alreadyInitialised: string[];
    /** Duplicate / overlapped invoice. Idempotent success if the response carries receipt data. */
    duplicate: string[];
    /** Transient VSDC-side failures (VSDC could not reach ZRA, internal error) — retry later. */
    retryable: string[];
    /** Anything else is a non-retryable rejection (validation, device, TPIN errors). */
  };
  /** Payment type mapping (FiscalSaleRequest.payment_type → pmtTyCd). */
  paymentTypeCodes: Record<'cash' | 'card' | 'mobile_money' | 'credit' | 'other', string>;
  /** Fixed sale codes. */
  sale: {
    salesTyCd: string;     // N = Normal
    rcptTyCd: string;      // S = Sale
    salesSttsCd: string;   // 02 = Approved
    qtyUnitCd: string;     // LTR = litre
    pkgUnitCd: string;     // NT = net (no packaging) — fuel is sold loose
    currencyTyCd: string;
    exchangeRt: string;
    saleCtyCd: string;     // 1 = local sale
    prchrAcptcYn: string;  // purchaser acceptance flag
    defaultCustomerName: string;
  };
  /** VAT categories in the order the VSDC expects the taxblAmtX / taxRtX / taxAmtX fields. */
  vatCategories: string[];
  /** Default VAT rate per category, in percent. Overridable per client. */
  defaultVatRates: Record<string, number>;
  /** IANA time zone used for cfmDt / salesDt / resultDt. */
  timeZone: string;
  /** Fixed UTC offset of timeZone, used to parse VSDC timestamps back to ISO (Zambia has no DST). */
  utcOffset: string;
}

export const VSDC_SPEC: VsdcSpec = {
  paths: {
    selectInitInfo: '/initializer/selectInitInfo',
    saveItem: '/items/saveItem',
    saveStockItems: '/stock/saveStockItems',
    saveStockMaster: '/stockMaster/saveStockMaster',
    saveSales: '/trnsSales/saveSales',
  },
  resultCodes: {
    success: ['000'],
    alreadyInitialised: ['902'],
    duplicate: ['994'],
    retryable: ['891', '892', '893', '894', '899', '999'],
  },
  paymentTypeCodes: {
    cash: '01',
    credit: '02',
    card: '05',
    mobile_money: '06',
    other: '08',
  },
  sale: {
    salesTyCd: 'N',
    rcptTyCd: 'S',
    salesSttsCd: '02',
    qtyUnitCd: 'LTR',
    pkgUnitCd: 'NT',
    currencyTyCd: 'ZMW',
    exchangeRt: '1',
    saleCtyCd: '1',
    prchrAcptcYn: 'N',
    defaultCustomerName: 'Walk-in customer',
  },
  vatCategories: ['A', 'B', 'C1', 'C2', 'C3', 'D', 'E', 'RVAT'],
  defaultVatRates: { A: 16, B: 16, C1: 0, C2: 0, C3: 0, D: 0, E: 0, RVAT: 16 },
  timeZone: 'Africa/Lusaka',
  utcOffset: '+02:00',
};
