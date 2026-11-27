import { Socket } from 'node:net';
import type { ReceiptDocument, ReceiptPrinter } from '@fms/shared';
import { buildEscPosReceipt, decodePaperStatus, PAPER_STATUS_REQUEST, type EscPosRenderOptions } from '../escpos.js';

export interface EscPosTcpConfig {
  driver: 'escpos-tcp';
  host: string;
  /** Raw TCP port (JetDirect / "port 9100"). */
  port?: number;
  /** Connect + write timeout in ms (default 5000). */
  timeoutMs?: number;
  render?: EscPosRenderOptions;
}

function connect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const onErr = (err: Error) => {
      s.destroy();
      reject(err);
    };
    const onTimeout = () => onErr(new Error(`printer ${host}:${port} connect timed out after ${timeoutMs} ms`));
    s.setTimeout(timeoutMs, onTimeout);
    s.once('error', onErr);
    s.connect(port, host, () => {
      s.off('error', onErr);
      s.off('timeout', onTimeout);
      resolve(s);
    });
  });
}

type Status = { online: boolean; paper: 'ok' | 'low' | 'out' | 'unknown'; detail?: string };

/** ESC/POS over raw TCP (port 9100). One connection per receipt, robust against printer power cycles. */
export class EscPosTcpPrinter implements ReceiptPrinter {
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: EscPosTcpConfig) {
    if (!cfg.host) throw new TypeError('escpos-tcp: host is required');
    this.port = cfg.port ?? 9100;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  async print(doc: ReceiptDocument): Promise<void> {
    await this.send(buildEscPosReceipt(doc, this.cfg.render));
  }

  /** Send raw ESC/POS bytes. */
  async send(data: Buffer): Promise<void> {
    const s = await connect(this.cfg.host, this.port, this.timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.setTimeout(this.timeoutMs, () => reject(new Error(`printer ${this.cfg.host}:${this.port} write timed out`)));
        s.end(data, () => resolve());
      });
    } finally {
      s.destroy();
    }
  }

  async status(): Promise<Status> {
    let s: Socket;
    try {
      s = await connect(this.cfg.host, this.port, this.timeoutMs);
    } catch (err) {
      return { online: false, paper: 'unknown', detail: (err as Error).message };
    }
    try {
      const byte = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), Math.min(this.timeoutMs, 2000));
        s.once('data', (d: Buffer) => {
          clearTimeout(t);
          resolve(d[0] ?? null);
        });
        s.once('error', () => {
          clearTimeout(t);
          resolve(null);
        });
        s.write(PAPER_STATUS_REQUEST);
      });
      if (byte === null) return { online: true, paper: 'unknown', detail: 'no reply to DLE EOT 4' };
      return { online: true, paper: decodePaperStatus(byte) };
    } finally {
      s.destroy();
    }
  }
}
