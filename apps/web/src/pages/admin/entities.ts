import { PRODUCT_CODES, PROVINCES, ROLES, ROLE_LABELS, productLabel } from '../../types';

export type FieldType = 'text' | 'email' | 'number' | 'select' | 'multi' | 'checkbox' | 'password' | 'url';
export type FormValues = Record<string, unknown>;

export interface Opt {
  value: string;
  label: string;
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: Opt[];
  /** options loaded from another admin entity */
  ref?: { entity: string; label: (r: Record<string, unknown>) => string; filter?: (r: Record<string, unknown>, form: FormValues) => boolean };
  show?: (form: FormValues) => boolean;
  createOnly?: boolean;
  /** cannot be changed after creation (omitted from PATCH, shown read-only) */
  immutable?: boolean;
  hint?: string;
  step?: string;
  /** hide in table */
  hidden?: boolean;
  placeholder?: string;
}

export interface EntityDef {
  id: string;
  /** path under /api/v1/admin */
  path: string;
  label: string;
  singular: string;
  fields: FieldDef[];
  columns: string[];
  /** POST returns a secret shown once */
  secretOnCreate?: boolean;
  noEdit?: boolean;
  /** POST /admin/{path}/:id/rotate issues a new secret (shown once) */
  rotatable?: boolean;
}

const provinceOpts: Opt[] = PROVINCES.map((p) => ({ value: String(p.id), label: p.name }));
const productOpts: Opt[] = PRODUCT_CODES.map((p) => ({ value: p, label: productLabel(p) }));
const stationRef = { entity: 'stations', label: (r: Record<string, unknown>) => `${r.code ?? ''} · ${r.name ?? r.id}` };
const sameStation = (r: Record<string, unknown>, f: FormValues) => !f.station_id || String(r.station_id) === String(f.station_id);

export const SCOPES = ['stations:read', 'stock:read', 'sales:read', 'prices:read', 'alerts:read'];
export const WEBHOOK_EVENTS = ['daily_summary', 'critical_alert', 'stock_low'];

