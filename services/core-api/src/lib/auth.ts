import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@fms/shared';
import { verifyJwt } from './crypto.js';
import { forbidden, unauthorized } from '../errors.js';
import type { Principal } from './scope.js';

export type UserPrincipal = Extract<Principal, { kind: 'user' }>;

function bearer(req: FastifyRequest, allowQueryToken: boolean): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  if (allowQueryToken) {
    const q = (req.query as Record<string, unknown> | undefined)?.token;
    if (typeof q === 'string' && q) return q;
  }
  return null;
}

/** preHandler: authenticate a user JWT and optionally require one of `roles`. */
export function requireUser(roles?: readonly UserRole[], opts: { allowQueryToken?: boolean } = {}) {
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const tok = bearer(req, !!opts.allowQueryToken);
    if (!tok) throw unauthorized();
    const claims = verifyJwt(tok, req.server.config.jwtSecret);
    if (!claims) throw unauthorized('invalid or expired token', 'invalid_token');
    req.principal = {
      kind: 'user',
      id: claims.sub,
      role: claims.role,
      company_id: claims.company_id ?? null,
      province_id: claims.province_id ?? null,
      name: claims.name,
    };
    if (roles && !roles.includes(claims.role)) throw forbidden();
  };
}

/** Role guard to be used after requireUser(). */
export function requireRoles(...roles: UserRole[]) {
  return async function (req: FastifyRequest) {
    const p = req.principal;
    if (!p || p.kind !== 'user' || !roles.includes(p.role)) throw forbidden();
  };
}

export function userOf(req: FastifyRequest): UserPrincipal {
  const p = req.principal;
  if (!p || p.kind !== 'user') throw unauthorized();
  return p;
}

export const READ_ROLES: readonly UserRole[] = ['platform_admin', 'owner', 'manager', 'erb_national', 'erb_provincial', 'zra_auditor'];
export const OPERATOR_ROLES: readonly UserRole[] = ['platform_admin', 'owner', 'manager'];
export const REGULATOR_ROLES: readonly UserRole[] = ['platform_admin', 'erb_national', 'erb_provincial'];
export const MFA_ROLES: readonly UserRole[] = ['platform_admin', 'erb_national', 'erb_provincial'];
