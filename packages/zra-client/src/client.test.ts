import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FiscalError, type FiscalSaleRequest } from '@fms/shared';
import { ZraVsdcClient, ZRA_ERROR_CODES } from './client.js';
import { startMockVsdc, type MockVsdcHandle } from './mock.js';
import { buildSalePayload, splitInclusive } from './payload.js';
import { buildInvoiceNo, formatVsdcDate, formatVsdcDateTime, parseVsdcDateTime } from './time.js';

const PORT = Number(process.env.MOCK_VSDC_TEST_PORT ?? 18200);

function sale(invoice_no: string, overrides: Partial<FiscalSaleRequest> = {}): FiscalSaleRequest {
  return {
    tpin: '1000000001',
    branch_id: '001',
    invoice_no,
    sale_time: '2026-11-27T08:15:30Z', // 10:15:30 in Lusaka
    payment_type: 'mobile_money',
    lines: [
      {
        item_code: 'ZM1NTLTR0000001',
        item_class_code: '15101500',
        item_name: 'Unleaded Petrol',
        qty: 20.5,
        unit_price: 31.85,
        total: 652.93,
        vat_category: 'A',
      },
    ],
    ...overrides,
  };
}

describe('time + payload helpers', () => {
  it('formats VSDC dates in Africa/Lusaka', () => {
    assert.equal(formatVsdcDateTime('2026-11-27T22:30:00Z'), '20261128003000');
    assert.equal(formatVsdcDate('2026-11-27T22:30:00Z'), '20261128');
    assert.equal(parseVsdcDateTime('20261128003000'), '2026-11-28T00:30:00+02:00');
    assert.equal(parseVsdcDateTime('bad'), null);
  });

  it('builds deterministic invoice numbers', () => {
    assert.equal(
      buildInvoiceNo({ stationCode: 'CEN-0001', pumpNo: 2, ptsTransactionNo: 4711, endedAt: '2026-11-27T08:15:30.123Z' }),
      'CEN-0001-P2-4711-20261127101530',
    );
  });

  it('maps a sale to the saveSales payload with tax-inclusive VAT', () => {
    const p = buildSalePayload(sale('INV-1'));
    assert.equal(p.cisInvcNo, 'INV-1');
    assert.equal(p.pmtTyCd, '06');
    assert.equal(p.salesTyCd, 'N');
    assert.equal(p.rcptTyCd, 'S');
    assert.equal(p.salesSttsCd, '02');
    assert.equal(p.cfmDt, '20261127101530');
    assert.equal(p.salesDt, '20261127');
    assert.equal(p.totItemCnt, 1);
    const { taxable, tax } = splitInclusive(652.93, 16);
    assert.equal(taxable, 562.87);
    assert.equal(tax, 90.06);
    assert.equal(p.taxblAmtA, taxable);
    assert.equal(p.taxAmtA, tax);
    assert.equal(p.taxRtA, 16);
    assert.equal(p.taxblAmtB, 0);
    assert.equal(p.totTaxblAmt, taxable);
    assert.equal(p.totTaxAmt, tax);
    assert.equal(p.totAmt, 652.93);
    const item = p.itemList[0]!;
    assert.deepEqual(
      { itemSeq: item.itemSeq, itemCd: item.itemCd, qtyUnitCd: item.qtyUnitCd, qty: item.qty, prc: item.prc, vatCatCd: item.vatCatCd, vatTaxblAmt: item.vatTaxblAmt, vatAmt: item.vatAmt, totAmt: item.totAmt },
      { itemSeq: 1, itemCd: 'ZM1NTLTR0000001', qtyUnitCd: 'LTR', qty: 20.5, prc: 31.85, vatCatCd: 'A', vatTaxblAmt: taxable, vatAmt: tax, totAmt: 652.93 },
    );
  });

  it('honours configurable VAT rates', () => {
    const p = buildSalePayload(sale('INV-2'), { vatRates: { A: 0 } });
    assert.equal(p.totTaxAmt, 0);
    assert.equal(p.totTaxblAmt, 652.93);
  });
});

