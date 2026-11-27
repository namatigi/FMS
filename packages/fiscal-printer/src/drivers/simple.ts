import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReceiptDocument, ReceiptPrinter } from '@fms/shared';
import { buildEscPosReceipt, type EscPosRenderOptions } from '../escpos.js';
import { renderReceiptText, type RenderOptions } from '../render.js';

export interface ConsolePrinterConfig {
  driver: 'console';
  width?: number;
  render?: RenderOptions;
  /** Output sink (default process.stdout). */
  write?: (text: string) => void;
}

/** Development printer: writes the text receipt to stdout. */
export class ConsolePrinter implements ReceiptPrinter {
  constructor(private readonly cfg: ConsolePrinterConfig) {}

  async print(doc: ReceiptDocument): Promise<void> {
    const text = renderReceiptText(doc, this.cfg.width ?? 42, this.cfg.render);
    (this.cfg.write ?? ((t: string) => void process.stdout.write(t)))(text);
  }

  async status() {
    return { online: true, paper: 'ok' as const };
  }
}

export interface FilePrinterConfig {
  driver: 'file';
  dir: string;
  width?: number;
  /** text → <invoice>.txt, escpos → <invoice>.bin, both → both files (default text). */
  format?: 'text' | 'escpos' | 'both';
  render?: EscPosRenderOptions;
}

export const safeFileName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Writes each receipt to a file (digital receipt archive, CI, or a print-spooler pick-up directory). */
export class FilePrinter implements ReceiptPrinter {
  constructor(private readonly cfg: FilePrinterConfig) {
    if (!cfg.dir) throw new TypeError('file printer: dir is required');
  }

  async print(doc: ReceiptDocument): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true });
    const base = join(this.cfg.dir, safeFileName(doc.invoice_no));
    const fmt = this.cfg.format ?? 'text';
    const width = this.cfg.width ?? this.cfg.render?.width ?? 42;
    if (fmt === 'text' || fmt === 'both') await writeFile(`${base}.txt`, renderReceiptText(doc, width, this.cfg.render), 'utf8');
    if (fmt === 'escpos' || fmt === 'both') await writeFile(`${base}.bin`, buildEscPosReceipt(doc, { ...this.cfg.render, width }));
  }

  async status() {
    try {
      await mkdir(this.cfg.dir, { recursive: true });
      await access(this.cfg.dir, constants.W_OK);
      return { online: true, paper: 'ok' as const };
    } catch (err) {
      return { online: false, paper: 'unknown' as const, detail: (err as Error).message };
    }
  }
}
