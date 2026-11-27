import type { Db } from './db.js';

/** Small TTL cache with in-flight de-duplication and short negative caching. */
export class TtlCache<V> {
  private map = new Map<string, { v: V | null; exp: number }>();
  private inflight = new Map<string, Promise<V | null>>();
  constructor(private ttlMs: number, private negativeTtlMs: number, private load: (key: string) => Promise<V | null>) {}

  async get(key: string): Promise<V | null> {
    const hit = this.map.get(key);
    const now = Date.now();
    if (hit && hit.exp > now) return hit.v;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(key)
        .then((v) => {
          this.map.set(key, { v, exp: Date.now() + (v === null ? this.negativeTtlMs : this.ttlMs) });
          if (this.map.size > 50_000) this.map.clear();
          return v;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  clear() {
    this.map.clear();
  }
}

export interface ControllerRef {
  id: string;
  pts_id: string;
  station_id: string;
  hmac_secret: string | null;
}

export interface GatewayRef {
  id: string;
  gateway_code: string;
  station_id: string;
  api_key_hash: string;
}

export interface TankRef {
  product_code: string;
  low_level_l: number | null;
  capacity_l: number;
}

export interface StationRef {
  id: string;
  code: string;
  timezone: string;
  /** "+02:00" style offset used for PTS-2 local timestamps */
  tzOffset: string;
  province_id: number;
  company_id: string;
  connection_mode: 'edge' | 'direct';
  grades: Map<number, string>; // pts_grade_id -> product_code
  nozzles: Map<string, { tank_no: number | null; product_code: string | null }>; // "pump:nozzle"
  tanks: Map<number, TankRef>;
}

/** Current UTC offset of an IANA zone as "+HH:MM" (Zambia has no DST, but stay generic). */
export function tzOffsetOf(timezone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(part ?? '');
    if (!m) return '+00:00';
    return `${m[1]}:${m[2] ?? '00'}`;
  } catch {
    return '+02:00';
  }
}

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
/** Station-local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(iso: string | Date, timezone: string): string {
  let f = dateFmtCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFmtCache.set(timezone, f);
  }
  return f.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export class RefData {
  readonly controllers: TtlCache<ControllerRef>;
  readonly gateways: TtlCache<GatewayRef>;
  readonly stations: TtlCache<StationRef>;

  constructor(private db: Db, ttlMs: number) {
    const neg = Math.min(ttlMs, 5000);
    this.controllers = new TtlCache(ttlMs, neg, async (ptsId) => {
      const { rows } = await db.query<ControllerRef>(
        'SELECT id, pts_id, station_id, hmac_secret FROM fms.controllers WHERE pts_id = $1',
        [ptsId],
      );
      return rows[0] ?? null;
    });
    this.gateways = new TtlCache(ttlMs, neg, async (code) => {
      const { rows } = await db.query<GatewayRef>(
        'SELECT id, gateway_code, station_id, api_key_hash FROM fms.edge_gateways WHERE gateway_code = $1',
        [code],
      );
      return rows[0] ?? null;
    });
    this.stations = new TtlCache(ttlMs, neg, (id) => this.loadStation(id));
  }

  private async loadStation(id: string): Promise<StationRef | null> {
    const { rows } = await this.db.query(
      `SELECT s.id, s.code, s.timezone, s.province_id, s.company_id, s.connection_mode,
              (SELECT coalesce(json_agg(json_build_object('g', g.pts_grade_id, 'p', g.product_code)), '[]')
                 FROM fms.fuel_grades g WHERE g.station_id = s.id) AS grades,
              (SELECT coalesce(json_agg(json_build_object('pump', n.pump_no, 'nozzle', n.nozzle_no,
                        'tank', t.tank_no, 'p', coalesce(g.product_code, t.product_code))), '[]')
                 FROM fms.nozzles n
                 LEFT JOIN fms.fuel_grades g ON g.id = n.fuel_grade_id
                 LEFT JOIN fms.tanks t ON t.id = n.tank_id
                WHERE n.station_id = s.id) AS nozzles,
              (SELECT coalesce(json_agg(json_build_object('tank', t.tank_no, 'p', t.product_code,
                        'low', t.low_level_l, 'cap', t.capacity_l)), '[]')
                 FROM fms.tanks t WHERE t.station_id = s.id) AS tanks
         FROM fms.stations s WHERE s.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      code: r.code,
      timezone: r.timezone,
      tzOffset: tzOffsetOf(r.timezone),
      province_id: r.province_id,
      company_id: r.company_id,
      connection_mode: r.connection_mode,
      grades: new Map((r.grades as Array<{ g: number; p: string }>).map((x) => [x.g, x.p])),
      nozzles: new Map(
        (r.nozzles as Array<{ pump: number; nozzle: number; tank: number | null; p: string | null }>).map((x) => [
          `${x.pump}:${x.nozzle}`,
          { tank_no: x.tank, product_code: x.p },
        ]),
      ),
      tanks: new Map(
        (r.tanks as Array<{ tank: number; p: string; low: number | null; cap: number }>).map((x) => [
          x.tank,
          { product_code: x.p, low_level_l: x.low === null ? null : Number(x.low), capacity_l: Number(x.cap) },
        ]),
      ),
    };
  }

  clear() {
    this.controllers.clear();
    this.gateways.clear();
    this.stations.clear();
  }
}
