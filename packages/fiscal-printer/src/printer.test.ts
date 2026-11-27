import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ReceiptDocument, ReceiptPrinter } from '@fms/shared';
import { buildEscPosReceipt, decodePaperStatus } from './escpos.js';
import { createPrinter, listFiscalDeviceDrivers, registerFiscalDeviceDriver, unregisterFiscalDeviceDriver } from './registry.js';
import { renderReceiptText } from './render.js';

const doc: ReceiptDocument = {
  station_name: 'Zambezi Kabwe North',
  station_address: 'Great North Road, Kabwe',
  tpin: '1000000001',
  invoice_no: 'CEN-0001-P1-4711-20261127101530',
  sale_time: '2026-11-27T08:15:30Z',
  pump_no: 1,
  nozzle_no: 1,
  attendant: 'Mary Banda',
  lines: [{ item_code: 'ZM1NTLTR0000001', item_class_code: null, item_name: 'Unleaded Petrol', qty: 20.5, unit_price: 31.85, total: 652.93, vat_category: 'A' }],
  total: 652.93,
  vat_total: 90.06,
  payment_type: 'mobile_money',
  signature: {
    receipt_no: '17',
    total_receipt_no: '1017',
    internal_data: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ',
    signature: 'A1B2-C3D4-E5F6-0789',
    sdc_id: 'SDC0001ABCD',
    mrc_no: 'MRC0001001',
    qr_url: 'https://vsdc.example/qr?sdcId=SDC0001ABCD&rcptNo=17',
    signed_at: '2026-11-27T10:15:33+02:00',
    raw_response: {},
  },
};

function indexOfSeq(buf: Buffer, seq: number[]): number {
  return buf.indexOf(Buffer.from(seq));
}

describe('renderReceiptText', () => {
  const text = renderReceiptText(doc);
  const lines = text.trimEnd().split('\n');

  it('respects the paper width', () => {
    for (const l of lines) assert.ok(l.length <= 42, `line too long (${l.length}): ${l}`);
    for (const l of renderReceiptText(doc, 32).split('\n')) assert.ok(l.length <= 32);
  });

  it('contains the sale details in order', () => {
    const expected = [
      'Zambezi Kabwe North',
      'TPIN: 1000000001',
      'CEN-0001-P1-4711-20261127101530',
      '27/11/2026 10:15:30',
      'Pump/Nozzle:',
      'Mary Banda',
      'Unleaded Petrol [A]',
      '20.500 L x 31.85',
      'Taxable A (16%)',
      '562.87',
      'VAT A',
      '90.06',
      'TOTAL ZMW',
      '652.93',
      'MOBILE MONEY',
      'SDC ID:',
      'SDC0001ABCD',
      '17/1017',
      'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ',
      'A1B2-C3D4-E5F6-0789',
      'MRC0001001',
    ];
    let pos = 0;
    for (const e of expected) {
      const i = text.indexOf(e, pos);
      assert.ok(i >= 0, `missing or out of order: ${e}`);
      pos = i;
    }
  });

  it('centres the header and right-aligns amounts', () => {
    assert.match(lines[0]!, /^ +Zambezi Kabwe North$/);
    const total = lines.find((l) => l.startsWith('TOTAL ZMW'))!;
    assert.equal(total.length, 42);
    assert.ok(total.endsWith('652.93'));
  });
});

