import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sha256Hex, type UserRole } from '@fms/shared';
import { verifyPassword, signJwt, randomToken, generateTotpSecret, verifyTotp, otpauthUrl } from '../lib/crypto.js';
import { requireUser, userOf, MFA_ROLES } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { verifyJwt } from '../lib/crypto.js';
import { HttpError, unauthorized, badRequest } from '../errors.js';
import type { Queryable } from '../lib/types.js';
import { withTx } from '../db.js';

const MAX_FAILURES = 5;
const LOCK_WINDOW_MIN = 15;

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  company_id: string | null;
  province_id: number | null;
  is_active: boolean;
  password_hash: string;
  mfa_secret: string | null;
}

const userShape = z.object({
  id: z.string(),
  email: z.string(),
  full_name: z.string(),
  role: z.string(),
  company_id: z.string().nullable(),
  province_id: z.number().nullable(),
});
const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  token_type: z.literal('Bearer'),
  user: userShape,
});

const publicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  company_id: u.company_id,
  province_id: u.province_id,
});

async function issueTokens(db: Queryable, req: FastifyRequest, u: UserRow, familyId: string = randomUUID()) {
  const cfg = req.server.config;
  const access = signJwt(
    { sub: u.id, role: u.role, company_id: u.company_id, province_id: u.province_id, name: u.full_name },
    cfg.jwtSecret,
    cfg.accessTtlSec,
  );
  const refresh = randomToken(32);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO fms.refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, now() + make_interval(days => $4::int), $5, $6) RETURNING id`,
    [u.id, familyId, sha256Hex(refresh), cfg.refreshTtlDays, (req.headers['user-agent'] ?? '').slice(0, 300), req.ip],
  );
  return {
    tokenId: rows[0]!.id,
    body: { access_token: access, refresh_token: refresh, expires_in: cfg.accessTtlSec, token_type: 'Bearer' as const, user: publicUser(u) },
  };
}

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = app.db;

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: app.config.loginRateLimitRpm, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Log in with email + password (+ totp_code when MFA is enabled)',
        security: [],
        body: z.object({ email: z.string().email().max(320), password: z.string().min(1).max(512), totp_code: z.string().optional() }),
        response: { 200: tokenResponse },
      },
    },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      const { rows: fails } = await db.primary.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM fms.login_attempts
          WHERE email = $1 AND NOT success AND reason IN ('bad_password','bad_totp')
            AND attempted_at > now() - make_interval(mins => $2::int)
            AND attempted_at > coalesce((SELECT max(attempted_at) FROM fms.login_attempts WHERE email = $1 AND success), '-infinity')`,
        [email, LOCK_WINDOW_MIN],
      );
      if ((fails[0]?.n ?? 0) >= MAX_FAILURES) {
        await db.primary.query(`INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,false,'locked')`, [email, req.ip]);
        app.metrics.logins.labels('locked').inc();
        await audit(db.primary, req, { action: 'auth.login_locked', entity: 'user', details: { email }, actor_type: 'anonymous' });
        throw new HttpError(429, 'account_locked', `too many failed attempts; try again in ${LOCK_WINDOW_MIN} minutes`);
      }

      const { rows } = await db.primary.query<UserRow>(
        `SELECT id, email::text, full_name, role, company_id, province_id, is_active, password_hash, mfa_secret
           FROM fms.users WHERE email = $1`,
        [email],
      );
      const u = rows[0];
      const pwOk = await verifyPassword(req.body.password, u?.password_hash);
      if (!u || !pwOk || !u.is_active) {
        await db.primary.query(`INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,false,'bad_password')`, [email, req.ip]);
        app.metrics.logins.labels('failure').inc();
        await audit(db.primary, req, { action: 'auth.login_failed', entity: 'user', entity_id: u?.id ?? null, details: { email }, actor_type: 'anonymous' });
        throw unauthorized('invalid email or password', 'invalid_credentials');
      }
      if (u.mfa_secret) {
        if (!req.body.totp_code) throw unauthorized('TOTP code required', 'mfa_required');
        if (!verifyTotp(u.mfa_secret, req.body.totp_code)) {
          await db.primary.query(`INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,false,'bad_totp')`, [email, req.ip]);
          app.metrics.logins.labels('failure').inc();
          await audit(db.primary, req, { action: 'auth.login_failed', entity: 'user', entity_id: u.id, details: { email, reason: 'bad_totp' }, actor_type: 'anonymous' });
          throw unauthorized('invalid TOTP code', 'invalid_mfa_code');
        }
      }
      return withTx(db.primary, async (c) => {
        await c.query(`INSERT INTO fms.login_attempts (email, ip, success, reason) VALUES ($1,$2,true,'ok')`, [email, req.ip]);
        await c.query(`UPDATE fms.users SET last_login_at = now() WHERE id = $1`, [u.id]);
        const t = await issueTokens(c, req, u);
        await audit(c, req, { action: 'auth.login', entity: 'user', entity_id: u.id, actor_type: 'user', actor_id: u.id, details: { mfa: !!u.mfa_secret } });
        app.metrics.logins.labels('success').inc();
        return t.body;
      });
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: { rateLimit: { max: app.config.loginRateLimitRpm * 2, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Rotate a refresh token',
        security: [],
        body: z.object({ refresh_token: z.string().min(10).max(200) }),
        response: { 200: tokenResponse },
      },
    },
    async (req) => {
      const hash = sha256Hex(req.body.refresh_token);
      // The transaction returns either tokens or an error; errors are thrown only
      // after COMMIT so that family revocation on reuse is persisted.
      const out = await withTx(db.primary, async (c) => {
        const { rows } = await c.query<UserRow & { token_id: string; family_id: string; revoked_at: Date | null; expired: boolean }>(
          `SELECT rt.id AS token_id, rt.family_id, rt.revoked_at, rt.expires_at <= now() AS expired,
                  u.id, u.email::text, u.full_name, u.role, u.company_id, u.province_id, u.is_active, u.password_hash, u.mfa_secret
             FROM fms.refresh_tokens rt JOIN fms.users u ON u.id = rt.user_id
            WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
          [hash],
        );
        const r = rows[0];
        if (!r) return { error: unauthorized('invalid refresh token', 'invalid_token') };
        if (r.revoked_at) {
          // Reuse of a rotated/revoked token: revoke the whole family.
          await c.query(`UPDATE fms.refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [r.family_id]);
          await audit(c, req, { action: 'auth.refresh_reuse_detected', entity: 'user', entity_id: r.id, actor_type: 'user', actor_id: r.id });
          return { error: unauthorized('refresh token already used', 'invalid_token') };
        }
        if (r.expired || !r.is_active) return { error: unauthorized('refresh token expired', 'invalid_token') };
        const t = await issueTokens(c, req, r, r.family_id);
        await c.query(`UPDATE fms.refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`, [r.token_id, t.tokenId]);
        return { body: t.body };
      });
      if ('error' in out) throw out.error;
      return out.body;
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke a refresh token (or all of the caller\'s tokens with all=true)',
        body: z.object({ refresh_token: z.string().optional(), all: z.boolean().optional() }).optional(),
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (req) => {
      const body = req.body ?? {};
      const authz = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const claims = authz ? verifyJwt(authz, app.config.jwtSecret) : null;
      if (!claims && !body.refresh_token) throw unauthorized();
      let userId: string | null = claims?.sub ?? null;
      if (body.refresh_token) {
        const { rows } = await db.primary.query<{ user_id: string }>(
          `UPDATE fms.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE token_hash = $1 RETURNING user_id`,
          [sha256Hex(body.refresh_token)],
        );
        userId = userId ?? rows[0]?.user_id ?? null;
      }
      if (body.all && claims) {
        await db.primary.query(`UPDATE fms.refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [claims.sub]);
      }
      if (userId) await audit(db.primary, req, { action: 'auth.logout', entity: 'user', entity_id: userId, actor_type: 'user', actor_id: userId, details: { all: !!body.all } });
      return { success: true };
    },
  );

  app.get(
    '/me',
    { preHandler: requireUser(), schema: { tags: ['auth'], summary: 'Current user' } },
    async (req) => {
      const me = userOf(req);
      const { rows } = await db.ro.query(
        `SELECT u.id, u.email::text AS email, u.full_name, u.role, u.company_id, u.province_id, u.phone,
                c.name AS company_name, p.name AS province_name,
                (u.mfa_secret IS NOT NULL) AS mfa_enabled, u.last_login_at,
                coalesce((SELECT array_agg(usa.station_id ORDER BY usa.station_id) FROM fms.user_station_access usa WHERE usa.user_id = u.id), '{}') AS station_ids
           FROM fms.users u
           LEFT JOIN fms.companies c ON c.id = u.company_id
           LEFT JOIN fms.provinces p ON p.id = u.province_id
          WHERE u.id = $1 AND u.is_active`,
        [me.id],
      );
      if (!rows[0]) throw unauthorized('user no longer active');
      return rows[0];
    },
  );

  // ---- TOTP MFA (erb_* and platform_admin)
  app.post(
    '/auth/mfa/enroll',
    { preHandler: requireUser(MFA_ROLES), schema: { tags: ['auth'], summary: 'Start TOTP enrolment; returns secret + otpauth URL' } },
    async (req) => {
      const me = userOf(req);
      const secret = generateTotpSecret();
      const { rows } = await db.primary.query<{ email: string }>(`SELECT email::text FROM fms.users WHERE id = $1`, [me.id]);
      await db.primary.query(
        `INSERT INTO fms.mfa_enrolments (user_id, secret) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, created_at = now()`,
        [me.id, secret],
      );
      await audit(db.primary, req, { action: 'auth.mfa_enroll_started', entity: 'user', entity_id: me.id });
      return { secret, otpauth_url: otpauthUrl(app.config.mfaIssuer, rows[0]?.email ?? me.id, secret) };
    },
  );

  app.post(
    '/auth/mfa/verify',
    {
      preHandler: requireUser(MFA_ROLES),
      schema: { tags: ['auth'], summary: 'Confirm TOTP enrolment', body: z.object({ code: z.string() }) },
    },
    async (req) => {
      const me = userOf(req);
      const { rows } = await db.primary.query<{ secret: string }>(
        `SELECT secret FROM fms.mfa_enrolments WHERE user_id = $1 AND created_at > now() - interval '30 minutes'`,
        [me.id],
      );
      if (!rows[0]) throw badRequest('no pending MFA enrolment', 'mfa_not_pending');
      if (!verifyTotp(rows[0].secret, req.body.code)) throw badRequest('invalid TOTP code', 'invalid_mfa_code');
      await withTx(db.primary, async (c) => {
        await c.query(`UPDATE fms.users SET mfa_secret = $2 WHERE id = $1`, [me.id, rows[0]!.secret]);
        await c.query(`DELETE FROM fms.mfa_enrolments WHERE user_id = $1`, [me.id]);
        await audit(c, req, { action: 'auth.mfa_enabled', entity: 'user', entity_id: me.id });
      });
      return { mfa_enabled: true };
    },
  );

  app.post(
    '/auth/mfa/disable',
    {
      preHandler: requireUser(MFA_ROLES),
      schema: { tags: ['auth'], summary: 'Disable TOTP (requires a current code)', body: z.object({ code: z.string() }) },
    },
    async (req) => {
      const me = userOf(req);
      const { rows } = await db.primary.query<{ mfa_secret: string | null }>(`SELECT mfa_secret FROM fms.users WHERE id = $1`, [me.id]);
      const secret = rows[0]?.mfa_secret;
      if (!secret) return { mfa_enabled: false };
      if (!verifyTotp(secret, req.body.code)) throw badRequest('invalid TOTP code', 'invalid_mfa_code');
      await db.primary.query(`UPDATE fms.users SET mfa_secret = NULL WHERE id = $1`, [me.id]);
      await audit(db.primary, req, { action: 'auth.mfa_disabled', entity: 'user', entity_id: me.id });
      return { mfa_enabled: false };
    },
  );
};

export default authRoutes;
