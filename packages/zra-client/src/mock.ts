/**
 * In-process mock ZRA VSDC for development, docker-compose and tests.
 *
 * Endpoints (see spec.ts): selectInitInfo, saveItem, saveStockItems, saveStockMaster, saveSales.
 * Behaviour:
 *   - deterministic receipt numbers (sequential per tpin+bhfId) and signatures (HMAC of the invoice);
 *   - idempotent on cisInvcNo: a repeat returns resultCd '994' (duplicate) WITH the original receipt data;
 *   - basic payload validation → resultCd '910';
 *   - failure injection via GET/POST /__mock/fail?mode=timeout|5xx|reject|duplicate_nodata|vsdc_error&count=N
 *     (or env MOCK_VSDC_FAIL_MODE / MOCK_VSDC_FAIL_COUNT for the CLI);
 *   - GET /__mock/state (counters, receipts), POST /__mock/reset, GET /healthz.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { VSDC_SPEC } from './spec.js';
import { formatVsdcDateTime } from './time.js';
import type { VsdcSaleReceipt, VsdcSaleRequest } from './types.js';

export type MockFailMode = 'timeout' | '5xx' | 'reject' | 'duplicate_nodata' | 'vsdc_error';
const FAIL_MODES: MockFailMode[] = ['timeout', '5xx', 'reject', 'duplicate_nodata', 'vsdc_error'];

export interface MockVsdcOptions {
  port: number;
  host?: string;
  /** Key used to derive deterministic signatures. */
  signingKey?: string;
  /** Initial failure injection. */
  failMode?: MockFailMode | null;
  failCount?: number;
  /** Fixed clock for deterministic resultDt (tests). */
  now?: () => Date;
  /** Optional request logger. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface MockVsdcHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Programmatic failure injection (same as /__mock/fail). */
  fail(mode: MockFailMode | null, count?: number): void;
  reset(): void;
  state(): MockVsdcState;
}

export interface MockVsdcState {
  requests: Record<string, number>;
  receipts: Record<string, VsdcSaleReceipt>;
  items: string[];
  fail: { mode: MockFailMode | null; remaining: number };
}