export const ENTITIES: EntityDef[] = [
  {
    id: 'companies', path: 'companies', label: 'Companies', singular: 'company',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'zra_tpin', label: 'ZRA TPIN', type: 'text', placeholder: '10 digits' },
      { name: 'erb_licence_no', label: 'ERB licence no', type: 'text' },
      { name: 'contact_email', label: 'Contact email', type: 'email' },
      { name: 'contact_phone', label: 'Contact phone', type: 'text', placeholder: '+260…' },
    ],
    columns: ['name', 'zra_tpin', 'erb_licence_no', 'contact_email', 'contact_phone'],
  },
  {
    id: 'stations', path: 'stations', label: 'Stations', singular: 'station',
    fields: [
      { name: 'company_id', label: 'Company', type: 'select', required: true, ref: { entity: 'companies', label: (r) => String(r.name) } },
      { name: 'code', label: 'Code', type: 'text', required: true, placeholder: 'LUS-0002' },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'province_id', label: 'Province', type: 'select', required: true, options: provinceOpts },
      { name: 'district', label: 'District', type: 'text' },
      { name: 'town', label: 'Town', type: 'text' },
      { name: 'address', label: 'Address', type: 'text', hidden: true },
      { name: 'latitude', label: 'Latitude', type: 'number', step: '0.000001', hidden: true },
      { name: 'longitude', label: 'Longitude', type: 'number', step: '0.000001', hidden: true },
      { name: 'erb_licence_no', label: 'ERB licence no', type: 'text', hidden: true },
      { name: 'zra_branch_id', label: 'ZRA branch ID (bhfId)', type: 'text', placeholder: '000', hidden: true },
      { name: 'status', label: 'Status', type: 'select', options: ['active', 'commissioning', 'suspended', 'closed'].map((v) => ({ value: v, label: v })) },
      { name: 'connection_mode', label: 'Connection mode', type: 'select', options: [{ value: 'edge', label: 'Edge gateway' }, { value: 'direct', label: 'Direct (PTS-2 → cloud)' }] },
    ],
    columns: ['code', 'name', 'company_id', 'province_id', 'town', 'status', 'connection_mode'],
  },
  {
    id: 'tanks', path: 'tanks', label: 'Tanks', singular: 'tank',
    fields: [
      { name: 'station_id', label: 'Station', type: 'select', required: true, ref: stationRef, immutable: true },
      { name: 'tank_no', label: 'Tank no (PTS-2)', type: 'number', required: true },
      { name: 'product_code', label: 'Product', type: 'select', required: true, options: productOpts },
      { name: 'capacity_l', label: 'Capacity (L)', type: 'number', required: true },
      { name: 'low_level_l', label: 'Reorder level (L)', type: 'number' },
    ],
    columns: ['station_id', 'tank_no', 'product_code', 'capacity_l', 'low_level_l'],
  },
  {
    id: 'fuel_grades', path: 'fuel_grades', label: 'Fuel grades', singular: 'fuel grade',
    fields: [
      { name: 'station_id', label: 'Station', type: 'select', required: true, ref: stationRef, immutable: true },
      { name: 'pts_grade_id', label: 'PTS-2 grade ID', type: 'number', required: true },
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'product_code', label: 'Product', type: 'select', required: true, options: productOpts },
      { name: 'zra_item_code', label: 'ZRA item code', type: 'text' },
      { name: 'price', label: 'Price (ZMW/L)', type: 'number', step: '0.01', required: true },
    ],
    columns: ['station_id', 'pts_grade_id', 'name', 'product_code', 'zra_item_code', 'price'],
  },
  {
    id: 'nozzles', path: 'nozzles', label: 'Nozzles', singular: 'nozzle',
    fields: [
      { name: 'station_id', label: 'Station', type: 'select', required: true, ref: stationRef, immutable: true },
      { name: 'pump_no', label: 'Pump no', type: 'number', required: true },
      { name: 'nozzle_no', label: 'Nozzle no', type: 'number', required: true },
      { name: 'fuel_grade_id', label: 'Fuel grade', type: 'select', ref: { entity: 'fuel_grades', label: (r) => `${r.name} (#${r.pts_grade_id})`, filter: sameStation } },
      { name: 'tank_id', label: 'Tank', type: 'select', ref: { entity: 'tanks', label: (r) => `Tank ${r.tank_no} · ${productLabel(String(r.product_code))}`, filter: sameStation } },
    ],
    columns: ['station_id', 'pump_no', 'nozzle_no', 'fuel_grade_id', 'tank_id'],
  },
  {
    id: 'controllers', path: 'controllers', label: 'Controllers', singular: 'controller',
    fields: [
      { name: 'station_id', label: 'Station', type: 'select', required: true, ref: stationRef },
      { name: 'pts_id', label: 'PTS-2 ID (24 hex)', type: 'text', required: true, placeholder: '003B00265030500420303531' },
      { name: 'hmac_secret', label: 'HMAC secret key', type: 'password', hint: 'As configured in PTS-2 remote server settings. Leave blank to keep / none.', hidden: true },
      { name: 'firmware', label: 'Firmware', type: 'text' },
    ],
    columns: ['station_id', 'pts_id', 'firmware', 'last_seen_at'],
  },
  {
    id: 'users', path: 'users', label: 'Users', singular: 'user',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'full_name', label: 'Full name', type: 'text', required: true },
      { name: 'phone', label: 'Phone', type: 'text', hidden: true },
      { name: 'role', label: 'Role', type: 'select', required: true, options: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
      { name: 'company_id', label: 'Company', type: 'select', required: true, ref: { entity: 'companies', label: (r) => String(r.name) }, show: (f) => f.role === 'owner' || f.role === 'manager' },
      { name: 'province_id', label: 'Province', type: 'select', required: true, options: provinceOpts, show: (f) => f.role === 'erb_provincial' },
      {
        name: 'station_ids', label: 'Stations managed', type: 'multi', hidden: true, show: (f) => f.role === 'manager',
        ref: { entity: 'stations', label: (r) => `${r.code} · ${r.name}`, filter: (r, f) => !f.company_id || String(r.company_id) === String(f.company_id) },
      },
      { name: 'password', label: 'Initial password', type: 'password', required: true, createOnly: true, hint: 'At least 10 characters. The user should change it at first login.', hidden: true },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    columns: ['email', 'full_name', 'role', 'company_id', 'province_id', 'is_active', 'last_login_at'],
  },
  {
    id: 'gateways', path: 'gateways', label: 'Edge gateways', singular: 'gateway', secretOnCreate: true, rotatable: true,
    fields: [
      { name: 'station_id', label: 'Station', type: 'select', required: true, ref: stationRef },
      { name: 'gateway_code', label: 'Gateway code', type: 'text', required: true, placeholder: 'GW-LUS-0002' },
      { name: 'role', label: 'Role', type: 'select', options: [{ value: 'primary', label: 'Primary' }, { value: 'standby', label: 'Hot standby' }] },
    ],
    columns: ['gateway_code', 'station_id', 'role', 'version', 'last_seen_at', 'last_backlog'],
  },
  {
    id: 'api-clients', path: 'api-clients', label: 'API clients', singular: 'API client', secretOnCreate: true, rotatable: true,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'organisation', label: 'Organisation', type: 'text', required: true },
      { name: 'scopes', label: 'Scopes', type: 'multi', required: true, options: SCOPES.map((s) => ({ value: s, label: s })) },
      { name: 'province_id', label: 'Province scope', type: 'select', options: provinceOpts, hint: 'Blank = national' },
      { name: 'company_id', label: 'Company scope', type: 'select', ref: { entity: 'companies', label: (r) => String(r.name) }, hint: 'Blank = all companies' },
      { name: 'rate_limit_rpm', label: 'Rate limit (requests/min)', type: 'number' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    columns: ['name', 'organisation', 'key_prefix', 'scopes', 'province_id', 'rate_limit_rpm', 'is_active'],
  },
  {
    id: 'webhooks', path: 'webhooks', label: 'Webhooks', singular: 'webhook', secretOnCreate: true, rotatable: true,
    fields: [
      { name: 'api_client_id', label: 'API client', type: 'select', required: true, immutable: true, ref: { entity: 'api-clients', label: (r) => `${r.name} (${r.organisation})` } },
      { name: 'url', label: 'URL (https)', type: 'url', required: true, placeholder: 'https://partner.example/fms/webhook' },
      { name: 'events', label: 'Events', type: 'multi', required: true, options: WEBHOOK_EVENTS.map((s) => ({ value: s, label: s })) },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    columns: ['url', 'api_client_id', 'events', 'is_active'],
  },
];

