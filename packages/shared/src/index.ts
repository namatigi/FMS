export * from './records.js';
export * from './jsonpts.js';
export * from './fiscal.js';
export * from './security.js';

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

export const PRODUCT_CODES = ['PETROL', 'DIESEL', 'KEROSENE', 'JETA1', 'LPG'] as const;
export type ProductCode = (typeof PRODUCT_CODES)[number];

export type UserRole = 'platform_admin' | 'owner' | 'manager' | 'erb_national' | 'erb_provincial' | 'zra_auditor';

/** JWT claims issued by core-api and accepted by every cloud service (HS256, secret JWT_SECRET). */
export interface FmsJwtClaims {
  sub: string;                 // user id
  role: UserRole;
  company_id: string | null;
  province_id: number | null;
  name: string;
  iat: number;
  exp: number;
}