describe('ZraVsdcClient against mock VSDC', () => {
  let mock: MockVsdcHandle;
  let client: ZraVsdcClient;
  let fastClient: ZraVsdcClient;

  before(async () => {
    mock = await startMockVsdc({ port: PORT });
    client = new ZraVsdcClient({ baseUrl: mock.url, tpin: '1000000001', bhfId: '001', deviceSerial: 'DVC-TEST-1', timeoutMs: 5000 });
    fastClient = new ZraVsdcClient({ baseUrl: mock.url, tpin: '1000000001', bhfId: '001', deviceSerial: 'DVC-TEST-1', timeoutMs: 500 });
    await client.health(); // warm up the HTTP agent
  });
  after(async () => {
    await mock.close();
  });
  beforeEach(() => mock.reset());

  it('initialises and reports healthy', async () => {
    const init = await client.initialize();
    assert.equal(init.resultCd, '000');
    assert.deepEqual(await client.health(), { ok: true, detail: '000 It is succeeded' });
  });

  it('registers an item', async () => {
    await client.saveItem({
      itemCd: 'ZM1NTLTR0000001', itemClsCd: '15101500', itemTyCd: '2', itemNm: 'Unleaded Petrol', orgnNatCd: 'ZM',
      pkgUnitCd: 'NT', qtyUnitCd: 'LTR', vatCatCd: 'A', dftPrc: 31.85, useYn: 'Y', regrId: 'FMS', regrNm: 'FMS', modrId: 'FMS', modrNm: 'FMS',
    });
    assert.deepEqual(mock.state().items, ['ZM1NTLTR0000001']);
  });

  it('signs a sale', async () => {
    const sig = await client.signSale(sale('CEN-0001-P1-1-20261127101530'));
    assert.equal(sig.receipt_no, '1');
    assert.match(sig.signature, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    assert.ok(sig.internal_data);
    assert.ok(sig.sdc_id?.startsWith('SDC0'));
    assert.ok(sig.mrc_no);
    assert.ok(sig.qr_url?.startsWith(mock.url));
    assert.match(sig.signed_at, /\+02:00$/);
  });

  it('is idempotent on invoice_no (duplicate → same receipt)', async () => {
    const a = await client.signSale(sale('INV-IDEMP'));
    const b = await client.signSale(sale('INV-IDEMP'));
    assert.equal(b.receipt_no, a.receipt_no);
    assert.equal(b.signature, a.signature);
    assert.equal((b.raw_response as { resultCd: string }).resultCd, '994');
    assert.equal(Object.keys(mock.state().receipts).length, 1);
  });

  it('times out as a retryable error, and the retry recovers the receipt signed meanwhile', async () => {
    mock.fail('timeout', 1);
    await assert.rejects(fastClient.signSale(sale('INV-TIMEOUT')), (err: unknown) => {
      assert.ok(err instanceof FiscalError);
      assert.equal(err.retryable, true);
      assert.equal(err.code, ZRA_ERROR_CODES.TIMEOUT);
      return true;
    });
    const sig = await client.signSale(sale('INV-TIMEOUT'));
    assert.equal(sig.receipt_no, '1');
  });

  it('maps 5xx to retryable and validation rejects to non-retryable', async () => {
    mock.fail('5xx', 1);
    await assert.rejects(client.signSale(sale('INV-5XX')), (e: FiscalError) => e.retryable && e.code === ZRA_ERROR_CODES.HTTP_5XX);
    mock.fail('reject', 1);
    await assert.rejects(client.signSale(sale('INV-REJ')), (e: FiscalError) => !e.retryable && e.code === '910');
    mock.fail('vsdc_error', 1);
    await assert.rejects(client.signSale(sale('INV-894')), (e: FiscalError) => e.retryable && e.code === '894');
  });

  it('treats duplicate without receipt data as non-retryable', async () => {
    await client.signSale(sale('INV-DUP'));
    mock.fail('duplicate_nodata', 1);
    await assert.rejects(client.signSale(sale('INV-DUP')), (e: FiscalError) => !e.retryable && e.code === ZRA_ERROR_CODES.DUPLICATE_NO_DATA);
  });

  it('maps connection refused to retryable network error', async () => {
    const dead = new ZraVsdcClient({ baseUrl: 'http://127.0.0.1:1', tpin: '1', bhfId: '000', deviceSerial: 'x', timeoutMs: 500 });
    await assert.rejects(dead.signSale(sale('INV-NET')), (e: FiscalError) => e.retryable && (e.code === ZRA_ERROR_CODES.NETWORK || e.code === ZRA_ERROR_CODES.TIMEOUT));
    assert.equal((await dead.health()).ok, false);
  });

  it('supports failure injection over HTTP control endpoint', async () => {
    const r = await fetch(`${mock.url}/__mock/fail?mode=5xx&count=2`);
    assert.equal(r.status, 200);
    await assert.rejects(client.signSale(sale('INV-CTL')));
    await assert.rejects(client.signSale(sale('INV-CTL')));
    const sig = await client.signSale(sale('INV-CTL'));
    assert.equal(sig.receipt_no, '1');
  });
});
