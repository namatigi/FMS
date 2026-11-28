// Constants copied from packages/shared/src/index.ts (no runtime dependency on @fms/shared).
export const PROVINCES = [
  { id: 1, code: 'CEN', name: 'Central' },
  { id: 2, code: 'COP', name: 'Copperbelt' },
  { id: 3, code: 'EAS', name: 'Eastern' },
  { id: 4, code: 'LUA', name: 'Luapula' },
  { id: 5, code: 'LUS', name: 'Lusaka' },
  { id: 6, code: 'MUC', name: 'Muchinga' },
  { id: 7, code: 'NOR', name: 'Northern' },
  { id: 8, code: 'NWE', name: 'North-Western' },
  { id: 9, code: 'SOU', name: 'Southern' },
  { id: 10, code: 'WES', name: 'Western' },
] as const;

export function provinceName(id: number | null | undefined): string {
  return PROVINCES.find((p) => p.id === id)?.name ?? (id == null ? 'National' : `Province ${id}`);
}

export const PRODUCT_CODES = ['PETROL', 'DIESEL', 'KEROSENE', 'JETA1', 'LPG'] as const;
export type ProductCode = (typeof PRODUCT_CODES)[number];

export const PRODUCT_LABELS: Record<string, string> = {
  PETROL: 'Petrol',
  DIESEL: 'Diesel',
  KEROSENE: 'Kerosene',
  JETA1: 'Jet A-1',
  LPG: 'LPG',
};
export const productLabel = (c: string) => PRODUCT_LABELS[c] ?? c;

export type UserRole = 'platform_admin' | 'owner' | 'manager' | 'erb_national' | 'erb_provincial' | 'zra_auditor';

export const ROLE_LABELS: Record<UserRole, string> = {
  platform_admin: 'Platform admin',
  owner: 'Owner',
  manager: 'Station manager',
  erb_national: 'ERB (national)',
  erb_provincial: 'ERB (provincial)',
  zra_auditor: 'ZRA auditor',
};

export const ROLES = Object.keys(ROLE_LABELS) as UserRole[];

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  company_id: string | null;
  province_id: number | null;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: User;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export type Connectivity = 'online' | 'degraded' | 'offline' | string;

export interface ProductPosition {
  product_code: string;
  sales_today_l: number;
  sales_today_amount: number;
  stock_l: number;
  capacity_l: number;
}

export interface LowStockTank {
  station_id: string;
  station_name: string;
  tank_no: number;
  product_code: string;
  product_volume_l: number;
  capacity_l: number;
  fill_pct: number;
}

export interface DashboardOverview {
  stations_total: number;
  stations_online: number;
  stations_offline: number;
  sales_today: { volume_l: number; amount: number; tx_count: number };
  by_product: ProductPosition[];
  low_stock_tanks: LowStockTank[];
  open_alerts: { critical: number; warning: number };
  as_of?: string;
}

export interface Station {
  id: string;
  code: string;
  name: string;
  company_id: string;
  company_name: string;
  province_id: number;
  province_name: string;
  district: string | null;
  town: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  connectivity: Connectivity;
  controller_last_seen_at: string | null;
}

export interface Tank {
  tank_no: number;
  product_code: string;
  capacity_l: number;
  product_volume_l: number | null;
  ullage_l: number | null;
  water_height_mm: number | null;
  temperature_c: number | null;
  fill_pct: number | null;
  measured_at: string | null;
  probe_status: string | null;
  alarms: string[] | null;
  avg_daily_sales_l: number | null;
  days_of_cover: number | null;
}

export interface PumpNozzle {
  nozzle_no: number;
  /** false when the pump/nozzle sold fuel but is missing from the station's nozzle configuration */
  configured: boolean;
  pts_grade_id: number | null;
  grade_name: string | null;
  product_code: string | null;
  tank_no: number | null;
  price: number | null;
  /** Non-resettable electronic totalisers reported with the nozzle's latest sale. */
  total_volume_l: number | null;
  total_amount: number | null;
  last_sale_at: string | null;
  today_volume_l: number;
  today_amount: number;
  today_tx: number;
}

export interface Pump {
  pump_no: number;
  configured: boolean;
  /** PTS-2 pump state from the controller's latest status ('idle', 'filling', 'offline', ...), or 'unknown' when the controller has not reported recently. */
  status?: string;
  status_at?: string | null;
  last_sale_at: string | null;
  today_volume_l: number;
  today_amount: number;
  today_tx: number;
  nozzles: PumpNozzle[];
}

export interface FuelGrade {
  id?: string;
  pts_grade_id: number;
  name: string;
  product_code: string;
  price: number;
  zra_item_code?: string | null;
}

export interface Nozzle {
  id?: string;
  pump_no: number;
  nozzle_no: number;
  fuel_grade_id?: string | null;
  tank_id?: string | null;
}

export interface StationDetail extends Station {
  tanks: Tank[];
  fuel_grades: FuelGrade[];
  nozzles: Nozzle[];
  health: {
    controller_last_seen_at?: string | null;
    gateway_last_seen_at?: string | null;
    gateway_backlog?: number | null;
    connectivity?: Connectivity;
  } | null;
}

