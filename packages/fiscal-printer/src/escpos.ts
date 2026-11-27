/**
 * Minimal ESC/POS command builder (Epson-compatible, also accepted by most
 * Xprinter / Bixolon / Star-in-ESC/POS-mode / Rongta thermal printers).
 */
import type { ReceiptDocument } from '@fms/shared';
import { pairLines, receiptBlocks, wrap, type RenderOptions } from './render.js';

export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;
export const DLE = 0x10;
export const EOT = 0x04;

export type Align = 'left' | 'center' | 'right';
export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H';

/** Map text to printable ASCII (code page 437 lower half) — avoids mojibake on unknown printer code pages. */
export function toPrinterBytes(text: string): Buffer {
  const normalised = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/×/g, 'x');
  const out = Buffer.alloc(normalised.length);
  for (let i = 0; i < normalised.length; i++) {
    const c = normalised.charCodeAt(i);
    out[i] = c >= 0x20 && c < 0x7f ? c : c === LF ? LF : 0x3f; // '?'
  }
  return out;
}

export class EscPosBuilder {
  private parts: Buffer[] = [];

  raw(...bytes: Array<number | Buffer | number[]>): this {
    for (const b of bytes) this.parts.push(Buffer.isBuffer(b) ? b : Buffer.from(Array.isArray(b) ? b : [b]));
    return this;
  }
  /** ESC @ — initialise printer; ESC t 0 — code page PC437. */
  init(): this {
    return this.raw([ESC, 0x40], [ESC, 0x74, 0x00]);
  }
  /** ESC a n */
  align(a: Align): this {
    return this.raw([ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]);
  }
  /** ESC E n */
  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }
  /** GS ! n — character size multiplier (1..8 for width and height). */
  size(width: number, height = width): this {
    const w = Math.min(8, Math.max(1, Math.round(width))) - 1;
    const h = Math.min(8, Math.max(1, Math.round(height))) - 1;
    return this.raw([GS, 0x21, (w << 4) | h]);
  }
  text(s: string): this {
    return this.raw(toPrinterBytes(s));
  }
  line(s = ''): this {
    return this.text(s).raw(LF);
  }
  /** ESC d n — print and feed n lines. */
  feed(n = 1): this {
    return this.raw([ESC, 0x64, Math.min(255, Math.max(0, n))]);
  }
  /**
   * QR code via GS ( k (function 165/167/169/180/181): model 2, module size, error level, store, print.
   */
  qr(data: string, opts: { moduleSize?: number; errorLevel?: QrErrorLevel } = {}): this {
    const payload = Buffer.from(data, 'utf8');
    if (payload.length > 7089) throw new RangeError('QR payload too long');
    const size = Math.min(16, Math.max(1, opts.moduleSize ?? 6));
    const ec = { L: 48, M: 49, Q: 50, H: 51 }[opts.errorLevel ?? 'M'];
    const storeLen = payload.length + 3;
    return this.raw(
      [GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00], // select model 2
      [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size], // module size
      [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ec], // error correction
      [GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30], // store data
      payload,
      [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30], // print symbol
    );
  }
  /** GS V 66 n — feed n lines then partial cut. */
  cut(feedLines = 3): this {
    return this.raw([GS, 0x56, 0x42, Math.min(255, Math.max(0, feedLines))]);
  }
  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** DLE EOT 4 — transmit roll paper sensor status. */
export const PAPER_STATUS_REQUEST = Buffer.from([DLE, EOT, 0x04]);

/** Decode the DLE EOT 4 response byte. */
export function decodePaperStatus(byte: number): 'ok' | 'low' | 'out' {
  if ((byte & 0x60) === 0x60) return 'out';
  if ((byte & 0x0c) === 0x0c) return 'low';
  return 'ok';
}

export interface EscPosRenderOptions extends RenderOptions {
  /** Characters per line in Font A (42 for 80 mm @ 512 dots is common; 48 on 576-dot heads; 32 for 58 mm). */
  width?: number;
  qrModuleSize?: number;
  /** Lines fed before the cut. */
  cutFeed?: number;
}

/** Full ESC/POS byte stream for a fuel receipt: init, styled text, ZRA QR code, cut. */
export function buildEscPosReceipt(doc: ReceiptDocument, opts: EscPosRenderOptions = {}): Buffer {
  const width = opts.width ?? 42;
  const p = new EscPosBuilder().init();
  for (const blk of receiptBlocks(doc, opts)) {
    switch (blk.kind) {
      case 'text': {
        const size = blk.size ?? 1;
        const cols = Math.floor(width / size);
        p.align(blk.align ?? 'left').bold(!!blk.bold).size(size);
        for (const l of wrap(blk.text, cols)) p.line(l);
        p.size(1).bold(false).align('left');
        break;
      }
      case 'rule':
        p.line((blk.char ?? '-').repeat(width));
        break;
      case 'pair':
        p.bold(!!blk.bold);
        for (const l of pairLines(blk.left, blk.right, width)) p.line(l);
        p.bold(false);
        break;
      case 'qr':
        p.align('center').qr(blk.data, { moduleSize: opts.qrModuleSize ?? 6 }).raw(LF).align('left');
        break;
      case 'feed':
        p.feed(blk.lines);
        break;
    }
  }
  return p.cut(opts.cutFeed ?? 4).build();
}
