#!/usr/bin/env node
// Mock ZRA VSDC server (dev / docker-compose only).
// Env: PORT (default 8200), HOST (default 0.0.0.0), MOCK_VSDC_SIGNING_KEY,
//      MOCK_VSDC_FAIL_MODE (timeout|5xx|reject|duplicate_nodata|vsdc_error), MOCK_VSDC_FAIL_COUNT.
import { startMockVsdc } from '../dist/index.js';

const port = Number(process.env.PORT ?? 8200);
const host = process.env.HOST ?? '0.0.0.0';
const log = (msg, extra = {}) =>
  process.stdout.write(JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'mock-vsdc', msg, ...extra }) + '\n');

const handle = await startMockVsdc({
  port,
  host,
  signingKey: process.env.MOCK_VSDC_SIGNING_KEY,
  failMode: process.env.MOCK_VSDC_FAIL_MODE || null,
  failCount: process.env.MOCK_VSDC_FAIL_COUNT ? Number(process.env.MOCK_VSDC_FAIL_COUNT) : undefined,
  log,
});
log('mock VSDC listening', { port: handle.port, host });

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  log('shutting down', { signal });
  await handle.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
