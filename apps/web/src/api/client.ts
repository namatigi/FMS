import { tokenStore } from '../auth/tokenStore';
import type { AuthResponse } from '../types';

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '/api/v1';
export const ANALYTICS_BASE = (import.meta.env.VITE_ANALYTICS_BASE as string | undefined) || '/analytics/v1';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  /** 'api' → core-api /api/v1, 'analytics' → /analytics/v1 */
  service?: 'api' | 'analytics';
  /** return the raw Response (e.g. for file downloads) */
  raw?: boolean;
  /** skip auth header + refresh logic */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: Query, service: 'api' | 'analytics' = 'api'): string {
  const base = service === 'analytics' ? ANALYTICS_BASE : API_BASE;
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost';
  const url = new URL(base.replace(/\/$/, '') + path, base.startsWith('http') ? undefined : origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Called when the session can't be recovered (refresh failed). */
let onSessionExpired: () => void = () => {};
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchange the stored refresh token for a new token pair. Concurrent callers share one
 * in-flight request (refresh tokens rotate, so parallel refreshes would invalidate each other).
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const rt = tokenStore.getRefreshToken();
  if (!rt) return Promise.resolve(false);
  refreshInFlight = (async () => {
    try {
      const res = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) {
        // Only drop the session for auth failures, not transient network/server errors.
        if (res.status === 400 || res.status === 401 || res.status === 403) tokenStore.clear();
        return false;
      }
      const data = (await res.json()) as AuthResponse;
      tokenStore.setSession(data);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `Request failed (${res.status})`;
  let details: unknown;
  try {
    const text = await res.text();
    if (text) {
      try {
        const j = JSON.parse(text);
        const e = j?.error ?? j;
        if (typeof e === 'string') message = e;
        else {
          if (e?.code) code = String(e.code);
          if (e?.message) message = String(e.message);
          else if (j?.detail) message = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
          details = e?.details ?? j?.detail;
        }
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, code, message, details);
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', query, body, service = 'api', raw, anonymous, signal } = opts;
  const url = buildUrl(path, query, service);

  const doFetch = () => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = tokenStore.getAccessToken();
    if (!anonymous && token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  };

  // Proactively refresh an expired access token if we hold a refresh token.
  if (!anonymous && tokenStore.isAccessExpired() && tokenStore.getRefreshToken()) {
    await refreshSession();
  }

  let res = await doFetch();
  if (res.status === 401 && !anonymous) {
    const ok = await refreshSession();
    if (ok) res = await doFetch();
    if (!ok || res.status === 401) {
      if (!ok) onSessionExpired();
      throw await parseError(res);
    }
  }
  if (!res.ok) throw await parseError(res);
  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Lists may be `{items, next_cursor}` (core-api default) or bare arrays; normalise to an array. */
export function asItems<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['items', ...keys, 'data', 'results', 'models']) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message === 'Failed to fetch' ? 'Cannot reach the server. Check your connection.' : e.message;
  return 'Unexpected error';
}
