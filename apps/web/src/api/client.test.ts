import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ApiError, request, setSessionExpiredHandler } from './client';
import { tokenStore } from '../auth/tokenStore';

const user = { id: 'u1', email: 'o@x.zm', full_name: 'O', role: 'owner' as const, company_id: 'c1', province_id: null };
let refreshCalls = 0;
let validAccess = 'access-2';

const server = setupServer(
  http.post('*/api/v1/auth/refresh', async ({ request: req }) => {
    refreshCalls++;
    const b = (await req.json()) as { refresh_token: string };
    if (b.refresh_token !== 'refresh-1') return HttpResponse.json({ error: { code: 'invalid_refresh', message: 'bad' } }, { status: 401 });
    return HttpResponse.json({ access_token: validAccess, refresh_token: 'refresh-2', expires_in: 900, user });
  }),
  http.get('*/api/v1/stations', ({ request: req }) => {
    if (req.headers.get('authorization') !== `Bearer ${validAccess}`) return HttpResponse.json({ error: { code: 'unauthorized', message: 'expired' } }, { status: 401 });
    return HttpResponse.json({ items: [{ id: 's1' }], next_cursor: null });
  }),
  http.put('*/api/v1/stations/s1/prices', () => HttpResponse.json({ error: { code: 'price_above_cap', message: 'Petrol exceeds ERB cap' } }, { status: 422 })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  refreshCalls = 0;
  validAccess = 'access-2';
  tokenStore.clear();
});

describe('api client auth refresh', () => {
  it('refreshes once on 401 and retries the original request', async () => {
    tokenStore.setSession({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900, user });
    const res = await request<{ items: { id: string }[] }>('/stations');
    expect(res.items[0].id).toBe('s1');
    expect(refreshCalls).toBe(1);
    expect(tokenStore.getAccessToken()).toBe('access-2');
    expect(tokenStore.getRefreshToken()).toBe('refresh-2'); // rotated + persisted
  });

  it('shares a single in-flight refresh across concurrent 401s', async () => {
    tokenStore.setSession({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900, user });
    const results = await Promise.all([request('/stations'), request('/stations'), request('/stations')]);
    expect(results).toHaveLength(3);
    expect(refreshCalls).toBe(1);
  });

  it('clears the session and notifies when refresh fails', async () => {
    const onExpired = vi.fn();
    setSessionExpiredHandler(onExpired);
    tokenStore.setSession({ access_token: 'access-1', refresh_token: 'stale', expires_in: 900, user });
    await expect(request('/stations')).rejects.toBeInstanceOf(ApiError);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(tokenStore.getAccessToken()).toBeNull();
    expect(tokenStore.getRefreshToken()).toBeNull();
  });

  it('proactively refreshes an expired access token (e.g. after reload)', async () => {
    localStorage.setItem('fms.refresh_token', 'refresh-1');
    const res = await request<{ items: unknown[] }>('/stations');
    expect(res.items).toHaveLength(1);
    expect(refreshCalls).toBe(1);
  });

  it('surfaces API error code and message', async () => {
    tokenStore.setSession({ access_token: 'access-2', refresh_token: 'refresh-1', expires_in: 900, user });
    const e = (await request('/stations/s1/prices', { method: 'PUT', body: { prices: [] } }).catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(422);
    expect(e.code).toBe('price_above_cap');
    expect(e.message).toBe('Petrol exceeds ERB cap');
  });
});
