import { createServer, type IncomingMessage, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import type { EdgeBatch, EdgeBatchResponse, EdgeCommand } from '@fms/shared';
import { hmacSha256Hex } from '@fms/shared';
import { createGateway, type Gateway, type GatewayDeps } from '../app.js';
import { loadConfig, type GatewayConfig } from '../config.js';
import { FakeFiscalClient, MemoryReceiptPrinter } from '../fiscal/factory.js';
import { createLogger } from '../logger.js';

export const PG_ADMIN = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:55432/postgres';
export const TEST_DB = 'fms_edge_test';
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? `postgres://postgres@localhost:55432/${TEST_DB}`;
export const PTS_ID = '003B00265030500420303531';
export const PTS_SECRET = 'devsecret-lus-0001';
export const GATEWAY_CODE = 'GW-LUS-0001';
export const GATEWAY_KEY = 'gwLUS001.dev-gateway-key-lus-0001';
export const CLOUD_PORT = 18181;

export async function ensureTestDb(): Promise<void> {
  const c = new pg.Client({ connectionString: PG_ADMIN });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (!r.rowCount) await c.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await c.end();
  }
  // fresh schema for every test file
  const d = new pg.Client({ connectionString: TEST_DB_URL });
  await d.connect();
  try {
    await d.query('DROP SCHEMA IF EXISTS edge CASCADE');
  } finally {
    await d.end();
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE edge.fiscal_receipts, edge.transactions, edge.tank_measurements, edge.tank_latest, edge.deliveries,
    edge.alerts, edge.outbox, edge.commands_applied, edge.controllers RESTART IDENTITY CASCADE`);
}

export function testConfig(env: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    DATABASE_URL: TEST_DB_URL,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    EDGE_PTS_HOST: '127.0.0.1',
    EDGE_PTS_PORT: '18100',
    EDGE_UI_HOST: '127.0.0.1',
    EDGE_UI_PORT: '18101',
    STATION_CODE: 'LUS-0001',
    STATION_NAME: 'Zambezi Cairo Road',
    ZRA_TPIN: '1000000001',
    ZRA_BHF_ID: '000',
    PTS_ID,
    PTS_SECRET,
    GATEWAY_CODE,
    GATEWAY_KEY,
    CLOUD_INGEST_URL: `http://127.0.0.1:${CLOUD_PORT}`,
    FISCAL_DRIVER: 'fake',
    PRINTER_DRIVER: 'none',
    FISCAL_POLL_MS: '50',
    FISCAL_RETRY_BASE_MS: '50',
    FISCAL_RETRY_MAX_MS: '300000',
    SYNC_INTERVAL_MS: '50',
    SYNC_BACKOFF_BASE_MS: '50',
    SYNC_BACKOFF_MAX_MS: '200',
    HEARTBEAT_INTERVAL_MS: '3600000',
    ...env,
  });
}

export async function newGateway(env: Record<string, string> = {}, deps: GatewayDeps = {}) {
  const cfg = testConfig(env);
  const fiscal = (deps.fiscalClient as FakeFiscalClient | undefined) ?? new FakeFiscalClient();
  const printer = (deps.printer as MemoryReceiptPrinter | undefined) ?? new MemoryReceiptPrinter();
  const gw = await createGateway(cfg, { log: createLogger(cfg.logLevel), ...deps, fiscalClient: fiscal, printer });
  return { gw, fiscal, printer, cfg };
}

export function ptsBody(packets: Array<{ Id: number; Type: string; Data?: Record<string, unknown> }>, ptsId = PTS_ID): string {
  return JSON.stringify({ Protocol: 'jsonPTS', PtsId: ptsId, Packets: packets });
}

export function signedHeaders(body: string, secret: string | null = PTS_SECRET): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) h['x-pts-signature'] = hmacSha256Hex(secret, body);
  return h;
}

