import type { ReceiptDocument, ReceiptPrinter } from '@fms/shared';
import { buildEscPosReceipt, decodePaperStatus, PAPER_STATUS_REQUEST, type EscPosRenderOptions } from '../escpos.js';

export interface EscPosSerialConfig {
  driver: 'escpos-serial';
  /** e.g. /dev/ttyUSB0 or COM3 */
  path: string;
  baudRate?: number;
  timeoutMs?: number;
  render?: EscPosRenderOptions;
}

/** Subset of the `serialport` (v10+) API used here. */
interface SerialPortLike {
  open(cb: (err: Error | null) => void): void;
  write(data: Buffer, cb?: (err: Error | null | undefined) => void): boolean;
  drain(cb: (err: Error | null) => void): void;
  close(cb?: (err: Error | null) => void): void;
  once(ev: 'data', cb: (d: Buffer) => void): void;
}
type SerialPortCtor = new (opts: { path: string; baudRate: number; autoOpen: boolean }) => SerialPortLike;

let ctorPromise: Promise<SerialPortCtor> | null = null;

/** The serialport package is an optional peer dependency, loaded only when a serial printer is used. */
async function loadSerialPort(): Promise<SerialPortCtor> {
  ctorPromise ??= (async () => {
    const moduleName = 'serialport';
    try {
      const mod = (await import(moduleName)) as { SerialPort?: SerialPortCtor; default?: { SerialPort?: SerialPortCtor } };
      const ctor = mod.SerialPort ?? mod.default?.SerialPort;
      if (!ctor) throw new Error('SerialPort export not found');
      return ctor;
    } catch (err) {
      ctorPromise = null;
      throw new Error(`escpos-serial requires the optional "serialport" package (npm install serialport): ${(err as Error).message}`);
    }
  })();
  return ctorPromise;
}

const cbp = (fn: (cb: (err: Error | null | undefined) => void) => void) =>
  new Promise<void>((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

type Status = { online: boolean; paper: 'ok' | 'low' | 'out' | 'unknown'; detail?: string };

/** ESC/POS over RS-232 / USB-serial. */
export class EscPosSerialPrinter implements ReceiptPrinter {
  constructor(private readonly cfg: EscPosSerialConfig) {
    if (!cfg.path) throw new TypeError('escpos-serial: path is required');
  }

  private async open(): Promise<SerialPortLike> {
    const SerialPort = await loadSerialPort();
    const port = new SerialPort({ path: this.cfg.path, baudRate: this.cfg.baudRate ?? 9600, autoOpen: false });
    await cbp((cb) => port.open(cb));
    return port;
  }

  async print(doc: ReceiptDocument): Promise<void> {
    const port = await this.open();
    try {
      await cbp((cb) => port.write(buildEscPosReceipt(doc, this.cfg.render), cb));
      await cbp((cb) => port.drain(cb));
    } finally {
      await cbp((cb) => port.close(cb)).catch(() => {});
    }
  }

  async status(): Promise<Status> {
    let port: SerialPortLike;
    try {
      port = await this.open();
    } catch (err) {
      return { online: false, paper: 'unknown', detail: (err as Error).message };
    }
    try {
      const byte = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), this.cfg.timeoutMs ?? 2000);
        port.once('data', (d) => {
          clearTimeout(t);
          resolve(d[0] ?? null);
        });
        port.write(PAPER_STATUS_REQUEST);
      });
      return byte === null ? { online: true, paper: 'unknown', detail: 'no reply to DLE EOT 4' } : { online: true, paper: decodePaperStatus(byte) };
    } finally {
      await cbp((cb) => port.close(cb)).catch(() => {});
    }
  }
}
