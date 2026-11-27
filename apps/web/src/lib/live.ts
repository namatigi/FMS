import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { buildUrl } from '../api/client';
import { tokenStore } from '../auth/tokenStore';

export const POLL_MS = 15_000;
export type LiveMode = 'connecting' | 'live' | 'polling';

/**
 * Live updates: try SSE `GET /api/v1/stream?station_id=&token=`; on any event, invalidate the
 * given query key prefixes. If the stream is unavailable (404, network, unsupported), fall back
 * to polling: the returned `refetchInterval` is POLL_MS while not live.
 */
export function useLiveUpdates(invalidate: string[][], stationId?: string) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const keysRef = useRef(invalidate);
  keysRef.current = invalidate;

  useEffect(() => {
    // MSW cannot stream SSE through the service worker reliably → mock mode always polls.
    if (typeof EventSource === 'undefined' || import.meta.env.VITE_DISABLE_SSE === 'true' || import.meta.env.VITE_USE_MOCKS === 'true') {
      setMode('polling');
      return;
    }
    const token = tokenStore.getAccessToken();
    if (!token) {
      setMode('polling');
      return;
    }
    let es: EventSource | null = null;
    let opened = false;
    const failTimer = setTimeout(() => {
      if (!opened) {
        es?.close();
        setMode('polling');
      }
    }, 5000);
    try {
      es = new EventSource(buildUrl('/stream', { station_id: stationId, token }));
    } catch {
      setMode('polling');
      clearTimeout(failTimer);
      return;
    }
    const onAny = () => {
      setLastEventAt(Date.now());
      keysRef.current.forEach((k) => qc.invalidateQueries({ queryKey: k }));
    };
    es.onopen = () => {
      opened = true;
      setMode('live');
    };
    es.onmessage = onAny;
    // core-api events: ready {station_id, poll_ms}; tank_latest / sales / alert {items:[...]}
    es.addEventListener('ready', () => {
      opened = true;
      setMode('live');
    });
    for (const t of ['tank_latest', 'sales', 'alert']) es.addEventListener(t, onAny);
    es.onerror = () => {
      // Token expiry or server unavailable → close and poll instead of hammering reconnects.
      es?.close();
      setMode('polling');
    };
    return () => {
      clearTimeout(failTimer);
      es?.close();
    };
  }, [qc, stationId]);

  return { mode, lastEventAt, refetchInterval: mode === 'live' ? 60_000 : POLL_MS };
}
