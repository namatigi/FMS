function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  logLevel: string;
  pgPoolMax: number;
  pgStatementTimeoutMs: number;
  pgIdleTimeoutMs: number;
  bodyLimitBytes: number;
  maxRecordsPerBatch: number;
  cacheTtlMs: number;
  rateLimitRps: number;
  rateLimitBurst: number;
  rollupDelayS: number;
  maxCommandsPerResponse: number;
  /** Redeliver a command if no 'received' ack arrived this many seconds after delivery. */
  commandRedeliverS: number;
  archiveEdgeBatches: boolean;
  shutdownTimeoutMs: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/fms',
    port: int('PORT', 8081),
    host: process.env.HOST ?? '0.0.0.0',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    pgPoolMax: int('PG_POOL_MAX', 20),
    pgStatementTimeoutMs: int('PG_STATEMENT_TIMEOUT_MS', 15000),
    pgIdleTimeoutMs: int('PG_IDLE_TIMEOUT_MS', 30000),
    bodyLimitBytes: int('BODY_LIMIT_BYTES', 5 * 1024 * 1024),
    maxRecordsPerBatch: int('MAX_RECORDS_PER_BATCH', 5000),
    cacheTtlMs: int('CACHE_TTL_MS', 60000),
    rateLimitRps: int('RATE_LIMIT_RPS', 20),
    rateLimitBurst: int('RATE_LIMIT_BURST', 40),
    rollupDelayS: int('ROLLUP_DELAY_S', 120),
    maxCommandsPerResponse: int('MAX_COMMANDS_PER_RESPONSE', 20),
    commandRedeliverS: int('COMMAND_REDELIVER_S', 120),
    archiveEdgeBatches: bool('ARCHIVE_EDGE_BATCHES', false),
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 15000),
    ...overrides,
  };
}
