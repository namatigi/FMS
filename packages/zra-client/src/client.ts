import { FiscalError, type FiscalClient, type FiscalSaleRequest, type FiscalSignature } from '@fms/shared';
import { buildSalePayload } from './payload.js';
import { VSDC_SPEC, type VsdcSpec } from './spec.js';
import { parseVsdcDateTime } from './time.js';
import type {
  VsdcInitInfo,
  VsdcResponse,
  VsdcSaleReceipt,
  VsdcSaleRequest,
  VsdcSaveItemRequest,
  VsdcSaveStockItemsRequest,
  VsdcSaveStockMasterRequest,
} from './types.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ZraVsdcClientOptions {
  /** VSDC base URL, e.g. http://vsdc.local:8080/zrasandboxvsdc */
  baseUrl: string;
  /** Default seller TPIN (FiscalSaleRequest.tpin takes precedence for sales). */
  tpin: string;
  /** Default branch id (FiscalSaleRequest.branch_id takes precedence for sales). */
  bhfId: string;
  /** VSDC device serial number (dvcSrlNo). */
  deviceSerial: string;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Injected fetch (tests, proxies). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** VAT rate overrides in percent per category, e.g. { A: 16 }. */
  vatRates?: Record<string, number>;
  /** Protocol constants override (paths, result codes). Defaults to VSDC_SPEC. */
  spec?: VsdcSpec;
  /** Communication key issued at initialisation (cmcKey); sent as a header when set. */
  cmcKey?: string;
}

/** Error codes set on FiscalError.code by this client. */
export const ZRA_ERROR_CODES = {
  TIMEOUT: 'VSDC_TIMEOUT',
  NETWORK: 'VSDC_NETWORK',
  HTTP_5XX: 'VSDC_HTTP_5XX',
  HTTP_4XX: 'VSDC_HTTP_4XX',
  BAD_RESPONSE: 'VSDC_BAD_RESPONSE',
  DUPLICATE_NO_DATA: 'VSDC_DUPLICATE_NO_DATA',
  INVALID_REQUEST: 'VSDC_INVALID_REQUEST',
} as const;

/**
 * ZRA Smart Invoice client speaking to a VSDC (Virtual Sales Data Controller).
 * Implements the shared FiscalClient contract; idempotent on invoice_no (cisInvcNo).
 */
export class ZraVsdcClient implements FiscalClient {
  readonly baseUrl: string;
  readonly tpin: string;
  readonly bhfId: string;
  readonly deviceSerial: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly spec: VsdcSpec;
  private readonly vatRates: Record<string, number>;
  private readonly cmcKey?: string;

