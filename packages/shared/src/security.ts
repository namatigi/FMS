import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmacSha256Hex(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), 'utf8');
  const bb = Buffer.from(b.toLowerCase(), 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify the PTS-2 upload signature (HMAC-SHA256 of the raw body with the controller "Secret key"). */
export function verifyPtsSignature(secret: string | null | undefined, rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!secret) return true; // controller configured without secret key → rely on TLS + basic auth
  if (!signature) return false;
  return safeEqualHex(hmacSha256Hex(secret, rawBody), signature);
}

/** API keys: "<prefix>.<secret>" — prefix stored in clear for lookup, full key stored as sha256. */
export function generateApiKey(prefixLen = 8): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(prefixLen).toString('base64url').slice(0, prefixLen);
  const key = `${prefix}.${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: sha256Hex(key) };
}

/** Webhook signature header value: t=<unix>,v1=<hmac(secret, `${t}.${body}`)> */
export function signWebhook(secret: string, body: string, now = Math.floor(Date.now() / 1000)): string {
  return `t=${now},v1=${hmacSha256Hex(secret, `${now}.${body}`)}`;
}