export type FiscalStatus = 'pending' | 'signed' | 'failed' | 'exempt' | 'printed' | string;

export interface Transaction {
  id: string | number;
  ended_at: string;
  pump_no: number;
  nozzle_no: number;
  product_code: string;
  volume_l: number;
  price: number;
  amount: number;
  tag: string | null;
  fiscal_status: FiscalStatus;
  zra_rcpt_no: string | null;
}

export interface SalesBucket {
  bucket: string;
  product_code: string | null;
  pump_no?: number | null;
  volume_l: number;
  amount: number;
  tx_count: number;
}

export interface Delivery {
  id: string | number;
  station_id: string;
  tank_no: number;
  product_code: string | null;
  started_at: string;
  ended_at: string;
  start_volume_l: number | null;
  end_volume_l: number | null;
  received_volume_l: number | null;
  delivery_note_no: string | null;
  supplier: string | null;
  invoiced_volume_l: number | null;
}

export interface ReconRow {
  station_id: string;
  business_date: string;
  product_code: string;
  province_id?: number;
  sales_volume_l: number;
  sales_amount: number;
  tx_count: number;
  opening_stock_l: number | null;
  closing_stock_l: number | null;
  deliveries_l: number;
  variance_l: number | null;
  avg_price: number | null;
}

export interface Alert {
  id: string | number;
  station_id: string;
  station_name?: string;
  occurred_at: string;
  device_type: string;
  device_no: number | null;
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string | null;
  acknowledged_at: string | null;
}

export interface FiscalReceipt {
  id: string | number;
  station_id: string;
  station_name?: string;
  pump_no: number;
  pts_transaction_no: number;
  tx_ended_at: string;
  invoice_no: string;
  status: string;
  fiscalised_by: string;
  zra_rcpt_no: string | null;
  zra_sdc_id: string | null;
  zra_mrc_no: string | null;
  zra_qr_url: string | null;
  zra_signed_at: string | null;
  attempts: number;
  last_error: string | null;
  amount?: number;
  volume_l?: number;
  product_code?: string;
}

// ---- Regulator ----
export interface RegProduct {
  product_code: string;
  stock_l: number;
  capacity_l: number;
  sales_24h_l: number;
  days_of_cover: number | null;
}
export interface RegOverview {
  by_product: RegProduct[];
  stations: { total: number; online: number; offline: number };
  alerts_open: number;
  as_of?: string;
}
export interface RegProvince {
  province_id: number;
  province_name: string;
  stations: number;
  online: number;
  by_product: RegProduct[];
}
export interface RegProvinceStation {
  station_id: string;
  code: string;
  name: string;
  company_name: string;
  connectivity: Connectivity;
  stock: { product_code: string; stock_l: number; capacity_l: number }[];
  last_price: { product_code: string; price: number }[];
}
export interface ProvinceDailyRow {
  province_id: number;
  business_date: string;
  product_code: string;
  reporting_stations: number;
  sales_volume_l: number;
  sales_amount: number;
  deliveries_l: number;
  closing_stock_l: number | null;
  variance_l: number | null;
  avg_price: number | null;
}
export type ComplianceRow = Record<string, unknown>;
export interface Compliance {
  price_violations: ComplianceRow[];
  offline_stations: ComplianceRow[];
  variance_anomalies: ComplianceRow[];
  fiscal_failures: ComplianceRow[];
}
export interface CapPrice {
  id?: string | number;
  product_code: string;
  province_id: number | null;
  price: number;
  effective_at: string;
}

// ---- Analytics ----
export interface DemandForecast {
  history: { date: string; value: number }[];
  forecast: { date: string; value: number; lower: number; upper: number }[];
  model: string;
  mape: number | null;
}
export type Risk = 'high' | 'medium' | 'low';
export interface StockoutRow {
  station_id: string;
  station_name: string;
  product_code: string;
  stock_l: number;
  avg_daily_sales_l: number;
  days_of_cover: number | null;
  predicted_stockout_date: string | null;
  risk: Risk;
}
export interface ReserveProvince {
  province_id: number;
  province_name?: string;
  stock_l: number;
  avg_daily_demand_l?: number;
  days_of_cover: number | null;
  risk?: string;
}
export interface ReserveProduct {
  product_code: string;
  stock_l: number;
  capacity_l: number;
  avg_daily_demand_l: number;
  days_of_cover: number | null;
  risk: string;
  by_province: ReserveProvince[];
}
export interface NationalReserve {
  as_of: string;
  by_product: ReserveProduct[];
}
export interface Anomaly {
  station_id: string;
  station_name?: string;
  business_date: string;
  product_code: string;
  variance_l: number | null;
  variance_pct: number | null;
  zscore: number | null;
  kind: string;
}
export interface PricingBreakdownItem {
  component?: string;
  label?: string;
  name?: string;
  value?: number;
  amount?: number;
  zmw_per_l?: number;
}
export interface PricingResult {
  indicative_price: number;
  breakdown: PricingBreakdownItem[];
  model: string;
}
export interface AiModel {
  name: string;
  kind?: string;
  type?: string;
  version?: string;
  description?: string;
  example_inputs?: Record<string, unknown>;
}
