import { ApiClient, ApiError, buildQuery, errorMessage, type RefreshTokenStore } from '../src/api/client';
import type { AuthResponse } from '../src/api/types';

type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

function mockFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = await handler(url, init ?? {});
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function memoryStore(initial: string | null = null): RefreshTokenStore & { value: string | null } {
  const s = {
    value: initial,
    get: async () => s.value,
    set: async (t: string) => {
      s.value = t;
    },
    clear: async () => {
      s.value = null;
    },
  };
  return s;
}

const user = { id: 'u1', email: 'owner@zambezi.local', full_name: 'Zambezi Owner', role: 'owner' as const, company_id: 'c1', province_id: null };
const auth = (n: number): AuthResponse => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900, user });
const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

describe('ApiClient', () => {
  it('logs in and sends the bearer token', async () => {
    const store = memoryStore();
    const { fn, calls } = mockFetch((url, init) => {
      if (url.endsWith('/auth/login')) {
        expect(JSON.parse(String(init.body))).toEqual({ email: 'owner@zambezi.local', password: 'ChangeMe123!' });
        return { status: 200, body: auth(1) };
      }
      return { status: 200, body: { ok: true } };
    });
    const api = new ApiClient({ getBaseUrl: () => 'http://api.test/', refreshStore: store, fetchImpl: fn });
    await api.login('owner@zambezi.local', 'ChangeMe123!');
    expect(store.value).toBe('refresh-1');
    await api.get('/dashboard/overview');
    expect(calls[1].url).toBe('http://api.test/api/v1/dashboard/overview');
    expect(authHeader(calls[1].init)).toBe('Bearer access-1');
  });

  it('refreshes once on 401 and retries the request', async () => {
    const store = memoryStore('refresh-1');
    let refreshes = 0;
    const { fn, calls } = mockFetch((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'refresh-1' });
        return { status: 200, body: auth(2) };
      }
      if (authHeader(init) === 'Bearer access-2') return { status: 200, body: { items: [], next_cursor: null } };
      return { status: 401, body: { error: { code: 'unauthorized', message: 'expired' } } };
    });
    const onAuth = jest.fn();
    const api = new ApiClient({ getBaseUrl: () => 'http://api.test', refreshStore: store, fetchImpl: fn, onAuthResponse: onAuth });
    await api.setSession({ ...auth(1), refresh_token: 'refresh-1' });

    const [a, b, c] = await Promise.all([api.get('/stations'), api.get('/alerts'), api.get('/dashboard/overview')]);
    expect(a).toEqual({ items: [], next_cursor: null });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(refreshes).toBe(1); // single-flight
    expect(store.value).toBe('refresh-2'); // rotated
    expect(onAuth).toHaveBeenCalledTimes(1);
    expect(calls.filter((x) => x.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('ends the session when the refresh token is rejected', async () => {
    const store = memoryStore('refresh-old');
    const onExpired = jest.fn();
    const { fn } = mockFetch((url) =>
      url.endsWith('/auth/refresh')
        ? { status: 401, body: { error: { code: 'invalid_refresh', message: 'Refresh token revoked' } } }
        : { status: 401 },
    );
    const api = new ApiClient({ getBaseUrl: () => 'http://api.test', refreshStore: store, fetchImpl: fn, onSessionExpired: onExpired });
    await api.setSession({ ...auth(1), refresh_token: 'refresh-old' });

    await expect(api.get('/me')).rejects.toMatchObject({ status: 401, code: 'invalid_refresh' });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(store.value).toBeNull();
    expect(api.hasAccessToken()).toBe(false);
  });

  it('keeps the session on network failure during refresh', async () => {
    const store = memoryStore('refresh-1');
    const onExpired = jest.fn();
    const fn = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const api = new ApiClient({ getBaseUrl: () => 'http://api.test', refreshStore: store, fetchImpl: fn, onSessionExpired: onExpired });
    const err = await api.refresh().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isNetwork).toBe(true);
    expect(onExpired).not.toHaveBeenCalled();
    expect(store.value).toBe('refresh-1');
  });

  it('proactively refreshes an access token close to expiry', async () => {
    let now = 1_000_000;
    const store = memoryStore('refresh-1');
    const { fn, calls } = mockFetch((url) => (url.endsWith('/auth/refresh') ? { status: 200, body: auth(2) } : { status: 200, body: {} }));
    const api = new ApiClient({ getBaseUrl: () => 'http://api.test', refreshStore: store, fetchImpl: fn, now: () => now });
    await api.setSession(auth(1)); // expires in 900 s
    now += 880_000; // 20 s left (< 30 s skew)
    await api.get('/me');
    expect(calls[0].url).toMatch(/\/auth\/refresh$/);
    expect(authHeader(calls[1].init)).toBe('Bearer access-2');
  });

  it('routes analytics calls and surfaces API validation errors', async () => {
    const store = memoryStore('r');
    const { fn, calls } = mockFetch((url) =>
      url.includes('/prices')
        ? { status: 422, body: { error: { code: 'price_above_cap', message: 'Price above ERB cap', details: [{ message: 'PETROL 33.00 > 32.15' }] } } }
        : { status: 200, body: [] },
    );
    const api = new ApiClient({
      getBaseUrl: () => 'http://api.test',
      getAnalyticsUrl: () => 'http://analytics.test:8090',
      refreshStore: store,
      fetchImpl: fn,
    });
    await api.setSession(auth(1));
    await api.get('/forecast/stockout', { station_id: 'abc', empty: '' }, { service: 'analytics' });
    expect(calls[0].url).toBe('http://analytics.test:8090/analytics/v1/forecast/stockout?station_id=abc');
    const e = await api.request('/stations/s1/prices', { method: 'PUT', body: { prices: [] } }).catch((x) => x);
    expect(e).toMatchObject({ status: 422, code: 'price_above_cap' });
    expect(errorMessage(e)).toBe('Price above ERB cap\n• PETROL 33.00 > 32.15');
  });

  it('surfaces mfa_required and sends totp_code on retry; maps account_locked', async () => {
    const store = memoryStore();
    const { fn } = mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.email === 'locked@x') return { status: 429, body: { error: { code: 'account_locked', message: 'Try again in 15 minutes.' } } };
      if (!body.totp_code) return { status: 401, body: { error: { code: 'mfa_required', message: 'MFA code required' } } };
      return body.totp_code === '123456' ? { status: 200, body: auth(1) } : { status: 401, body: { error: { code: 'invalid_credentials', message: 'bad' } } };
    });
    const onExpired = jest.fn();
    const api = new ApiClient({ getBaseUrl: () => 'http://api.test', refreshStore: store, fetchImpl: fn, onSessionExpired: onExpired });
    await expect(api.login('erb@erb.local', 'pw')).rejects.toMatchObject({ status: 401, code: 'mfa_required' });
    expect(onExpired).not.toHaveBeenCalled(); // login 401 must not trigger refresh/expiry
    await api.login('erb@erb.local', 'pw', '123456');
    expect(store.value).toBe('refresh-1');
    const locked = await api.login('locked@x', 'pw').catch((e) => e);
    expect(locked).toMatchObject({ status: 429, code: 'account_locked' });
    expect(errorMessage(locked)).toMatch(/locked/);
  });

  it('builds query strings', () => {
    expect(buildQuery({ a: 1, b: 'x y', c: undefined, d: null })).toBe('?a=1&b=x%20y');
    expect(buildQuery({})).toBe('');
  });
});
