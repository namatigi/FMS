/**
 * Fiscalisation contracts (ZRA Smart Invoice / VSDC) and fiscal printing.
 * Implemented by packages/zra-client (ZraVsdcClient) and packages/fiscal-printer.
 * Consumed by services/edge-gateway (primary path) and services/fiscal-worker
 * (cloud fallback for direct-mode stations / edge-failed receipts).
 */

export interface FiscalSaleLine {
  item_code: string;          // ZRA item code (fuel_grades.zra_item_code)
  item_class_code: string | null;
  item_name: string;          // e.g. "Unleaded Petrol"
  qty: number;                // litres
  unit_price: number;         // ZMW per litre (tax inclusive)
  total: number;              // ZMW (tax inclusive)
  vat_category: string;       // ZRA VAT category code
}

export interface FiscalSaleRequest {
  tpin: string;               // seller TPIN
  branch_id: string;          // bhfId
  invoice_no: string;         // deterministic, unpadded: <station>-P<pump>-<txno>-<yyyyMMddHHmmss Lusaka>, e.g. LUS-0001-P3-1234-20261127100130 (zra-client buildInvoiceNo)
  sale_time: string;          // ISO-8601
  payment_type: 'cash' | 'card' | 'mobile_money' | 'credit' | 'other';
  customer_tpin?: string | null;
  customer_name?: string | null;
  cashier_id?: string | null;
  lines: FiscalSaleLine[];
}

export interface FiscalSignature {
  receipt_no: string;         // rcptNo
  total_receipt_no: string | null;
  internal_data: string | null;   // intrlData
  signature: string;          // rcptSign
  sdc_id: string | null;
  mrc_no: string | null;
  qr_url: string | null;
  signed_at: string;          // ISO-8601
  raw_response: unknown;
}

export class FiscalError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code?: string) {
    super(message);
  }
}

export interface FiscalClient {
  /** Throws FiscalError. Must be idempotent on invoice_no (ZRA rejects duplicates → treat as retrieve). */
  signSale(req: FiscalSaleRequest): Promise<FiscalSignature>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ReceiptDocument {
  station_name: string;
  station_address: string | null;
  tpin: string;
  invoice_no: string;
  sale_time: string;
  pump_no: number;
  nozzle_no: number;
  attendant: string | null;
  lines: FiscalSaleLine[];
  total: number;
  vat_total: number;
  payment_type: string;
  signature: FiscalSignature;
}

/** Fiscal printer abstraction. Drivers: ESC/POS over TCP 9100, ESC/POS over serial, file/console (dev). */
export interface ReceiptPrinter {
  print(doc: ReceiptDocument): Promise<void>;
  status(): Promise<{ online: boolean; paper: 'ok' | 'low' | 'out' | 'unknown'; detail?: string }>;
}
