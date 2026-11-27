import { getResponse } from 'msw';
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);

/**
 * Start mocks. Prefer the MSW service worker; where service workers are unavailable
 * (embedded webviews, plain-http non-localhost origins, private modes) fall back to
 * patching window.fetch with the same handlers so mock mode still works.
 */
export async function startMocks() {
  try {
    await worker.start({ onUnhandledRequest: 'bypass', quiet: true, serviceWorker: { url: '/mockServiceWorker.js' } });
    return 'service-worker';
  } catch (e) {
    console.warn('[mocks] Service worker unavailable, using in-page fetch interception.', e);
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const res = await getResponse(handlers, req.clone());
      return res ?? original(req);
    };
    return 'fetch-patch';
  }
}
