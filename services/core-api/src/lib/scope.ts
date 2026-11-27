import type { UserRole } from '@fms/shared';
import type { Queryable } from './types.js';
import { Params, isUuid } from './sql.js';
import { notFound } from '../errors.js';

/**
 * The caller, as far as data scoping is concerned. Users come from the JWT;
 * partner API clients from fms.api_clients.
 */
export type Principal =
  | { kind: 'user'; id: string; role: UserRole; company_id: string | null; province_id: number | null; name: string }
  | { kind: 'api_client'; id: string; company_id: string | null; province_id: number | null; scopes: string[]; name: string; rate_limit_rpm: number };

/**
 * THE central scoping function. Returns a SQL boolean predicate over a
 * `fms.stations` row aliased as `alias` (columns id, company_id, province_id),
 * adding any bind values to `p`. Every station-related query must AND this in.
 *
 *  platform_admin / erb_national / zra_auditor -> all stations
 *  owner          -> company_id = claim company
 *  manager        -> station in user_station_access
 *  erb_provincial -> province_id = claim province
 *  api_client     -> optional province_id and company_id limits
 */
export function stationScope(pr: Principal, p: Params, alias = 's'): string {
  if (pr.kind === 'api_client') {
    const conds: string[] = [];
    if (pr.province_id != null) conds.push(`${alias}.province_id = ${p.add(pr.province_id)}`);
    if (pr.company_id != null) conds.push(`${alias}.company_id = ${p.add(pr.company_id)}`);
    return conds.length ? `(${conds.join(' AND ')})` : 'TRUE';
  }
  switch (pr.role) {
    case 'platform_admin':
    case 'erb_national':
    case 'zra_auditor':
      return 'TRUE';
    case 'owner':
      return pr.company_id ? `${alias}.company_id = ${p.add(pr.company_id)}` : 'FALSE';
    case 'manager':
      return `${alias}.id IN (SELECT usa.station_id FROM fms.user_station_access usa WHERE usa.user_id = ${p.add(pr.id)})`;
    case 'erb_provincial':
      return pr.province_id != null ? `${alias}.province_id = ${p.add(pr.province_id)}` : 'FALSE';
    default:
      return 'FALSE';
  }
}

/** Predicate for tables that carry only a station_id column. */
export function stationIdScope(pr: Principal, p: Params, col = 'station_id'): string {
  const pred = stationScope(pr, p, 'sc');
  if (pred === 'TRUE') return 'TRUE';
  return `${col} IN (SELECT sc.id FROM fms.stations sc WHERE ${pred})`;
}

/** Resolve a station id the caller may see, or throw 404 (never 403). */
export async function assertStationInScope(db: Queryable, pr: Principal, stationId: string): Promise<{ id: string; province_id: number; company_id: string; timezone: string; code: string; name: string }> {
  if (!isUuid(stationId)) throw notFound('station');
  const p = new Params([stationId]);
  const { rows } = await db.query(
    `SELECT s.id, s.province_id, s.company_id, s.timezone, s.code, s.name FROM fms.stations s WHERE s.id = $1 AND ${stationScope(pr, p)}`,
    p.values,
  );
  if (!rows[0]) throw notFound('station');
  return rows[0];
}

/**
 * Province used by regulator endpoints. erb_provincial is forced to its own
 * province regardless of what was requested.
 */
export function regulatorProvince(pr: Principal, requested: number | undefined | null): number | null {
  if (pr.kind === 'user' && pr.role === 'erb_provincial') return pr.province_id ?? -1;
  if (pr.kind === 'api_client' && pr.province_id != null) return pr.province_id;
  return requested ?? null;
}
