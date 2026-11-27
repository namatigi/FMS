import { createHmac } from 'node:crypto';
import { PtsControllerSim, type JsonPtsResponse } from './generator.js';

export interface UploaderOptions {
  url: string;
  secret?: string | null;
  timeoutMs?: number;
  /** Extra headers (e.g. Authorization for basic auth). */
  headers?: Record<string, string>;
  /** Called after each request (for logging). */
  onResult?: (r: UploadResult) => void;
}

export interface UploadResult {
  ptsId: string;
  sent: number;
  confirmed: number;
  status: number | null;
  error?: string;
  pending: number;
}

export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Sends one upload request for the controller (oldest unconfirmed packets first), the way the PTS-2
 * does: POST JSON, X-Pts-Id header, X-Pts-Signature = HMAC-SHA256(secret, raw body) when a secret
 * key is configured. Unconfirmed packets stay queued and are resent next time.
 */
export async function uploadOnce(sim: PtsControllerSim, opts: UploaderOptions): Promise<UploadResult> {
  const req = sim.takeRequest();
  if (!req) return { ptsId: sim.ptsId, sent: 0, confirmed: 0, status: null, pending: 0 };
  const body = JSON.stringify(req);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-pts-id': sim.ptsId,
    ...(opts.headers ?? {}),
  };
  if (opts.secret) headers['x-pts-signature'] = signBody(opts.secret, body);
  let result: UploadResult;
  try {
    const res = await fetch(opts.url, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    let parsed: JsonPtsResponse | null = null;
    try {
      parsed = (await res.json()) as JsonPtsResponse;
    } catch {
      parsed = null;
    }
    const confirmed = res.ok || res.status === 207 ? sim.confirm(parsed) : sim.confirm(null);
    result = { ptsId: sim.ptsId, sent: req.Packets.length, confirmed, status: res.status, pending: sim.pending };
    if (!res.ok) result.error = `HTTP ${res.status}`;
  } catch (e) {
    sim.confirm(null);
    result = { ptsId: sim.ptsId, sent: req.Packets.length, confirmed: 0, status: null, error: (e as Error).message, pending: sim.pending };
  }
  opts.onResult?.(result);
  return result;
}

/** Upload until the queue is empty or a request confirms nothing (server down / all rejected). */
export async function drain(sim: PtsControllerSim, opts: UploaderOptions): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  while (sim.pending > 0) {
    const r = await uploadOnce(sim, opts);
    out.push(r);
    if (r.confirmed === 0) break;
  }
  return out;
}

export interface RunningSim {
  stop(): Promise<void>;
  sims: PtsControllerSim[];
}

/**
 * Run controllers in real time: tick every `tickMs`, upload every `uploadMs` (backing off while
 * the server is unreachable, as the PTS-2 does with its "timeout of server response").
 */
export function runSimulators(
  entries: Array<{ sim: PtsControllerSim; upload: UploaderOptions }>,
  { tickMs = 1000, uploadMs = 1000, durationMs }: { tickMs?: number; uploadMs?: number; durationMs?: number } = {},
): RunningSim & { done: Promise<void> } {
  let stopped = false;
  const abort = new AbortController();
  const sleep = (ms: number) => new Promise<void>((res) => {
    if (ms <= 0 || abort.signal.aborted) return res();
    const t = setTimeout(res, ms);
    abort.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });
  const timers: NodeJS.Timeout[] = [];
  const loops: Promise<void>[] = [];
  for (const e of entries) {
    e.sim.tick();
    timers.push(setInterval(() => e.sim.tick(), tickMs));
    loops.push((async () => {
      let backoff = uploadMs;
      while (!stopped) {
        const r = await uploadOnce(e.sim, e.upload);
        if (r.error && r.confirmed === 0) backoff = Math.min(backoff * 2, 30_000);
        else backoff = uploadMs;
        if (stopped) break;
        // keep draining quickly while there is a backlog and the server is confirming
        const wait = r.confirmed > 0 && e.sim.pending > 0 ? 0 : backoff;
        await sleep(wait);
      }
    })());
  }
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    timers.forEach(clearInterval);
    await Promise.all(loops);
    resolveDone();
  };
  if (durationMs) setTimeout(() => void stop(), durationMs).unref?.();
  return { stop, sims: entries.map((e) => e.sim), done };
}
