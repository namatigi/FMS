/** Environment configuration. See .env.example for documentation of each variable. */
import { readFileSync } from 'node:fs';

export interface ControllerConfig {
  pts_id: string;
  /** PTS-2 "Secret key" for X-Pts-Signature. null = controller configured without a secret. */
  secret: string | null;
  /** PTS-2 built-in web server jsonPTS endpoint, e.g. http://192.168.1.117/jsonPTS (for price updates). */
  control_url?: string | null;
  control_user?: string | null;
  control_password?: string | null;
}

export interface FuelGradeConfig {
  pts_grade_id: number;
  name: string;
  product_code?: string | null;
  zra_item_code?: string | null;
  zra_item_class_code?: string | null;
  zra_item_name?: string | null;
  /** ZRA VAT category code. VERIFY the fuel tax category with ZRA (DESIGN §12). */
  vat_category?: string;
  vat_rate_pct?: number;
  price?: number | null;
}

export interface StationConfig {
  code: string;
  name: string;
  address: string | null;
  tpin: string;
  bhf_id: string;
}

export type PrinterConfig =
  | { driver: 'console' }
  | { driver: 'none' }
  | { driver: 'file'; dir: string }
  | { driver: 'escpos-tcp'; host: string; port: number }
  | { driver: 'escpos-serial'; path: string; baudRate: number };

export type HaMode = 'always' | 'vip' | 'file' | 'standby';

export interface GatewayConfig {
  databaseUrl: string;
  logLevel: string;
  pts: { host: string; port: number; allowUnknown: boolean; bodyLimit: number };
  ui: { host: string; port: number; user: string | null; password: string | null };
  station: StationConfig;
  controllers: ControllerConfig[];
  fuelGrades: FuelGradeConfig[];
  configFile: string | null;
  fiscal: {
    driver: 'zra' | 'fake' | 'disabled';
    vsdcUrl: string;
    deviceSerial: string;
    timeoutMs: number;
    concurrency: number;
    pollMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
    leaseMs: number;
    paymentType: 'cash' | 'card' | 'mobile_money' | 'credit' | 'other';
  };
  printer: PrinterConfig;
  cloud: {
    ingestUrl: string | null;
    gatewayCode: string;
    gatewayKey: string;
    batchMaxRecords: number;
    batchMaxBytes: number;
    intervalMs: number;
    gzip: boolean;
    timeoutMs: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    heartbeatMs: number;
    statusSyncMs: number;
    maxRetryableAttempts: number;
  };
  ha: { mode: HaMode; vip: string | null; stateFile: string | null; checkMs: number };
  retention: { outboxDays: number; intervalMs: number };
  ptsControl: { timeoutMs: number };
  version: string;
}

type Env = Record<string, string | undefined>;

