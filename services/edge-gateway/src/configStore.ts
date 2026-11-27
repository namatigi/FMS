/**
 * Station + fuel-grade configuration persisted in edge.config / edge.fuel_grades, cached in memory.
 * Seeded on start (and on reload_config) from env / EDGE_CONFIG_FILE. Prices are owned by the
 * set_prices command once set, so seeding only fills a price that is still NULL.
 */
import type { Pool } from './db.js';
import { readConfigFile, type FuelGradeConfig, type GatewayConfig, type StationConfig } from './config.js';

export interface FuelGrade {
  pts_grade_id: number;
  name: string;
  product_code: string | null;
  zra_item_code: string | null;
  zra_item_class_code: string | null;
  zra_item_name: string | null;
  vat_category: string;
  vat_rate_pct: number;
  price: number | null;
}

export class ConfigStore {
  station: StationConfig;
  private grades = new Map<number, FuelGrade>();

  constructor(private readonly pool: Pool, private readonly cfg: GatewayConfig) {
    this.station = { ...cfg.station };
  }

  grade(id: number | null | undefined): FuelGrade | undefined {
    return id == null ? undefined : this.grades.get(id);
  }

  allGrades(): FuelGrade[] {
    return [...this.grades.values()].sort((a, b) => a.pts_grade_id - b.pts_grade_id);
  }

  async seed(grades: FuelGradeConfig[], station: StationConfig): Promise<void> {
    await this.pool.query(
      `INSERT INTO edge.config(key, value) VALUES ('station', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(station)],
    );
    for (const g of grades) {
      await this.pool.query(
        `INSERT INTO edge.fuel_grades (pts_grade_id, name, product_code, zra_item_code, zra_item_class_code, zra_item_name, vat_category, vat_rate_pct, price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (pts_grade_id) DO UPDATE SET name = EXCLUDED.name, product_code = EXCLUDED.product_code,
           zra_item_code = EXCLUDED.zra_item_code, zra_item_class_code = EXCLUDED.zra_item_class_code,
           zra_item_name = EXCLUDED.zra_item_name, vat_category = EXCLUDED.vat_category, vat_rate_pct = EXCLUDED.vat_rate_pct,
           price = COALESCE(edge.fuel_grades.price, EXCLUDED.price), updated_at = now()`,
        [g.pts_grade_id, g.name, g.product_code ?? null, g.zra_item_code ?? null, g.zra_item_class_code ?? null,
          g.zra_item_name ?? null, g.vat_category ?? 'A', g.vat_rate_pct ?? 16, g.price ?? null],
      );
    }
  }

  async load(): Promise<void> {
    const st = await this.pool.query<{ value: StationConfig }>(`SELECT value FROM edge.config WHERE key = 'station'`);
    if (st.rows[0]) this.station = st.rows[0].value;
    const r = await this.pool.query<FuelGrade>('SELECT * FROM edge.fuel_grades');
    this.grades = new Map(r.rows.map((g) => [g.pts_grade_id, g]));
  }

  /** Start-up: seed from env/config file, then load. */
  async init(): Promise<void> {
    await this.seed(this.cfg.fuelGrades, this.cfg.station);
    await this.load();
  }

  /** reload_config command: re-read EDGE_CONFIG_FILE (if any) and refresh caches. */
  async reload(): Promise<{ grades: number; file: string | null }> {
    if (this.cfg.configFile) {
      const f = readConfigFile(this.cfg.configFile);
      await this.seed(f.fuel_grades ?? this.cfg.fuelGrades, { ...this.cfg.station, ...(f.station ?? {}) } as StationConfig);
    }
    await this.load();
    return { grades: this.grades.size, file: this.cfg.configFile };
  }

  async setPrice(ptsGradeId: number, price: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO edge.fuel_grades (pts_grade_id, name, price) VALUES ($1, $2, $3)
       ON CONFLICT (pts_grade_id) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
      [ptsGradeId, `Grade ${ptsGradeId}`, price],
    );
    await this.load();
  }
}
