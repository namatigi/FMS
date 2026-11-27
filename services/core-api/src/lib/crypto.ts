import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { FmsJwtClaims } from '@fms/shared';

// ---------------------------------------------------------------- passwords
// Format: scrypt$N$r$p$<salt base64>$<64-byte key base64>

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Used for unknown users so the response time does not reveal account existence.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export async function verifyPassword(password: string, encoded: string | null | undefined): Promise<boolean> {
  const parts = (encoded ?? DUMMY_HASH).split('$');
  const usable = parts.length === 6 && parts[0] === 'scrypt';
  const [, n, r, p, saltB64, keyB64] = usable ? parts : DUMMY_HASH.split('$');
  const N = Number(n), R = Number(r), P = Number(p);
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  const expected = Buffer.from(keyB64!, 'base64');
  const got = await scrypt(password, Buffer.from(saltB64!, 'base64'), expected.length || 64, {
    N, r: R, p: P, maxmem: 256 * 1024 * 1024,
  });
  return usable && encoded != null && expected.length === got.length && timingSafeEqual(expected, got);
}

// ---------------------------------------------------------------- JWT (HS256)

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(claims: Omit<FmsJwtClaims, 'iat' | 'exp'>, secret: string, ttlSec: number, now = Math.floor(Date.now() / 1000)): string {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ ...claims, iat: now, exp: now + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string, now = Math.floor(Date.now() / 1000)): FmsJwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let claims: FmsJwtClaims;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.sub !== 'string' || typeof claims.role !== 'string') return null;
  return claims;
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA1, 30 s, 6 digits)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secretB32: string, timeSec: number, step = 30, digits = 6): string {
  const counter = Math.floor(timeSec / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Verify with ±1 step window, constant-time compare. */
export function verifyTotp(secretB32: string, code: string, now = Math.floor(Date.now() / 1000)): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let ok = false;
  for (const d of [-1, 0, 1]) {
    const exp = Buffer.from(totpAt(secretB32, now + d * 30));
    if (timingSafeEqual(exp, Buffer.from(code))) ok = true;
  }
  return ok;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