export async function startMockVsdc(opts: MockVsdcOptions): Promise<MockVsdcHandle> {
  const signingKey = opts.signingKey ?? 'mock-vsdc-signing-key';
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const sockets = new Set<Socket>();
  const pending = new Set<ServerResponse>();

  let state: MockVsdcState;
  const counters = new Map<string, number>(); // tpin:bhfId → last rcptNo
  const reset = () => {
    state = { requests: {}, receipts: {}, items: [], fail: { mode: opts.failMode ?? null, remaining: opts.failCount ?? 0 } };
    if (state.fail.mode && state.fail.remaining <= 0) state.fail.remaining = Number.POSITIVE_INFINITY;
    counters.clear();
  };
  reset();
  let baseUrl = '';

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const vsdc = (res: ServerResponse, resultCd: string, resultMsg: string, data: unknown = null) =>
    send(res, 200, { resultCd, resultMsg, resultDt: formatVsdcDateTime(now()), data });

  const sign = (s: string, len = 16) => createHmac('sha256', signingKey).update(s).digest('hex').slice(0, len).toUpperCase();
  const group = (s: string) => s.match(/.{1,4}/g)!.join('-');

  const takeFailure = (): MockFailMode | null => {
    if (!state.fail.mode || state.fail.remaining <= 0) return null;
    state.fail.remaining -= 1;
    const m = state.fail.mode;
    if (state.fail.remaining <= 0) state.fail.mode = null;
    return m;
  };

  const handleSale = (res: ServerResponse, body: Partial<VsdcSaleRequest>, failure: MockFailMode | null) => {
    const errors: string[] = [];
    if (!body.tpin) errors.push('tpin');
    if (!body.bhfId) errors.push('bhfId');
    if (!body.cisInvcNo) errors.push('cisInvcNo');
    if (!/^\d{14}$/.test(body.cfmDt ?? '')) errors.push('cfmDt');
    if (!/^\d{8}$/.test(body.salesDt ?? '')) errors.push('salesDt');
    if (!Array.isArray(body.itemList) || body.itemList.length === 0) errors.push('itemList');
    else {
      if (body.totItemCnt !== body.itemList.length) errors.push('totItemCnt');
      const sum = Math.round(body.itemList.reduce((s, i) => s + Number(i.totAmt), 0) * 100) / 100;
      if (Math.abs(sum - Number(body.totAmt)) > 0.01) errors.push('totAmt');
    }
    if (errors.length) return vsdc(res, '910', `Request parameter error: ${errors.join(', ')}`);

    const key = `${body.tpin}:${body.bhfId}:${body.cisInvcNo}`;
    const existing = state.receipts[key];
    if (existing) {
      if (failure === 'duplicate_nodata') return vsdc(res, '994', 'Overlapped data');
      return vsdc(res, '994', 'Overlapped data', existing);
    }
    const ck = `${body.tpin}:${body.bhfId}`;
    const rcptNo = (counters.get(ck) ?? 0) + 1;
    counters.set(ck, rcptNo);
    const sdcId = `SDC0${body.bhfId}${String(body.tpin).slice(-4)}`;
    const rcptSign = group(sign(`sign:${key}:${rcptNo}`));
    const receipt: VsdcSaleReceipt = {
      rcptNo,
      intrlData: group(sign(`intrl:${key}:${rcptNo}`, 26)),
      rcptSign,
      totRcptNo: rcptNo,
      vsdcRcptPbctDate: formatVsdcDateTime(now()),
      sdcId,
      mrcNo: `MRC${String(body.tpin).slice(-4)}${body.bhfId}01`,
      qrCodeUrl: `${baseUrl}/qr?sdcId=${encodeURIComponent(sdcId)}&rcptNo=${rcptNo}&sign=${encodeURIComponent(rcptSign)}`,
    };
    state.receipts[key] = receipt;
    // 'timeout' after commit simulates the worst case: ZRA signed it but the client never saw the answer.
    if (failure === 'timeout') return hold(res);
    return vsdc(res, '000', 'It is succeeded', receipt);
  };

  const hold = (res: ServerResponse) => {
    pending.add(res);
    res.on('close', () => pending.delete(res));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://mock');
      const path = u.pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/__mock/state') return send(res, 200, state);
      if (path === '/__mock/reset') {
        reset();
        return send(res, 200, { ok: true });
      }
      if (path === '/__mock/fail') {
        const mode = u.searchParams.get('mode');
        if (mode === 'none' || mode === null) {
          state.fail = { mode: null, remaining: 0 };
        } else if ((FAIL_MODES as string[]).includes(mode)) {
          const count = Number(u.searchParams.get('count') ?? '1');
          state.fail = { mode: mode as MockFailMode, remaining: count > 0 ? count : Number.POSITIVE_INFINITY };
        } else return send(res, 400, { error: `unknown mode ${mode}`, modes: FAIL_MODES });
        return send(res, 200, { ok: true, fail: state.fail });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return vsdc(res, '911', 'There is no request full text');
      }
      state.requests[path] = (state.requests[path] ?? 0) + 1;
      log('mock-vsdc request', { path, cisInvcNo: body.cisInvcNo });

      const p = VSDC_SPEC.paths;
      const knownPaths = Object.values(p) as string[];
      if (!knownPaths.includes(path)) return send(res, 404, { error: 'not found' });

      const failure = takeFailure();
      if (failure === '5xx') return send(res, 503, { error: 'injected 5xx' });
      if (failure === 'reject') return vsdc(res, '910', 'Request parameter error (injected)');
      if (failure === 'vsdc_error') return vsdc(res, '894', 'Unable to connect to the server (injected)');
      if (failure === 'timeout' && path !== p.saveSales) return hold(res);

      switch (path) {
        case p.selectInitInfo: {
          if (!body.tpin || !body.bhfId || !body.dvcSrlNo) return vsdc(res, '910', 'Request parameter error');
          return vsdc(res, '000', 'It is succeeded', {
            info: {
              tpin: body.tpin,
              taxprNm: 'MOCK TAXPAYER',
              bhfId: body.bhfId,
              bhfNm: `Branch ${String(body.bhfId)}`,
              sdcId: `SDC0${String(body.bhfId)}${String(body.tpin).slice(-4)}`,
              mrcNo: `MRC${String(body.tpin).slice(-4)}${String(body.bhfId)}01`,
              dvcSrlNo: body.dvcSrlNo,
              lastSaleInvcNo: counters.get(`${body.tpin}:${body.bhfId}`) ?? 0,
            },
          });
        }
        case p.saveItem: {
          if (!body.itemCd || !body.itemNm) return vsdc(res, '910', 'Request parameter error');
          if (!state.items.includes(String(body.itemCd))) state.items.push(String(body.itemCd));
          return vsdc(res, '000', 'It is succeeded');
        }
        case p.saveStockItems:
        case p.saveStockMaster:
          return vsdc(res, '000', 'It is succeeded');
        case p.saveSales:
          return handleSale(res, body as Partial<VsdcSaleRequest>, failure);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = opts.host && opts.host !== '0.0.0.0' && opts.host !== '::' ? opts.host : '127.0.0.1';
  baseUrl = `http://${host}:${addr.port}`;

  return {
    url: baseUrl,
    port: addr.port,
    fail(mode, count = 1) {
      state.fail = mode ? { mode, remaining: count > 0 ? count : Number.POSITIVE_INFINITY } : { mode: null, remaining: 0 };
    },
    reset,
    state: () => state,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of pending) r.destroy();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