export const entityById = (id: string) => ENTITIES.find((e) => e.id === id);

/** Pick a one-time secret out of a create response (field names vary by resource). */
export function extractSecret(res: Record<string, unknown> | undefined): { label: string; value: string } | null {
  if (!res) return null;
  for (const k of ['api_key', 'gateway_key', 'key', 'secret', 'plain_key', 'token']) {
    const v = res[k];
    if (typeof v === 'string' && v) return { label: k, value: v };
  }
  return null;
}

/** Strip hidden/conditional fields and coerce types before sending to the API. */
export function toPayload(def: EntityDef, form: FormValues, isCreate: boolean): FormValues {
  const out: FormValues = {};
  for (const f of def.fields) {
    if (f.show && !f.show(form)) {
      if (['company_id', 'province_id'].includes(f.name)) out[f.name] = null;
      continue;
    }
    if ((f.createOnly || f.immutable) && !isCreate) continue;
    let v = form[f.name];
    if (f.type === 'password' && (v === '' || v == null)) continue;
    if (f.type === 'number') v = v === '' || v == null ? null : Number(v);
    else if (f.type === 'checkbox') v = !!v;
    else if (f.type === 'multi') v = Array.isArray(v) ? v : [];
    else if (f.type === 'select' && (f.name === 'province_id')) v = v === '' || v == null ? null : Number(v);
    else if (v === '') v = null;
    out[f.name] = v;
  }
  return out;
}

export function validate(def: EntityDef, form: FormValues, isCreate: boolean): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const f of def.fields) {
    if (f.show && !f.show(form)) continue;
    if (f.createOnly && !isCreate) continue;
    const v = form[f.name];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (f.required && empty && f.type !== 'checkbox') errs[f.name] = 'Required';
    else if (!empty && f.type === 'number' && !Number.isFinite(Number(v))) errs[f.name] = 'Must be a number';
    else if (!empty && f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) errs[f.name] = 'Invalid email';
    else if (!empty && f.type === 'url' && !/^https?:\/\//.test(String(v))) errs[f.name] = 'Must start with https://';
    else if (!empty && f.name === 'password' && String(v).length < 10) errs[f.name] = 'At least 10 characters';
    else if (!empty && f.name === 'pts_id' && !/^[0-9A-Fa-f]{24}$/.test(String(v))) errs[f.name] = '24 hex characters';
  }
  return errs;
}