describe('ESC/POS', () => {
  const buf = buildEscPosReceipt(doc);

  it('starts with ESC @ and ends with a cut', () => {
    assert.deepEqual([...buf.subarray(0, 2)], [0x1b, 0x40]);
    const cut = indexOfSeq(buf, [0x1d, 0x56, 0x42]);
    assert.ok(cut > 0);
    assert.equal(cut, buf.length - 4);
  });

  it('contains bold, centre alignment and a QR code (GS ( k) with the ZRA URL', () => {
    assert.ok(indexOfSeq(buf, [0x1b, 0x45, 0x01]) >= 0, 'bold on');
    assert.ok(indexOfSeq(buf, [0x1b, 0x61, 0x01]) >= 0, 'center');
    assert.ok(indexOfSeq(buf, [0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]) >= 0, 'QR model 2');
    const url = Buffer.from(doc.signature.qr_url!, 'utf8');
    const len = url.length + 3;
    const store = indexOfSeq(buf, [0x1d, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30]);
    assert.ok(store >= 0, 'QR store command');
    assert.ok(buf.subarray(store + 8, store + 8 + url.length).equals(url), 'QR payload');
    assert.ok(indexOfSeq(buf, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]) > store, 'QR print');
  });

  it('decodes paper status', () => {
    assert.equal(decodePaperStatus(0x12), 'ok');
    assert.equal(decodePaperStatus(0x1e), 'low');
    assert.equal(decodePaperStatus(0x72), 'out');
  });
});

describe('drivers', () => {
  it('escpos-tcp sends the receipt to a raw TCP printer and reads paper status', async () => {
    const received: Buffer[] = [];
    let connections = 0;
    const server: Server = createServer((sock) => {
      connections++;
      const chunks: Buffer[] = [];
      sock.on('data', (d) => {
        chunks.push(d);
        if (d.length === 3 && d[0] === 0x10 && d[1] === 0x04 && d[2] === 0x04) sock.write(Buffer.from([0x12]));
      });
      sock.on('end', () => received.push(Buffer.concat(chunks)));
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const printer = createPrinter({ driver: 'escpos-tcp', host: '127.0.0.1', port, timeoutMs: 5000 });
      await printer.print(doc);
      for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(received[0]?.equals(buildEscPosReceipt(doc)), 'printer received the exact ESC/POS stream');
      assert.deepEqual(await printer.status(), { online: true, paper: 'ok' });
      assert.equal(connections, 2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const offline = await createPrinter({ driver: 'escpos-tcp', host: '127.0.0.1', port, timeoutMs: 1000 }).status();
    assert.equal(offline.online, false);
  });

  it('file driver writes text and ESC/POS files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-printer-'));
    try {
      const p = createPrinter({ driver: 'file', dir, format: 'both' });
      await p.print(doc);
      const txt = await readFile(join(dir, `${doc.invoice_no}.txt`), 'utf8');
      assert.equal(txt, renderReceiptText(doc));
      const bin = await readFile(join(dir, `${doc.invoice_no}.bin`));
      assert.ok(bin.equals(buildEscPosReceipt(doc)));
      assert.equal((await p.status()).online, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('console driver writes the text receipt', async () => {
    let out = '';
    await createPrinter({ driver: 'console', write: (t) => (out += t) }).print(doc);
    assert.equal(out, renderReceiptText(doc));
  });

  it('serial driver reports a clear error when serialport is not installed', async () => {
    const st = await createPrinter({ driver: 'escpos-serial', path: 'COM99' }).status();
    assert.equal(st.online, false);
  });

  it('vendor fiscal device drivers plug into createPrinter', async () => {
    const printed: string[] = [];
    registerFiscalDeviceDriver({
      name: 'test-vendor',
      vendor: 'Test',
      zraApproved: false,
      createPrinter: (opts): ReceiptPrinter => ({
        print: async (d) => void printed.push(`${String(opts.host)}:${d.invoice_no}`),
        status: async () => ({ online: true, paper: 'ok' }),
      }),
    });
    try {
      assert.deepEqual(listFiscalDeviceDrivers().map((d) => d.name), ['test-vendor']);
      await createPrinter({ driver: 'test-vendor', options: { host: 'dev1' } }).print(doc);
      assert.deepEqual(printed, [`dev1:${doc.invoice_no}`]);
      assert.throws(() => registerFiscalDeviceDriver({ name: 'console', createPrinter: () => { throw new Error(); } }));
      assert.throws(() => createPrinter({ driver: 'nope' }), /Unknown printer driver/);
    } finally {
      unregisterFiscalDeviceDriver('test-vendor');
    }
  });
});
