import type { ApiErrorBody, AuthResponse } from './types';

/**
 * Framework-free HTTP client for core-api and analytics.
 * - Adds `Authorization: Bearer <access>`.
 * - On 401 it refreshes once (single-flight: concurrent 401s share one /auth/refresh)
 *   and retries the original request; if refresh is rejected the session is cleared
 *   and `onSessionExpired` fires.
 * - Proactively refreshes when the access token is within `refreshSkewMs` of expiry.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
  get isAuth(): boolean {
    return this.status === 401;
  }
}

/** Persists the refresh token (secure store in the app, memory in tests). */
export interface RefreshTokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ApiClientOptions {
  /** Origin of the reverse proxy / core-api, e.g. https://fms.example.zm (no trailing /api/v1). */
  getBaseUrl: () => string;
  /** Origin serving /analytics/v1. Defaults to getBaseUrl. */
  getAnalyticsUrl?: () => string;
  refreshStore: RefreshTokenStore;
  fetchImpl?: typeof fetch;
  onSessionExpired?: () => void;
  onAuthResponse?: (res: AuthResponse) => void;
  now?: () => number;
  refreshSkewMs?: number;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  service?: 'core' | 'analytics';
  /** Send bearer token & refresh on 401 (default true). */
  auth?: boolean;
  signal?: AbortSignal;
}

export function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export class ApiClient {
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private refreshing: Promise<AuthResponse> | null = null;
  private readonly opts: ApiClientOptions;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
  }

  private get fetchFn(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  hasAccessToken(): boolean {
    return this.accessToken !== null;
  }

  /** Install tokens after login/refresh. */
  async setSession(res: AuthResponse): Promise<void> {
    this.accessToken = res.access_token;
    this.accessExpiresAt = this.now() + Math.max(0, res.expires_in) * 1000;
    await this.opts.refreshStore.set(res.refresh_token);
  }

  async clearSession(): Promise<void> {
    this.accessToken = null;
    this.accessExpiresAt = 0;
    await this.opts.refreshStore.clear();
  }

  url(path: string, service: 'core' | 'analytics' = 'core'): string {
    if (service === 'analytics') {
      const base = trimSlash((this.opts.getAnalyticsUrl ?? this.opts.getBaseUrl)());
      return `${base}/analytics/v1${path}`;
    }
    return `${trimSlash(this.opts.getBaseUrl())}/api/v1${path}`;
  }

  /** Throws ApiError code 'mfa_required' (401) when a TOTP code is needed, 'account_locked' (429). */
  async login(email: string, password: string, totpCode?: string): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: totpCode ? { email, password, totp_code: totpCode } : { email, password },
      auth: false,
    });
    await this.setSession(res);
    this.opts.onAuthResponse?.(res);
    return res;
  }

  /** Exchange the stored refresh token. Single-flight. Throws ApiError. */
  refresh(): Promise<AuthResponse> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<AuthResponse> {
    const refreshToken = await this.opts.refreshStore.get();
    if (!refreshToken) {
      this.accessToken = null;
      this.opts.onSessionExpired?.();
      throw new ApiError(401, 'no_refresh_token', 'Not signed in');
    }
    try {
      const res = await this.request<AuthResponse>('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        auth: false,
      });
      await this.setSession(res);
      this.opts.onAuthResponse?.(res);
      return res;
    } catch (e) {
      // A rejected refresh token ends the session; a network error does not.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 400)) {
        await this.clearSession();
        this.opts.onSessionExpired?.();
      }
      throw e;
    }
  }

  async logout(): Promise<void> {
    const refreshToken = await this.opts.refreshStore.get();
    try {
      if (this.accessToken || refreshToken) {
        await this.request('/auth/logout', { method: 'POST', body: { refresh_token: refreshToken }, auth: true });
      }
    } catch {
      // best effort; we clear locally regardless
    } finally {
      await this.clearSession();
    }
  }

  get<T>(path: string, query?: RequestOptions['query'], opts: Omit<RequestOptions, 'query' | 'method'> = {}) {
    return this.request<T>(path, { ...opts, method: 'GET', query });
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const auth = opts.auth !== false;
    if (auth && this.accessToken && this.now() > this.accessExpiresAt - (this.opts.refreshSkewMs ?? 30_000)) {
      try {
        await this.refresh();
      } catch (e) {
        if (!(e instanceof ApiError) || !e.isNetwork) throw e;
        // offline: fall through and let the request fail naturally
      }
    }
    const first = await this.send(path, opts, auth);
    if (first.status === 401 && auth) {
      await this.refresh(); // throws if refresh fails (session ended)
      const retry = await this.send(path, opts, auth);
      return this.parse<T>(retry);
    }
    return this.parse<T>(first);
  }

  private async send(path: string, opts: RequestOptions, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const url = this.url(path, opts.service) + buildQuery(opts.query);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = this.opts.timeoutMs ?? 20_000;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    if (opts.signal && controller) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort());
    }
    try {
      return await this.fetchFn(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller?.signal,
      });
    } catch (e) {
      const msg = e instanceof Error && e.name === 'AbortError' ? 'Request timed out' : 'Network unavailable';
      throw new ApiError(0, 'network', msg);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const body = json as Partial<ApiErrorBody> | undefined;
      const err = body?.error;
      throw new ApiError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? defaultMessage(res.status),
        err?.details,
      );
    }
    return json as T;
  }
}

function defaultMessage(status: number): string {
  if (status === 429) return 'Too many attempts. Try again later.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'The server had a problem. Try again shortly.';
  return `Request failed (${status})`;
}

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'account_locked') return `Account temporarily locked after too many failed sign-ins. ${e.message}`;
    if (e.details && Array.isArray(e.details)) {
      const lines = e.details
        .map((d) => (typeof d === 'string' ? d : (d as { message?: string })?.message))
        .filter(Boolean);
      if (lines.length) return `${e.message}\n• ${lines.join('\n• ')}`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
