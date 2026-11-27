/** Positional parameter collector for hand-built SQL. */
export class Params {
  readonly values: unknown[] = [];
  constructor(initial: unknown[] = []) {
    this.values.push(...initial);
  }
  /** Adds a value and returns its placeholder ($n). */
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(c: string | undefined | null): (string | number)[] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export const toIso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