let txCounter = 1000;
export function pumpTx(over: Record<string, unknown> = {}): { Id: number; Type: string; Data: Record<string, unknown> } {
  const n = txCounter++;
  const sec = String(n % 60).padStart(2, '0');
  const min = String(Math.floor(n / 60) % 60).padStart(2, '0');
  return {
    Id: n,
    Type: 'UploadPumpTransaction',
    Data: {
      DateTimeStart: `2026-11-27T10:${min}:00`, DateTime: `2026-11-27T10:${min}:${sec}`, Pump: 3, Nozzle: 1,
      FuelGradeId: 1, FuelGradeName: 'Unleaded Petrol', Transaction: n, Volume: 20.5, TCVolume: 20.31,
      Price: 31.85, Amount: 652.93, TotalVolume: 100000 + n * 20.5, TotalAmount: 3500000.5, Tag: '', UserId: 1,
      ...over,
    },
  };
}

export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 10_000, stepMs = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function count(gw: Gateway, sql: string, params: unknown[] = []): Promise<number> {
  const r = await gw.pool.query<{ n: number }>(sql, params);
  return Number(r.rows[0].n);
}

// ---------------------------------------------------------------------------
// Fake cloud ingest (POST /ingest/v1/edge/batches)
// ---------------------------------------------------------------------------
export type RejectFn = (rec: EdgeBatch['records'][number], seenBefore: number) => { error: string; retryable: boolean } | null;

export interface FakeCloud {
  server: Server;
  mode: 'ok' | 'down' | 'drop';
  reject: RejectFn | null;
  batches: EdgeBatch[];
  /** seq -> number of times it was accepted */
  acceptedSeqs: Map<number, number>;
  /** natural key -> record (dedupe like the real ingest-api) */
  store: Map<string, EdgeBatch['records'][number]>;
  pendingCommands: EdgeCommand[];
  authFailures: number;
  gzipped: number;
  close(): Promise<void>;
}

export function naturalKey(r: EdgeBatch['records'][number]): string {
  const d = r.data as unknown as Record<string, unknown>;
  switch (r.kind) {
    case 'pump_transaction': return `tx:${d.pts_id}:${d.pump_no}:${d.pts_transaction_no}:${d.ended_at}`;
    case 'tank_measurement': return `tm:${d.pts_id}:${d.tank_no}:${d.measured_at}`;
    case 'tank_delivery': return `td:${d.pts_id}:${d.tank_no}:${d.started_at}`;
    case 'alert': return `al:${d.pts_id}:${d.occurred_at}:${d.device_type}:${d.device_no}:${d.code}`;
    case 'fiscal_receipt': return `fr:${d.invoice_no}:${d.status}`;
    default: return `${r.kind}:${r.seq}`;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startFakeCloud(port = CLOUD_PORT): Promise<FakeCloud> {
  const fc: FakeCloud = {
    server: null as unknown as Server, mode: 'ok', reject: null, batches: [], acceptedSeqs: new Map(), store: new Map(),
    pendingCommands: [], authFailures: 0, gzipped: 0,
    close: () => new Promise<void>((r) => { fc.server.closeAllConnections?.(); fc.server.close(() => r()); }),
  };
  const rejectedCount = new Map<number, number>();
  fc.server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/ingest/v1/edge/batches') {
      res.writeHead(404).end();
      return;
    }
    let raw = await readBody(req);
    if (fc.mode === 'down') {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"maintenance"}');
      return;
    }
    if (fc.mode === 'drop') {
      req.socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${GATEWAY_KEY}` || req.headers['x-gateway-code'] !== GATEWAY_CODE) {
      fc.authFailures++;
      res.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    if (req.headers['content-encoding'] === 'gzip') {
      raw = gunzipSync(raw);
      fc.gzipped++;
    }
    const batch = JSON.parse(raw.toString('utf8')) as EdgeBatch;
    fc.batches.push(batch);
    const out: EdgeBatchResponse = { batch_id: batch.batch_id, accepted: [], rejected: [], commands: fc.pendingCommands.splice(0) };
    for (const rec of batch.records) {
      const seen = rejectedCount.get(rec.seq) ?? 0;
      const rej = fc.reject?.(rec, seen) ?? null;
      if (rej) {
        rejectedCount.set(rec.seq, seen + 1);
        out.rejected.push({ seq: rec.seq, ...rej });
        continue;
      }
      fc.store.set(naturalKey(rec), rec);
      fc.acceptedSeqs.set(rec.seq, (fc.acceptedSeqs.get(rec.seq) ?? 0) + 1);
      out.accepted.push(rec.seq);
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise<void>((r) => fc.server.listen(port, '127.0.0.1', () => r()));
  return fc;
}
