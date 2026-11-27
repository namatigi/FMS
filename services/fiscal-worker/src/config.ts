import { hostname } from 'node:os';

export const JOB_KINDS = ['fiscalise', 'rollup', 'webhook', 'notify', 'erb_export'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface VsdcDeviceConfig {
  baseUrl: string;
  deviceSerial: string;
  cmcKey?: string;
}

export interface WorkerConfig {
  databaseUrl: string;
  logLevel: string;
  metricsPort: number;
  workerId: string;
  kinds: JobKind[];
  concurrency: number;
  batchSize: number;
  pollIntervalMs: number;
  jobTimeoutMs: number;
  leaseTimeoutMinutes: number;
  leaseCheckIntervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  shutdownGraceMs: number;
  dbPoolMax: number;

  scheduler: {
    enabled: boolean;
    tickMs: number;
    lockKey: number;
    dailyAt: { hour: number; minute: number };
    timeZone: string;
    fiscalSweepEveryMs: number;
    partitionsEveryMs: number;
    fiscalDirectDelayMinutes: number;
    fiscalCloudFallbackMinutes: number;
    fiscalSweepLookbackDays: number;
    fiscalSweepLimit: number;
    gatewayOfflineMinutes: number;
    erbExportDelayMinutes: number;
  };

  zra: {
    defaultBaseUrl: string | null;
    defaultDeviceSerial: string;
    timeoutMs: number;
    vatRates: Record<string, number>;
    /** Per "<tpin>:<bhfId>" VSDC device overrides. */
    devices: Record<string, VsdcDeviceConfig>;
    defaultPaymentType: 'cash' | 'card' | 'mobile_money' | 'credit' | 'other';
    receiptArchiveDir: string | null;
  };

  webhook: { timeoutMs: number; maxAttempts: number; userAgent: string };
  exportDir: string;

  notify: {
    smtp: { host: string; port: number; from: string } | null;
    sms: { url: string; token: string | null } | null;
    fcm: { projectId: string } | null;
  };
}

type Env = NodeJS.ProcessEnv;

function int(env: Env, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}: ${v}`);
  return n;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** "A=16,B=16,D=0" → { A: 16, B: 16, D: 0 } */
export function parseRates(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    const n = Number(v);
    if (!k || !Number.isFinite(n)) throw new Error(`Invalid ZRA_VAT_RATES entry: ${part}`);
    out[k.trim()] = n;
  }
  return out;
}

export function loadConfig(env: Env = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const kinds = (env.WORKER_KINDS ? env.WORKER_KINDS.split(',').map((k) => k.trim()).filter(Boolean) : [...JOB_KINDS]) as JobKind[];
  for (const k of kinds) if (!(JOB_KINDS as readonly string[]).includes(k)) throw new Error(`Unknown job kind in WORKER_KINDS: ${k}`);
  const [h, m] = (env.SCHEDULER_DAILY_AT ?? '00:15').split(':').map(Number);
  const payment = (env.FISCAL_DEFAULT_PAYMENT_TYPE ?? 'cash') as WorkerConfig['zra']['defaultPaymentType'];
  if (!['cash', 'card', 'mobile_money', 'credit', 'other'].includes(payment)) throw new Error(`Invalid FISCAL_DEFAULT_PAYMENT_TYPE: ${payment}`);

  return {
    databaseUrl,
    logLevel: env.LOG_LEVEL ?? 'info',
    metricsPort: int(env, 'METRICS_PORT', 9464),
    workerId: env.WORKER_ID ?? `${hostname()}-${process.pid}`,
    kinds,
    concurrency: Math.max(1, int(env, 'WORKER_CONCURRENCY', 8)),
    batchSize: Math.max(1, int(env, 'WORKER_BATCH_SIZE', 10)),
    pollIntervalMs: int(env, 'WORKER_POLL_INTERVAL_MS', 1000),
    jobTimeoutMs: int(env, 'JOB_TIMEOUT_MS', 120_000),
    leaseTimeoutMinutes: int(env, 'JOB_LEASE_TIMEOUT_MINUTES', 10),
    leaseCheckIntervalMs: int(env, 'JOB_LEASE_CHECK_INTERVAL_MS', 60_000),
    backoffBaseMs: int(env, 'JOB_BACKOFF_BASE_MS', 5_000),
    backoffMaxMs: int(env, 'JOB_BACKOFF_MAX_MS', 3_600_000),
    shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 30_000),
    dbPoolMax: int(env, 'DB_POOL_MAX', 10),
    scheduler: {
      enabled: bool(env, 'SCHEDULER_ENABLED', true),
      tickMs: int(env, 'SCHEDULER_TICK_MS', 30_000),
      lockKey: int(env, 'SCHEDULER_LOCK_KEY', 727_301),
      dailyAt: { hour: h ?? 0, minute: m ?? 15 },
      timeZone: env.SCHEDULER_TIMEZONE ?? 'Africa/Lusaka',
      fiscalSweepEveryMs: int(env, 'FISCAL_SWEEP_INTERVAL_MS', 5 * 60_000),
      partitionsEveryMs: int(env, 'PARTITIONS_INTERVAL_MS', 60 * 60_000),
      fiscalDirectDelayMinutes: int(env, 'FISCAL_DIRECT_DELAY_MINUTES', 2),
      fiscalCloudFallbackMinutes: int(env, 'FISCAL_CLOUD_FALLBACK_MINUTES', 60),
      fiscalSweepLookbackDays: int(env, 'FISCAL_SWEEP_LOOKBACK_DAYS', 30),
      fiscalSweepLimit: int(env, 'FISCAL_SWEEP_LIMIT', 5000),
      gatewayOfflineMinutes: int(env, 'GATEWAY_OFFLINE_MINUTES', 15),
      erbExportDelayMinutes: int(env, 'ERB_EXPORT_DELAY_MINUTES', 10),
    },
    zra: {
      defaultBaseUrl: env.ZRA_VSDC_URL || null,
      defaultDeviceSerial: env.ZRA_DEVICE_SERIAL ?? '',
      timeoutMs: int(env, 'ZRA_TIMEOUT_MS', 15_000),
      vatRates: parseRates(env.ZRA_VAT_RATES),
      devices: env.ZRA_VSDC_DEVICES ? (JSON.parse(env.ZRA_VSDC_DEVICES) as Record<string, VsdcDeviceConfig>) : {},
      defaultPaymentType: payment,
      receiptArchiveDir: env.RECEIPT_ARCHIVE_DIR || null,
    },
    webhook: {
      timeoutMs: int(env, 'WEBHOOK_TIMEOUT_MS', 10_000),
      maxAttempts: int(env, 'WEBHOOK_MAX_ATTEMPTS', 12),
      userAgent: env.WEBHOOK_USER_AGENT ?? 'FMS-Webhooks/1.0',
    },
    exportDir: env.EXPORT_DIR ?? './exports',
    notify: {
      smtp: env.SMTP_HOST ? { host: env.SMTP_HOST, port: int(env, 'SMTP_PORT', 587), from: env.SMTP_FROM ?? 'fms@localhost' } : null,
      sms: env.SMS_GATEWAY_URL ? { url: env.SMS_GATEWAY_URL, token: env.SMS_GATEWAY_TOKEN ?? null } : null,
      fcm: env.FCM_PROJECT_ID ? { projectId: env.FCM_PROJECT_ID } : null,
    },
  };
}
