export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  databaseUrlRo: string | null;
  jwtSecret: string;
  logLevel: string;
  accessTtlSec: number;
  refreshTtlDays: number;
  corsOrigins: string[] | true;
  rateLimitRpm: number;
  loginRateLimitRpm: number;
  streamPollMs: number;
  runMigrations: boolean;
  mfaIssuer: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? (env.NODE_ENV === 'production' ? '' : 'dev-insecure-jwt-secret-change-me');
  if (!jwtSecret || jwtSecret.length < 16) throw new Error('JWT_SECRET must be set (min 16 chars)');
  const cors = (env.CORS_ORIGINS ?? '').trim();
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/fms',
    databaseUrlRo: env.DATABASE_URL_RO || null,
    jwtSecret,
    logLevel: env.LOG_LEVEL ?? 'info',
    accessTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 900),
    refreshTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    corsOrigins: cors === '' || cors === '*' ? true : cors.split(',').map((s) => s.trim()),
    rateLimitRpm: Number(env.RATE_LIMIT_RPM ?? 1200),
    loginRateLimitRpm: Number(env.LOGIN_RATE_LIMIT_RPM ?? 30),
    streamPollMs: Number(env.STREAM_POLL_MS ?? 5000),
    runMigrations: (env.RUN_MIGRATIONS ?? 'true') !== 'false',
    mfaIssuer: env.MFA_ISSUER ?? 'Zambia FMS',
  };
}
