/** Wire types of the ZRA VSDC REST API (see spec.ts — verify against official spec). */

export interface VsdcResponse<T = unknown> {
  resultCd: string;
  resultMsg: string;
  resultDt: string;
  data: T | null;
}

export interface VsdcInitRequest {
  tpin: string;
  bhfId: string;
  dvcSrlNo: string;
}

export interface VsdcInitInfo {
  info?: {
    tpin?: string;
    taxprNm?: string;
    bhfId?: string;
    bhfNm?: string;
    sdcId?: string;
    mrcNo?: string;
    lastSaleInvcNo?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface VsdcItemLine {
  itemSeq: number;
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  bcd?: string | null;
  pkgUnitCd: string;
  pkg: number;
  qtyUnitCd: string;
  qty: number;
  prc: number;
  splyAmt: number;
  dcRt: number;
  dcAmt: number;
  vatCatCd: string;
  vatTaxblAmt: number;
  vatAmt: number;
  totAmt: number;
}

export interface VsdcSaleRequest {
  tpin: string;
  bhfId: string;
  orgInvcNo: number;
  cisInvcNo: string;
  custTpin: string | null;
  custNm: string;
  salesTyCd: string;
  rcptTyCd: string;
  pmtTyCd: string;
  salesSttsCd: string;
  cfmDt: string;
  salesDt: string;
  stockRlsDt: string | null;
  cnclReqDt: null;
  cnclDt: null;
  rfdDt: null;
  rfdRsnCd: null;
  totItemCnt: number;
  /** Per-category taxblAmtX / taxRtX / taxAmtX fields are added dynamically. */
  [field: `taxblAmt${string}` | `taxRt${string}` | `taxAmt${string}`]: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  prchrAcptcYn: string;
  remark: string | null;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
  saleCtyCd: string;
  currencyTyCd: string;
  exchangeRt: string;
  itemList: VsdcItemLine[];
}

export interface VsdcSaleReceipt {
  rcptNo: number | string;
  intrlData: string;
  rcptSign: string;
  totRcptNo: number | string;
  vsdcRcptPbctDate: string;
  sdcId: string;
  mrcNo: string;
  qrCodeUrl: string;
}

/** saveItem request (register a fuel item with ZRA). */
export interface VsdcSaveItemRequest {
  tpin?: string;
  bhfId?: string;
  itemCd: string;
  itemClsCd: string;
  itemTyCd: string;          // 2 = finished product
  itemNm: string;
  itemStdNm?: string | null;
  orgnNatCd: string;         // country of origin, e.g. ZM
  pkgUnitCd: string;
  qtyUnitCd: string;         // LTR
  vatCatCd: string;
  iplCatCd?: string | null;
  tlCatCd?: string | null;
  exciseTxCatCd?: string | null;
  btchNo?: string | null;
  bcd?: string | null;
  dftPrc: number;
  addInfo?: string | null;
  sftyQty?: number | null;
  isrcAplcbYn?: string;
  useYn: string;             // Y
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
}

export interface VsdcStockItemLine {
  itemSeq: number;
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  pkgUnitCd: string;
  pkg: number;
  qtyUnitCd: string;
  qty: number;
  prc: number;
  splyAmt: number;
  totDcAmt: number;
  taxblAmt: number;
  vatCatCd: string;
  taxAmt: number;
  totAmt: number;
}

/** saveStockItems request (stock in/out movement, e.g. an ATG-detected delivery). */
export interface VsdcSaveStockItemsRequest {
  tpin?: string;
  bhfId?: string;
  sarNo: number;             // stored-and-released number
  orgSarNo: number;
  regTyCd: string;           // M = manual, A = automatic
  custTpin?: string | null;
  custNm?: string | null;
  custBhfId?: string | null;
  sarTyCd: string;           // e.g. 02 = incoming purchase, 11 = outgoing sale
  ocrnDt: string;            // yyyyMMdd
  totItemCnt: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  remark?: string | null;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
  itemList: VsdcStockItemLine[];
}

/** saveStockMaster request (current stock quantity of an item). */
export interface VsdcSaveStockMasterRequest {
  tpin?: string;
  bhfId?: string;
  itemCd: string;
  rsdQty: number;            // remaining quantity (litres)
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
}
