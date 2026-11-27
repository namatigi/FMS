/**
 * Factories for the FiscalClient (ZRA VSDC) and ReceiptPrinter. The real implementations live in
 * packages/zra-client and packages/fiscal-printer (optionalDependencies) and are loaded with a
 * dynamic import so the gateway builds/runs even when those packages are absent:
 *   - fiscal client fallback: an "unavailable" client that throws retryable errors, so sales stay
 *     pending (never fake-signed in production). FISCAL_DRIVER=fake selects the FakeFiscalClient.
 *   - printer fallback: built-in console printer (receipt text to the log).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FiscalError,
  type FiscalClient,
  type FiscalSaleRequest,
  type FiscalSignature,
  type ReceiptDocument,
  type ReceiptPrinter,
} from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig, PrinterConfig } from '../config.js';

// Variable specifiers keep TypeScript from requiring the optional packages at build time.
const ZRA_CLIENT_PKG = '@fms/zra-client';
const PRINTER_PKG = '@fms/fiscal-printer';

/** Deterministic in-memory VSDC stand-in: idempotent on invoice_no. For tests and demos only. */
export class FakeFiscalClient implements FiscalClient {
  readonly signed = new Map<string, FiscalSignature>();
  calls = 0;
  private counter = 0;
  /** Optional hook to inject failures: return an Error to throw for this call. */
  failWith: ((req: FiscalSaleRequest, call: number) => Error | null) | null = null;

  async signSale(req: FiscalSaleRequest): Promise<FiscalSignature> {
    this.calls++;
    const err = this.failWith?.(req, this.calls);
    if (err) throw err;
    const existing = this.signed.get(req.invoice_no);
    if (existing) return existing;
    const n = ++this.counter;
    const sig: FiscalSignature = {
      receipt_no: String(n),
      total_receipt_no: String(n),
      internal_data: createHash('sha256').update(`intrl:${req.invoice_no}`).digest('hex').slice(0, 26).toUpperCase(),
      signature: createHash('sha256').update(`sign:${req.invoice_no}`).digest('hex').slice(0, 16).toUpperCase(),
      sdc_id: 'SDC-FAKE-0001',
      mrc_no: 'MRC-FAKE-0001',
      qr_url: `https://fake-vsdc.local/qr?inv=${encodeURIComponent(req.invoice_no)}`,
      signed_at: new Date().toISOString(),
      raw_response: { fake: true, invoice_no: req.invoice_no },
    };
    this.signed.set(req.invoice_no, sig);
    return sig;
  }

  async health() {
    return { ok: true, detail: 'fake' };
  }
}

/** Used when the ZRA client cannot be loaded: every sale stays pending and is retried. */
export class UnavailableFiscalClient implements FiscalClient {
  constructor(private readonly reason: string) {}
  async signSale(): Promise<FiscalSignature> {
    throw new FiscalError(`fiscal client unavailable: ${this.reason}`, true, 'UNAVAILABLE');
  }
  async health() {
    return { ok: false, detail: this.reason };
  }
}

export class ConsoleReceiptPrinter implements ReceiptPrinter {
  constructor(private readonly log: Logger) {}
  async print(doc: ReceiptDocument): Promise<void> {
    this.log.info({ receipt: { invoice_no: doc.invoice_no, pump: doc.pump_no, total: doc.total, rcpt_no: doc.signature.receipt_no } },
      `RECEIPT\n${renderPlain(doc)}`);
  }
  async status() {
    return { online: true, paper: 'unknown' as const, detail: 'console' };
  }
}

export class NullReceiptPrinter implements ReceiptPrinter {
  async print(): Promise<void> {}
  async status() {
    return { online: true, paper: 'unknown' as const, detail: 'printing disabled' };
  }
}