function int(env: Env, k: string, d: number): number {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${k} must be a number`);
  return n;
}
function bool(env: Env, k: string, d: boolean): boolean {
  const v = env[k];
  if (v === undefined || v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
}
function str(env: Env, k: string, d: string): string {
  const v = env[k];
  return v === undefined || v === '' ? d : v;
}
function opt(env: Env, k: string): string | null {
  const v = env[k];
  return v === undefined || v === '' ? null : v;
}

/** Default fuel grades = the demo seed (db/seed/001_demo.sql). Override with EDGE_CONFIG_FILE. */
export const DEFAULT_FUEL_GRADES: FuelGradeConfig[] = [
  { pts_grade_id: 1, name: 'Unleaded Petrol', product_code: 'PETROL', zra_item_code: 'ZM1NTLTR0000001', vat_category: 'A', vat_rate_pct: 16, price: 31.85 },
  { pts_grade_id: 2, name: 'Diesel LSD', product_code: 'DIESEL', zra_item_code: 'ZM1NTLTR0000002', vat_category: 'A', vat_rate_pct: 16, price: 29.95 },
];

export interface ConfigFile {
  station?: Partial<StationConfig>;
  fuel_grades?: FuelGradeConfig[];
  controllers?: ControllerConfig[];
}

export function readConfigFile(path: string | null): ConfigFile {
  if (!path) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
}

function parseControllers(env: Env, file: ConfigFile): ControllerConfig[] {
  const list: ControllerConfig[] = [];
  if (env.PTS_CONTROLLERS) {
    const parsed = JSON.parse(env.PTS_CONTROLLERS) as ControllerConfig[];
    if (!Array.isArray(parsed)) throw new Error('PTS_CONTROLLERS must be a JSON array');
    list.push(...parsed);
  }
  if (env.PTS_ID) {
    list.push({
      pts_id: env.PTS_ID,
      secret: opt(env, 'PTS_SECRET'),
      control_url: opt(env, 'PTS_CONTROL_URL'),
      control_user: opt(env, 'PTS_CONTROL_USER'),
      control_password: opt(env, 'PTS_CONTROL_PASSWORD'),
    });
  }
  for (const c of file.controllers ?? []) if (!list.some((x) => x.pts_id === c.pts_id)) list.push(c);
  return list.map((c) => ({ ...c, pts_id: c.pts_id.toUpperCase(), secret: c.secret ?? null }));
}

export function loadConfig(env: Env = process.env): GatewayConfig {
  const configFile = opt(env, 'EDGE_CONFIG_FILE');
  const file = readConfigFile(configFile);
  const printerDriver = str(env, 'PRINTER_DRIVER', 'console');
  let printer: PrinterConfig;
  switch (printerDriver) {
    case 'escpos-tcp':
      printer = { driver: 'escpos-tcp', host: str(env, 'PRINTER_HOST', '127.0.0.1'), port: int(env, 'PRINTER_PORT', 9100) };
      break;
    case 'escpos-serial':
      printer = { driver: 'escpos-serial', path: str(env, 'PRINTER_PATH', '/dev/ttyUSB0'), baudRate: int(env, 'PRINTER_BAUD', 9600) };
      break;
    case 'file':
      printer = { driver: 'file', dir: str(env, 'PRINTER_DIR', './receipts') };
      break;
    case 'none':
      printer = { driver: 'none' };
      break;
    default:
      printer = { driver: 'console' };
  }
  const stationCode = str(env, 'STATION_CODE', file.station?.code ?? 'LUS-0001');
  const haMode = str(env, 'HA_MODE', 'always') as HaMode;
  if (!['always', 'vip', 'file', 'standby'].includes(haMode)) throw new Error(`HA_MODE must be always|vip|file|standby`);
  const fiscalDriver = str(env, 'FISCAL_DRIVER', 'zra') as GatewayConfig['fiscal']['driver'];
  if (!['zra', 'fake', 'disabled'].includes(fiscalDriver)) throw new Error('FISCAL_DRIVER must be zra|fake|disabled');

  return {
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://postgres@localhost:5432/fms_edge'),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    pts: {
      host: str(env, 'EDGE_PTS_HOST', '0.0.0.0'),
      port: int(env, 'EDGE_PTS_PORT', 8100),
      allowUnknown: bool(env, 'PTS_ALLOW_UNKNOWN', false),
      bodyLimit: int(env, 'EDGE_PTS_BODY_LIMIT', 16 * 1024 * 1024),
    },
    ui: {
      host: str(env, 'EDGE_UI_HOST', '0.0.0.0'),
      port: int(env, 'EDGE_UI_PORT', 8101),
      user: opt(env, 'EDGE_UI_USER'),
      password: opt(env, 'EDGE_UI_PASSWORD'),
    },
    station: {
      code: stationCode,
      name: str(env, 'STATION_NAME', file.station?.name ?? stationCode),
      address: opt(env, 'STATION_ADDRESS') ?? file.station?.address ?? null,
      tpin: str(env, 'ZRA_TPIN', file.station?.tpin ?? '1000000001'),
      bhf_id: str(env, 'ZRA_BHF_ID', file.station?.bhf_id ?? '000'),
    },
    controllers: parseControllers(env, file),
    fuelGrades: file.fuel_grades ?? DEFAULT_FUEL_GRADES,
    configFile,
    fiscal: {
      driver: fiscalDriver,
      vsdcUrl: str(env, 'ZRA_VSDC_URL', 'http://localhost:8200'),
      deviceSerial: str(env, 'ZRA_DEVICE_SERIAL', 'EDGE-DEV-0001'),
      timeoutMs: int(env, 'ZRA_TIMEOUT_MS', 15_000),
      concurrency: int(env, 'FISCAL_CONCURRENCY', 4),
      pollMs: int(env, 'FISCAL_POLL_MS', 1000),
      retryBaseMs: int(env, 'FISCAL_RETRY_BASE_MS', 2000),
      retryMaxMs: int(env, 'FISCAL_RETRY_MAX_MS', 300_000),
      leaseMs: int(env, 'FISCAL_LEASE_MS', 120_000),
      paymentType: str(env, 'FISCAL_PAYMENT_TYPE', 'cash') as GatewayConfig['fiscal']['paymentType'],
    },
    printer,
    cloud: {
      ingestUrl: opt(env, 'CLOUD_INGEST_URL'),
      gatewayCode: str(env, 'GATEWAY_CODE', `GW-${stationCode}`),
      gatewayKey: str(env, 'GATEWAY_KEY', ''),
      batchMaxRecords: int(env, 'SYNC_BATCH_MAX_RECORDS', 500),
      batchMaxBytes: int(env, 'SYNC_BATCH_MAX_BYTES', 1024 * 1024),
      intervalMs: int(env, 'SYNC_INTERVAL_MS', 2000),
      gzip: bool(env, 'SYNC_GZIP', true),
      timeoutMs: int(env, 'SYNC_TIMEOUT_MS', 30_000),
      backoffBaseMs: int(env, 'SYNC_BACKOFF_BASE_MS', 1000),
      backoffMaxMs: int(env, 'SYNC_BACKOFF_MAX_MS', 60_000),
      heartbeatMs: int(env, 'HEARTBEAT_INTERVAL_MS', 30_000),
      statusSyncMs: int(env, 'STATUS_SYNC_INTERVAL_MS', 60_000),
      maxRetryableAttempts: int(env, 'SYNC_MAX_RETRYABLE_ATTEMPTS', 100),
    },
    ha: {
      mode: haMode,
      vip: opt(env, 'HA_VIP'),
      stateFile: opt(env, 'HA_STATE_FILE'),
      checkMs: int(env, 'HA_CHECK_INTERVAL_MS', 2000),
    },
    retention: { outboxDays: int(env, 'OUTBOX_RETENTION_DAYS', 30), intervalMs: int(env, 'RETENTION_INTERVAL_MS', 3_600_000) },
    ptsControl: { timeoutMs: int(env, 'PTS_CONTROL_TIMEOUT_MS', 10_000) },
    version: str(env, 'GATEWAY_VERSION', '0.1.0'),
  };
}