  constructor(opts: ZraVsdcClientOptions) {
    if (!opts.baseUrl) throw new TypeError('ZraVsdcClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tpin = opts.tpin;
    this.bhfId = opts.bhfId;
    this.deviceSerial = opts.deviceSerial;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.spec = opts.spec ?? VSDC_SPEC;
    this.vatRates = { ...this.spec.defaultVatRates, ...(opts.vatRates ?? {}) };
    this.cmcKey = opts.cmcKey;
  }

  /** selectInitInfo — device initialisation / info lookup. */
  async initialize(): Promise<VsdcResponse<VsdcInitInfo>> {
    const res = await this.post<VsdcInitInfo>(this.spec.paths.selectInitInfo, {
      tpin: this.tpin,
      bhfId: this.bhfId,
      dvcSrlNo: this.deviceSerial,
    });
    const rc = this.spec.resultCodes;
    if (!rc.success.includes(res.resultCd) && !rc.alreadyInitialised.includes(res.resultCd)) throw this.rejection(res);
    return res;
  }

  /** saveItem — register a fuel item (fuel_grades.zra_item_code) with ZRA. */
  async saveItem(item: VsdcSaveItemRequest): Promise<VsdcResponse> {
    return this.expectSuccess(await this.post(this.spec.paths.saveItem, { tpin: this.tpin, bhfId: this.bhfId, ...item }));
  }

  /** saveStockItems — report a stock movement (e.g. ATG-detected delivery). */
  async saveStockItems(req: VsdcSaveStockItemsRequest): Promise<VsdcResponse> {
    return this.expectSuccess(await this.post(this.spec.paths.saveStockItems, { tpin: this.tpin, bhfId: this.bhfId, ...req }));
  }

  /** saveStockMaster — report the remaining stock quantity of an item. */
  async saveStockMaster(req: VsdcSaveStockMasterRequest): Promise<VsdcResponse> {
    return this.expectSuccess(await this.post(this.spec.paths.saveStockMaster, { tpin: this.tpin, bhfId: this.bhfId, ...req }));
  }

  /** Build (without sending) the saveSales payload — useful for storing fiscal_receipts.request. */
  buildSalePayload(req: FiscalSaleRequest): VsdcSaleRequest {
    return buildSalePayload(req, { spec: this.spec, vatRates: this.vatRates, tpin: this.tpin, bhfId: this.bhfId });
  }

  /** trnsSales/saveSales — sign a sale. Throws FiscalError (retryable flag set). */
  async signSale(req: FiscalSaleRequest): Promise<FiscalSignature> {
    let payload: VsdcSaleRequest;
    try {
      payload = this.buildSalePayload(req);
    } catch (err) {
      throw new FiscalError(`Invalid sale request: ${(err as Error).message}`, false, ZRA_ERROR_CODES.INVALID_REQUEST);
    }
    const res = await this.post<VsdcSaleReceipt>(this.spec.paths.saveSales, payload);
    const rc = this.spec.resultCodes;
    if (rc.success.includes(res.resultCd)) {
      if (!hasReceipt(res.data)) throw new FiscalError(`VSDC success without receipt data (${res.resultMsg})`, true, ZRA_ERROR_CODES.BAD_RESPONSE);
      return toSignature(res, res.data);
    }
    if (rc.duplicate.includes(res.resultCd)) {
      // Invoice already signed by ZRA (e.g. a previous attempt timed out after the VSDC committed it).
      if (hasReceipt(res.data)) return toSignature(res, res.data);
      throw new FiscalError(
        `VSDC reports duplicate invoice ${req.invoice_no} without receipt data (${res.resultCd} ${res.resultMsg}); manual retrieval required`,
        false,
        ZRA_ERROR_CODES.DUPLICATE_NO_DATA,
      );
    }
    throw this.rejection(res);
  }

  /** Liveness of the VSDC: selectInitInfo must answer with success / already-initialised. */
  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.initialize();
      return { ok: true, detail: `${res.resultCd} ${res.resultMsg}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  private expectSuccess<T>(res: VsdcResponse<T>): VsdcResponse<T> {
    if (!this.spec.resultCodes.success.includes(res.resultCd)) throw this.rejection(res);
    return res;
  }

  private rejection(res: VsdcResponse<unknown>): FiscalError {
    const retryable = this.spec.resultCodes.retryable.includes(res.resultCd);
    return new FiscalError(`VSDC ${res.resultCd}: ${res.resultMsg}`, retryable, res.resultCd);
  }

  private async post<T>(path: string, body: unknown): Promise<VsdcResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      tpin: this.tpin,
      bhfId: this.bhfId,
    };
    if (this.cmcKey) headers.cmcKey = this.cmcKey;
    let resp: Response;
    let text: string;
    try {
      resp = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
      text = await resp.text();
    } catch (err) {
      if (ac.signal.aborted) throw new FiscalError(`VSDC timeout after ${this.timeoutMs} ms (${path})`, true, ZRA_ERROR_CODES.TIMEOUT);
      throw new FiscalError(`VSDC network error (${path}): ${(err as Error).message}`, true, ZRA_ERROR_CODES.NETWORK);
    } finally {
      clearTimeout(timer);
    }
    if (resp.status >= 500) throw new FiscalError(`VSDC HTTP ${resp.status} (${path})`, true, ZRA_ERROR_CODES.HTTP_5XX);
    if (resp.status === 408 || resp.status === 429) throw new FiscalError(`VSDC HTTP ${resp.status} (${path})`, true, ZRA_ERROR_CODES.HTTP_4XX);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new FiscalError(`VSDC returned non-JSON (HTTP ${resp.status}, ${path})`, resp.ok, ZRA_ERROR_CODES.BAD_RESPONSE);
    }
    if (!json || typeof json !== 'object' || typeof (json as VsdcResponse).resultCd !== 'string') {
      if (!resp.ok) throw new FiscalError(`VSDC HTTP ${resp.status} (${path})`, false, ZRA_ERROR_CODES.HTTP_4XX);
      throw new FiscalError(`VSDC response without resultCd (${path})`, true, ZRA_ERROR_CODES.BAD_RESPONSE);
    }
    return json as VsdcResponse<T>;
  }
}

function hasReceipt(d: unknown): d is VsdcSaleReceipt {
  if (!d || typeof d !== 'object') return false;
  const r = d as Partial<VsdcSaleReceipt>;
  return r.rcptNo !== undefined && r.rcptNo !== null && typeof r.rcptSign === 'string' && r.rcptSign.length > 0;
}

function toSignature(res: VsdcResponse<unknown>, d: VsdcSaleReceipt): FiscalSignature {
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    receipt_no: String(d.rcptNo),
    total_receipt_no: str(d.totRcptNo),
    internal_data: str(d.intrlData),
    signature: d.rcptSign,
    sdc_id: str(d.sdcId),
    mrc_no: str(d.mrcNo),
    qr_url: str(d.qrCodeUrl),
    signed_at: parseVsdcDateTime(d.vsdcRcptPbctDate) ?? parseVsdcDateTime(res.resultDt) ?? new Date().toISOString(),
    raw_response: res,
  };
}
