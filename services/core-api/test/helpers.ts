import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db.js';

export const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:55432/fms_core';

export const ST = {
  LUS: 'aaaaaaaa-0000-0000-0000-000000000001',
  CEN: 'aaaaaaaa-0000-0000-0000-000000000002',
  COP: 'aaaaaaaa-0000-0000-0000-000000000003',
  SOU: 'aaaaaaaa-0000-0000-0000-000000000004',
};
export const PASSWORD = 'ChangeMe123!';
export const PARTNER_KEY = 'erbdemo1.dev-partner-key-erb';

export async function makeApp(): Promise<FastifyInstance> {
  const config = loadConfig({
    DATABASE_URL: DB_URL,
    JWT_SECRET: 'test-secret-0123456789abcdef',
    LOG_LEVEL: 'silent',
    LOGIN_RATE_LIMIT_RPM: '10000',
    RATE_LIMIT_RPM: '100000',
    STREAM_POLL_MS: '300',
  } as NodeJS.ProcessEnv);
  const app = await buildApp({ config, logger: false });
  await runMigrations(app.db.primary);
  await app.ready();
  return app;
}

/** Reset rows created by previous runs and insert deterministic telemetry. */
export async function seedTelemetry(app: FastifyInstance) {
  const q = (sql: string, v: unknown[] = []) => app.db.primary.query(sql, v);
  await q(`DELETE FROM fms.pump_transactions WHERE pts_id = 'TEST-CORE'`);
  await q(`DELETE FROM fms.fiscal_receipts WHERE invoice_no LIKE 'TEST-%'`);
  await q(`DELETE FROM fms.tank_latest WHERE station_id = ANY($1::uuid[])`, [[ST.LUS, ST.COP]]);
  await q(`DELETE FROM fms.daily_station_product WHERE station_id = ANY($1::uuid[])`, [[ST.LUS, ST.COP]]);
  await q(`DELETE FROM fms.alerts WHERE code LIKE 'Test%'`);
  await q(`DELETE FROM fms.tank_deliveries WHERE supplier IS NULL OR supplier LIKE 'Test%'`);
  await q(`DELETE FROM fms.edge_commands WHERE station_id = ANY($1::uuid[])`, [[ST.LUS, ST.COP]]);
  await q(`DELETE FROM fms.price_changes WHERE kind = 'station' OR (kind = 'erb_cap' AND created_by IS NOT NULL)`);
  await q(`UPDATE fms.fuel_grades SET price = CASE pts_grade_id WHEN 1 THEN 31.85 ELSE 29.95 END`);
  await q(`DELETE FROM fms.login_attempts`);
  await q(`DELETE FROM fms.users WHERE email LIKE '%@test.local'`);
  await q(`DELETE FROM fms.api_clients WHERE organisation = 'Test Org'`);
  await q(`UPDATE fms.users SET mfa_secret = NULL WHERE email = 'erb@erb.local'`);
  await q(`UPDATE fms.controllers SET last_seen_at = now() WHERE station_id = $1`, [ST.LUS]);
  await q(`UPDATE fms.controllers SET last_seen_at = now() - interval '3 days' WHERE station_id <> $1`, [ST.LUS]);

  await q(`INSERT INTO fms.tank_latest (station_id, tank_no, measured_at, product_code, probe_status, product_volume_l, ullage_l, water_height_mm, temperature_c)
           VALUES ($1, 1, now(), 'PETROL', 'OK', 5000, 25000, 3, 24.5),
                  ($1, 2, now(), 'DIESEL', 'OK', 30000, 10000, 0, 23.1),
                  ($2, 1, now(), 'PETROL', 'OK', 20000, 10000, 0, 22.0),
                  ($2, 2, now(), 'DIESEL', 'OK', 25000, 15000, 0, 22.0)`, [ST.LUS, ST.COP]);

  // 120 sales at LUS-0001 over the last ~2 hours, 10 at COP-0001.
  await q(`INSERT INTO fms.pump_transactions (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, pts_grade_id, product_code, tank_no,
                                              ended_at, volume_l, price, amount, fiscal_status)
           SELECT $1, 'TEST-CORE', g, 1 + (g % 2), 1 + (g % 2), 1 + (g % 2), CASE WHEN g % 2 = 0 THEN 'PETROL' ELSE 'DIESEL' END, 1 + (g % 2),
                  now() - make_interval(secs => g * 60), 20 + g % 7, 31.85, (20 + g % 7) * 31.85,
                  CASE WHEN g % 10 = 0 THEN 'failed' ELSE 'signed' END
             FROM generate_series(1, 120) g`, [ST.LUS]);
  await q(`INSERT INTO fms.pump_transactions (station_id, pts_id, pts_transaction_no, pump_no, nozzle_no, pts_grade_id, product_code, tank_no,
                                              ended_at, volume_l, price, amount)
           SELECT $1, 'TEST-CORE', g, 1, 1, 1, 'PETROL', 1, now() - make_interval(secs => g * 120), 40, 31.85, 40 * 31.85
             FROM generate_series(1, 10) g`, [ST.COP]);
  await q(`INSERT INTO fms.fiscal_receipts (station_id, pump_no, pts_transaction_no, tx_ended_at, invoice_no, status, zra_rcpt_no)
           SELECT station_id, pump_no, pts_transaction_no, ended_at, 'TEST-' || pts_transaction_no, 'signed', 'R' || pts_transaction_no
             FROM fms.pump_transactions WHERE pts_id = 'TEST-CORE' AND station_id = $1 AND pts_transaction_no <= 5`, [ST.LUS]);

  // Roll-ups for the 3 previous days (avg daily sales ~ 2000 L petrol at LUS).
  await q(`INSERT INTO fms.daily_station_product (station_id, business_date, product_code, province_id, sales_volume_l, sales_amount, tx_count,
                                                  opening_stock_l, closing_stock_l, deliveries_l, variance_l, avg_price)
           SELECT st.id, (now() AT TIME ZONE 'Africa/Lusaka')::date - d, p.code, st.province_id, p.vol, p.vol * 31.85, 50, 20000, 18000 - p.var, 0, p.var, 31.85
             FROM fms.stations st
             CROSS JOIN generate_series(1, 3) d
             CROSS JOIN (VALUES ('PETROL', 2000, 0), ('DIESEL', 3000, 400)) AS p(code, vol, var)
            WHERE st.id = ANY($1::uuid[])`, [[ST.LUS, ST.COP]]);

  await q(`INSERT INTO fms.alerts (station_id, occurred_at, device_type, device_no, code, severity, message)
           VALUES ($1, now() - interval '5 minutes', 'tank', 1, 'TestLowProduct', 'warning', 'low product'),
                  ($2, now() - interval '6 minutes', 'pump', 1, 'TestTotalizer', 'critical', 'totaliser mismatch')`, [ST.LUS, ST.COP]);
  await q(`INSERT INTO fms.tank_deliveries (station_id, tank_no, product_code, started_at, ended_at, start_volume_l, end_volume_l)
           VALUES ($1, 1, 'PETROL', now() - interval '1 day 1 hour', now() - interval '1 day', 4000, 24000),
                  ($2, 1, 'PETROL', now() - interval '1 day 1 hour', now() - interval '1 day', 4000, 24000)`, [ST.LUS, ST.COP]);
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD, extra: Record<string, unknown> = {}) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password, ...extra } });
  return r;
}

export async function token(app: FastifyInstance, email: string): Promise<string> {
  const r = await login(app, email);
  if (r.statusCode !== 200) throw new Error(`login ${email} failed: ${r.body}`);
  return r.json().access_token as string;
}

export function get(app: FastifyInstance, tok: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}` } });
}

export function send(app: FastifyInstance, tok: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${tok}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
