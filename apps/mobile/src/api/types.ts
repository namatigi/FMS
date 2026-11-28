/**
 * API shapes from docs/api/CONTRACTS.md (core-api /api/v1, analytics /analytics/v1).
 * Copied (not imported) from @fms/shared so the app stays standalone.
 * Fields marked "optional" are not pinned down by the contract; the UI tolerates their absence.
 */

export const PRODUCT_CODES = ['PETROL', 'DIESEL', 'KEROSENE', 'JETA1', 'LPG'] as const;
export type ProductCode = (typeof PRODUCT_CODES)[number];

export type UserRole = 'platform_admin' | 'owner' | 'manager' | 'erb_national' | 'erb_provincial' | 'zra_auditor';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type Connectivity = 'online' | 'degraded' | 'offline';
export type FiscalStatus = 'pending' | 'signed' | 'failed' | 'exempt' | 'printed';

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

export interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface DashboardOverview {
  stations_total: number;
  stations_online: number;
  stations_offline: number;
  sales_today: { volume_l: number; amount: number; tx_count: number };
  by_product: {
    product_code: string;
    sales_today_l: number;
    sales_today_amount: number;
    stock_l: number;
    capacity_l: number;
  }[];
  low_stock_tanks: {
    station_id: string;
    station_name: string;
    tank_no: number;
    product_code: string;
    product_volume_l: number;
    capacity_l: number;
    fill_pct: number;
  }[];
  open_alerts: { critical: number; warning: number };
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

export interface FuelGrade {
  id?: string;
  pts_grade_id: number;
  name: string;
  product_code: string;
  price: number;
  /** Proposed contract addition: ERB cap in force for this product & station province. */
  erb_cap?: number | null;
}

export interface Nozzle {
  pump_no: number;
  nozzle_no: number;
  pts_grade_id?: number;
  product_code?: string;
  tank_no?: number;
}

export interface StationHealth {
  connectivity?: Connectivity;
  controller_last_seen_at?: string | null;
  gateway_last_seen_at?: string | null;
  gateway_backlog?: number | null;
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

/** One nozzle of a pump (GET /stations/:id/pumps). */
export interface PumpNozzle {
  nozzle_no: number;
  /** false when the nozzle sold fuel but is missing from the station's nozzle configuration */
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
  last_sale_at: string | null;
  today_volume_l: number;
  today_amount: number;
  today_tx: number;
  nozzles: PumpNozzle[];
}

export interface StationDetail extends Station {
  tanks: Partial<Tank>[];
  fuel_grades: FuelGrade[];
  nozzles: Nozzle[];
  health: StationHealth;
}

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
  zra_rcpt_no: string | number | null;
}

/** bucket: hour = UTC ISO of Lusaka hour start; day = YYYY-MM-DD; product = product code; pump = pump number as string. */
export interface SalesSummaryRow {
  bucket: string;
  product_code: string | null;
  pump_no?: number | null;
  volume_l: number;
  amount: number;
  tx_count: number;
}

/** Shape from fms.tank_deliveries (contract does not list fields). */
export interface Delivery {
  id: string | number;
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

/** Shape from fms.alerts (contract does not list fields). */
export interface Alert {
  id: string | number;
  station_id: string;
  station_name?: string;
  station_code?: string;
  occurred_at: string;
  device_type: string;
  device_no: number | null;
  code: string;
  severity: AlertSeverity;
  message: string | null;
  data?: Record<string, unknown> | null;
  acknowledged_at: string | null;
  acknowledged_by?: string | null;
}

export interface StockoutRow {
  station_id: string;
  station_name: string;
  product_code: string;
  stock_l: number;
  avg_daily_sales_l: number;
  days_of_cover: number | null;
  predicted_stockout_date: string | null;
  risk: 'high' | 'medium' | 'low';
}

export interface PriceUpdateRequest {
  prices: { pts_grade_id: number; price: number }[];
  effective_at?: string;
}

/** PUT /stations/:id/prices response. Over cap -> 422 error.code 'price_above_cap'. */
export interface PriceUpdateResponse {
  station_id: string;
  effective_at: string;
  command_id: string;
  /** Delivery status of the price command to the station gateway; 'queued' right after the update. */
  command_status: 'queued' | 'delivered' | 'received' | 'applied' | 'partial' | 'failed' | 'expired' | 'cancelled';
  prices: { pts_grade_id: number; price: number }[];
}

/** GET /api/v1/regulator/prices (regulator/admin only today). */
export interface ErbCapPrice {
  product_code: string;
  province_id: number | null;
  price: number;
  effective_at: string;
}
