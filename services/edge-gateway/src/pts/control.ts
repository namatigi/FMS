/**
 * PtsControlClient: sends jsonPTS requests to the PTS-2 controller's built-in web server
 * (HTTP/HTTPS per DIP-1, basic or digest auth per DIP-2; technical guide pp. 18-20).
 *
 * The exact jsonPTS request names and fields are defined in Technotrade's separate
 * "jsonPTS communication protocol specification", which is NOT in this repository.
 * All protocol-specific names are isolated in PTS_CONTROL_PROTOCOL below.
 *   VERIFY every entry against the jsonPTS specification before go-live.
 */
import type { Logger } from 'pino';
import type { ControllerConfig } from '../config.js';

export const PTS_CONTROL_PROTOCOL = {
  /** VERIFY: path of the jsonPTS endpoint on the controller web server. */
  defaultPath: '/jsonPTS',
  /**
   * VERIFY: price update strategy.
   *  'configuration' = read the fuel-grade configuration, change prices, write it back
   *                    (keeps names / expansion coefficients the server does not know about).
   *  'prices'        = single price-only request.
   */
  priceUpdateMode: 'configuration' as 'configuration' | 'prices',
  /** VERIFY: request that returns the fuel grades configuration. */
  getFuelGradesConfiguration: 'GetFuelGradesConfiguration',
  /** VERIFY: request that writes the fuel grades configuration. */
  setFuelGradesConfiguration: 'SetFuelGradesConfiguration',
  /** VERIFY: price-only request (used when priceUpdateMode = 'prices'). */
  setFuelGradesPrices: 'SetFuelGradesPrices',
  /** VERIFY: field names inside the fuel-grade objects. */
  fields: { list: 'FuelGrades', id: 'Id', name: 'Name', price: 'Price' },
} as const;

export interface PtsRequestPacket {
  Id: number;
  Type: string;
  Data?: Record<string, unknown>;
}

export interface PtsResponsePacket {
  Id: number;
  Type?: string;
  Error?: boolean;
  Code?: number;
  Message?: string;
  Data?: Record<string, unknown>;
}

export class PtsControlError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export class PtsControlClient {
  private nextId = 1;

  constructor(
    private readonly controller: ControllerConfig,
    private readonly log: Logger,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get url(): string | null {
    const u = this.controller.control_url;
    if (!u) return null;
    return /\/[^/]+$/.test(new URL(u).pathname) ? u : `${u.replace(/\/+$/, '')}${PTS_CONTROL_PROTOCOL.defaultPath}`;
  }

  /** Send one jsonPTS request with the given packets and return the response packets. */
  async request(packets: Array<Omit<PtsRequestPacket, 'Id'>>): Promise<PtsResponsePacket[]> {
    const url = this.url;
    if (!url) throw new PtsControlError(`controller ${this.controller.pts_id} has no control_url configured`, false);
    const body = { Protocol: 'jsonPTS', Packets: packets.map((p) => ({ Id: this.nextId++, ...p })) };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Basic auth (DIP-2 ON). Digest auth (DIP-2 OFF, factory default) is NOT implemented: VERIFY / set DIP-2.
    if (this.controller.control_user) {
      headers.authorization = `Basic ${Buffer.from(`${this.controller.control_user}:${this.controller.control_password ?? ''}`).toString('base64')}`;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new PtsControlError(`PTS-2 ${this.controller.pts_id} unreachable: ${(e as Error).message}`, true);
    }
    if (res.status === 401) throw new PtsControlError(`PTS-2 ${this.controller.pts_id} rejected credentials (digest auth not supported; enable basic auth)`, false);
    if (!res.ok) throw new PtsControlError(`PTS-2 ${this.controller.pts_id} HTTP ${res.status}`, res.status >= 500);
    const json = (await res.json().catch(() => null)) as { Packets?: PtsResponsePacket[] } | null;
    const out = json?.Packets ?? [];
    const bad = out.find((p) => p.Error);
    if (bad) throw new PtsControlError(`PTS-2 ${this.controller.pts_id} ${bad.Type ?? ''} error: ${bad.Message ?? bad.Code ?? 'unknown'}`, false);
    return out;
  }

  /** Update fuel grade prices on the controller (pumps + price boards follow the controller). */
  async setPrices(prices: Array<{ pts_grade_id: number; price: number }>): Promise<{ request: string; grades: number }> {
    const P = PTS_CONTROL_PROTOCOL;
    const F = P.fields;
    if (P.priceUpdateMode === 'prices') {
      await this.request([{ Type: P.setFuelGradesPrices, Data: { [F.list]: prices.map((p) => ({ [F.id]: p.pts_grade_id, [F.price]: p.price })) } }]);
      return { request: P.setFuelGradesPrices, grades: prices.length };
    }
    const [cur] = await this.request([{ Type: P.getFuelGradesConfiguration }]);
    const list = ((cur?.Data?.[F.list] as Array<Record<string, unknown>> | undefined) ?? []).map((g) => ({ ...g }));
    for (const p of prices) {
      const g = list.find((x) => Number(x[F.id]) === p.pts_grade_id);
      if (g) g[F.price] = p.price;
      else list.push({ [F.id]: p.pts_grade_id, [F.name]: `Grade ${p.pts_grade_id}`, [F.price]: p.price });
    }
    await this.request([{ Type: P.setFuelGradesConfiguration, Data: { ...(cur?.Data ?? {}), [F.list]: list } }]);
    this.log.info({ pts_id: this.controller.pts_id, prices }, 'prices sent to PTS-2');
    return { request: P.setFuelGradesConfiguration, grades: list.length };
  }
}