/** Collects printed documents (tests). */
export class MemoryReceiptPrinter implements ReceiptPrinter {
  readonly printed: ReceiptDocument[] = [];
  failWith: ((doc: ReceiptDocument) => Error | null) | null = null;
  async print(doc: ReceiptDocument): Promise<void> {
    const e = this.failWith?.(doc);
    if (e) throw e;
    this.printed.push(doc);
  }
  async status() {
    return { online: true, paper: 'ok' as const };
  }
}

class FileReceiptPrinter implements ReceiptPrinter {
  constructor(private readonly dir: string) {}
  async print(doc: ReceiptDocument): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${doc.invoice_no.replace(/[^A-Za-z0-9_.-]/g, '_')}.txt`), renderPlain(doc));
  }
  async status() {
    return { online: true, paper: 'unknown' as const, detail: `file:${this.dir}` };
  }
}

export function renderPlain(doc: ReceiptDocument): string {
  const L = [
    doc.station_name,
    doc.station_address ?? '',
    `TPIN: ${doc.tpin}`,
    `Invoice: ${doc.invoice_no}`,
    `Date: ${doc.sale_time}`,
    `Pump ${doc.pump_no} Nozzle ${doc.nozzle_no}`,
    ...doc.lines.map((l) => `${l.item_name} ${l.qty.toFixed(2)} L x ${l.unit_price.toFixed(2)} = ${l.total.toFixed(2)} [${l.vat_category}]`),
    `TOTAL ZMW ${doc.total.toFixed(2)}  (VAT ${doc.vat_total.toFixed(2)})`,
    `Payment: ${doc.payment_type}`,
    `ZRA Rcpt: ${doc.signature.receipt_no}  SDC: ${doc.signature.sdc_id ?? ''}  MRC: ${doc.signature.mrc_no ?? ''}`,
    `Internal: ${doc.signature.internal_data ?? ''}`,
    `Signature: ${doc.signature.signature}`,
    doc.signature.qr_url ? `QR: ${doc.signature.qr_url}` : '',
  ];
  return L.filter((x) => x !== '').join('\n');
}

export async function createFiscalClient(cfg: GatewayConfig, log: Logger): Promise<FiscalClient> {
  if (cfg.fiscal.driver === 'fake') {
    log.warn('FISCAL_DRIVER=fake: receipts are NOT signed by ZRA (development only)');
    return new FakeFiscalClient();
  }
  if (cfg.fiscal.driver === 'disabled') return new UnavailableFiscalClient('FISCAL_DRIVER=disabled');
  try {
    const mod = (await import(ZRA_CLIENT_PKG)) as {
      ZraVsdcClient: new (o: { baseUrl: string; tpin: string; bhfId: string; deviceSerial: string; timeoutMs?: number }) => FiscalClient;
    };
    return new mod.ZraVsdcClient({
      baseUrl: cfg.fiscal.vsdcUrl,
      tpin: cfg.station.tpin,
      bhfId: cfg.station.bhf_id,
      deviceSerial: cfg.fiscal.deviceSerial,
      timeoutMs: cfg.fiscal.timeoutMs,
    });
  } catch (e) {
    log.error({ err: e }, `${ZRA_CLIENT_PKG} could not be loaded; sales will stay pending until it is installed`);
    return new UnavailableFiscalClient(`${ZRA_CLIENT_PKG} not installed`);
  }
}

export async function createReceiptPrinter(cfg: PrinterConfig, log: Logger): Promise<ReceiptPrinter> {
  if (cfg.driver === 'none') return new NullReceiptPrinter();
  try {
    const mod = (await import(PRINTER_PKG)) as { createPrinter: (c: PrinterConfig) => ReceiptPrinter | Promise<ReceiptPrinter> };
    return await mod.createPrinter(cfg);
  } catch (e) {
    if (cfg.driver === 'file') return new FileReceiptPrinter(cfg.dir);
    if (cfg.driver !== 'console') log.error({ err: e, driver: cfg.driver }, `${PRINTER_PKG} could not be loaded; falling back to console printer`);
    return new ConsoleReceiptPrinter(log);
  }
}
