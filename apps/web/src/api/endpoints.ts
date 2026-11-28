import { asItems, request, type Query } from './client';
import type {
  AiModel, Alert, AuthResponse, CapPrice, Compliance, DashboardOverview, Delivery, DemandForecast, FiscalReceipt,
  NationalReserve, Page, PricingResult, ProvinceDailyRow, ReconRow, RegOverview, RegProvince, RegProvinceStation,
  Pump, SalesBucket, Station, StationDetail, StockoutRow, Tank, Transaction, User, Anomaly,
} from '../types';

const a = (path: string, query?: Query) => request(path, { service: 'analytics', query });

export const api = {
  // ---- auth ----
  login: (email: string, password: string, totp_code?: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: totp_code ? { email, password, totp_code } : { email, password }, anonymous: true }),
  mfaEnroll: () => request<{ secret: string; otpauth_url: string }>('/auth/mfa/enroll', { method: 'POST', body: {} }),
  mfaVerify: (code: string) => request<{ mfa_enabled: boolean }>('/auth/mfa/verify', { method: 'POST', body: { code } }),
  mfaDisable: (code: string) => request<{ mfa_enabled: boolean }>('/auth/mfa/disable', { method: 'POST', body: { code } }),
  meDetails: () => request<User & { mfa_enabled?: boolean }>('/me'),
  logout: (refresh_token: string | null) =>
    request<void>('/auth/logout', { method: 'POST', body: refresh_token ? { refresh_token } : {} }),
  me: async () => {
    const r = await request<User | { user: User }>('/me');
    return (r && 'user' in r ? r.user : r) as User;
  },

  // ---- owner / manager ----
  dashboard: (query?: Query) => request<DashboardOverview>('/dashboard/overview', { query }),
  stations: async (query?: Query) => asItems<Station>(await request('/stations', { query })),
  station: (id: string) => request<StationDetail>(`/stations/${id}`),
  tanks: async (id: string) => asItems<Tank>(await request(`/stations/${id}/tanks`), 'tanks'),
  pumps: async (id: string) => asItems<Pump>(await request(`/stations/${id}/pumps`)),
  transactions: (id: string, query?: Query) => request<Page<Transaction>>(`/stations/${id}/transactions`, { query }),
  salesSummary: async (id: string, query: Query) =>
    asItems<SalesBucket>(await request(`/stations/${id}/sales/summary`, { query })),
  deliveries: async (id: string, query?: Query) => asItems<Delivery>(await request(`/stations/${id}/deliveries`, { query })),
  updateDelivery: (id: string | number, body: { delivery_note_no: string | null; supplier: string | null; invoiced_volume_l: number | null }) =>
    request<Delivery>(`/deliveries/${id}`, { method: 'PATCH', body }),
  reconciliation: async (id: string, query?: Query) =>
    asItems<ReconRow>(await request(`/stations/${id}/reconciliation`, { query })),
  setPrices: (id: string, body: { prices: { pts_grade_id: number; price: number }[]; effective_at?: string }) =>
    request<unknown>(`/stations/${id}/prices`, { method: 'PUT', body }),

  alerts: async (query?: Query) => asItems<Alert>(await request('/alerts', { query })),
  ackAlert: (id: string | number) => request<unknown>(`/alerts/${id}/ack`, { method: 'POST', body: {} }),

  receipts: (query?: Query) => request<Page<FiscalReceipt> | FiscalReceipt[]>('/fiscal/receipts', { query }),

  // ---- regulator ----
  regOverview: (query?: Query) => request<RegOverview>('/regulator/overview', { query }),
  regProvinces: async () => asItems<RegProvince>(await request('/regulator/provinces')),
  regProvinceStations: async (id: number) => asItems<RegProvinceStation>(await request(`/regulator/provinces/${id}/stations`)),
  regSalesDaily: async (query: Query) => asItems<ProvinceDailyRow>(await request('/regulator/sales/daily', { query })),
  regCompliance: (query?: Query) => request<Compliance>('/regulator/compliance', { query }),
  regPrices: async () => asItems<CapPrice>(await request('/regulator/prices')),
  regSetPrice: (body: { product_code: string; province_id: number | null; price: number; effective_at: string }) =>
    request<CapPrice>('/regulator/prices', { method: 'POST', body }),
  regExport: (query: Query) => request<Response>('/regulator/export', { query, raw: true }),

  // ---- analytics ----
  forecastDemand: (query: Query) => a('/forecast/demand', query) as Promise<DemandForecast>,
  stockout: async (query?: Query) => asItems<StockoutRow>(await a('/forecast/stockout', query)),
  reserve: () => a('/reserve/national') as Promise<NationalReserve>,
  anomalies: async (query?: Query) => asItems<Anomaly>(await a('/anomalies', query)),
  simulatePrice: (body: Record<string, unknown>) =>
    request<PricingResult>('/pricing/simulate', { service: 'analytics', method: 'POST', body }),
  models: async () => asItems<AiModel>(await a('/models')),
  predict: (name: string, inputs: unknown) =>
    request<{ outputs: Record<string, unknown>; model: string; version: string }>(
      `/models/${encodeURIComponent(name)}/predict`,
      { service: 'analytics', method: 'POST', body: { inputs } },
    ),

  // ---- admin (generic CRUD) ----
  adminList: async (entity: string, query?: Query) => asItems<Record<string, unknown>>(await request(`/admin/${entity}`, { query })),
  adminCreate: (entity: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/admin/${entity}`, { method: 'POST', body }),
  adminUpdate: (entity: string, id: string | number, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/admin/${entity}/${id}`, { method: 'PATCH', body }),
  adminDelete: (entity: string, id: string | number) => request<void>(`/admin/${entity}/${id}`, { method: 'DELETE' }),
  adminRotate: (entity: string, id: string | number) =>
    request<Record<string, unknown>>(`/admin/${entity}/${id}/rotate`, { method: 'POST', body: {} }),
  auditLog: (query?: Query) => request<Page<Record<string, unknown>>>('/admin/audit-log', { query }),
};
