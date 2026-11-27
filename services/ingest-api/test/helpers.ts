import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { sha256Hex } from '@fms/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:55432/fms_ingest';

export function setup() {
  const cfg = loadConfig({ databaseUrl: DATABASE_URL, rateLimitRps: 0, logLevel: 'warn', cacheTtlMs: 60000, rollupDelayS: 120 });
  const pool = createPool(cfg);
  const { app } = buildApp({ cfg, db: pool });
  return {
    cfg,
    pool,
    app,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export const SEED = {
  lus: { stationId: 'aaaaaaaa-0000-0000-0000-000000000001', code: 'LUS-0001', ptsId: '003B00265030500420303531', secret: 'devsecret-lus-0001', gw: 'GW-LUS-0001', gwKey: 'gwLUS001.dev-gateway-key-lus-0001' },
  cen: { stationId: 'aaaaaaaa-0000-0000-0000-000000000002', code: 'CEN-0001', ptsId: '003B00265030500420303532' },
};

/** PTS-2 local wall-clock string (Africa/Lusaka, UTC+2, no offset) for an instant. */
export function ptsLocal(d: Date): string {
  return new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 19);
}

/** Random instant in the last ~20 days, second precision. */
export function randomRecent(): Date {
  return new Date(Math.floor((Date.now() - randomInt(3600, 20 * 86400)) / 1000) * 1000);
}

export function randomTxNo() {
  return randomInt(1, 2_000_000_000);
}

export interface Fixture {
  stationId: string;
  code: string;
  ptsId: string;
  gw: string;
  gwKey: string;
}

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Isolated station (2 tanks, 2 grades, 2 pumps x 2 nozzles, one controller, one gateway). */
export async function createFixtureStation(db: Q, mode: 'edge' | 'direct' = 'edge', hmacSecret: string | null = null): Promise<Fixture> {
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  const code = `TST-${suffix}`;
  const ptsId = `FF${randomBytes(11).toString('hex').toUpperCase()}`;
  const gw = `GW-${code}`;
  const gwKey = `tst.${randomBytes(16).toString('hex')}`;
  const { rows } = await db.query(
    `INSERT INTO fms.stations (company_id, code, name, province_id, connection_mode)
     VALUES ('11111111-1111-1111-1111-111111111111', $1, $2, 5, $3) RETURNING id`,
    [code, `Test station ${suffix}`, mode],
  );
  const stationId = rows[0].id as string;
  await db.query(`INSERT INTO fms.controllers (station_id, pts_id, hmac_secret) VALUES ($1, $2, $3)`, [stationId, ptsId, hmacSecret]);
  await db.query(`INSERT INTO fms.edge_gateways (station_id, gateway_code, api_key_hash) VALUES ($1, $2, $3)`, [stationId, gw, sha256Hex(gwKey)]);
  await db.query(
    `INSERT INTO fms.tanks (station_id, tank_no, product_code, capacity_l, low_level_l)
     VALUES ($1, 1, 'PETROL', 30000, 6000), ($1, 2, 'DIESEL', 40000, 8000)`,
    [stationId],
  );
  await db.query(
    `INSERT INTO fms.fuel_grades (station_id, pts_grade_id, name, product_code, price)
     VALUES ($1, 1, 'Unleaded Petrol', 'PETROL', 31.85), ($1, 2, 'Diesel LSD', 'DIESEL', 29.95)`,
    [stationId],
  );
  await db.query(
    `INSERT INTO fms.nozzles (station_id, pump_no, nozzle_no, fuel_grade_id, tank_id)
     SELECT $1, p.no, n.no, g.id, t.id
       FROM (VALUES (1),(2)) p(no) CROSS JOIN (VALUES (1),(2)) n(no)
       JOIN fms.fuel_grades g ON g.station_id = $1 AND g.pts_grade_id = n.no
       JOIN fms.tanks t ON t.station_id = $1 AND t.tank_no = n.no`,
    [stationId],
  );
  return { stationId, code, ptsId, gw, gwKey };
}

export function edgeBatch(f: { gw: string; code: string }, records: Array<Record<string, unknown>>) {
  return { gateway_code: f.gw, station_code: f.code, batch_id: randomUUID(), sent_at: new Date().toISOString(), records };
}

export function edgeHeaders(f: { gw: string; gwKey: string }) {
  return { authorization: `Bearer ${f.gwKey}`, 'x-gateway-code': f.gw, 'content-type': 'application/json' };
}

export function gz(o: unknown) {
  return gzipSync(Buffer.from(JSON.stringify(o)));
}

export function pumpTx(ptsId: string, o: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'pump_transaction',
    data: {
      pts_id: ptsId,
      pts_transaction_no: randomTxNo(),
      pump_no: 1,
      nozzle_no: 1,
      pts_grade_id: 1,
      grade_name: 'Unleaded Petrol',
      started_at: null,
      ended_at: new Date().toISOString(),
      volume_l: 20,
      tc_volume_l: null,
      price: 31.85,
      amount: 637,
      total_volume_l: null,
      total_amount: null,
      tag: null,
      pts_user_id: null,
      ...o,
    },
  };
}

export function tankMeasurement(ptsId: string, o: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'tank_measurement',
    data: {
      pts_id: ptsId,
      tank_no: 1,
      measured_at: new Date().toISOString(),
      pts_grade_id: 1,
      probe_status: 'OK',
      alarms: [],
      product_height_mm: 1200,
      water_height_mm: 3,
      temperature_c: 24.5,
      product_volume_l: 15000,
      water_volume_l: 10,
      ullage_l: 15000,
      tc_volume_l: 14900,
      density_kg_m3: 740,
      mass_kg: 11100,
      ...o,
    },
  };
}
