/**
 * PTS-2 controller simulator: a deterministic (seedable) generator of jsonPTS upload packets.
 *
 * It models one PTS-2 controller with pumps, nozzles, fuel grades and ATG tanks:
 *  - UploadPumpTransaction   per-pump transaction numbers, monotonic non-resettable totalisers
 *  - UploadTankMeasurement   on every product-height change; drawdown is consistent with the sales
 *  - UploadInTankDelivery    when a tank falls below the refill threshold a tanker discharge is simulated
 *  - UploadAlertRecord       probe alarms (LowProduct, HighWater ...), occasional pump-offline events
 *  - UploadStatus            every `statusIntervalS` seconds
 *
 * The generator does not do any I/O. It keeps an outbound queue of packets that have not been
 * confirmed yet, exactly like the PTS-2 keeps its "uploaded" counter: `takeRequest()` returns the
 * oldest unconfirmed packets, `confirm()` drops the ones the server acknowledged with Error=false.
 * Anything not confirmed is resent on the next request (same packet Id and same data).
 *
 * Field names follow the jsonPTS conventions used by packages/shared/src/jsonpts.ts (VERIFY against
 * Technotrade's jsonPTS specification before relying on the simulator for conformance testing).
 */

export interface SimFuelGrade {
  id: number;
  name: string;
  price: number;
}

export interface SimTankConfig {
  no: number;
  gradeId: number;
  capacityL: number;
  /** Tank diameter used for a simple linear height model. */
  heightMm?: number;
  initialL?: number;
}

export interface ControllerSimOptions {
  ptsId: string;
  pumps?: number;
  tanks?: number;
  grades?: SimFuelGrade[];
  tankConfigs?: SimTankConfig[];
  /** Pump transactions per second for this controller (average, Poisson distributed). */
  rate?: number;
  /** Seconds between UploadStatus packets. */
  statusIntervalS?: number;
  /** Refill a tank when it drops below this fraction of capacity. */
  refillBelow?: number;
  /** Fill target fraction of a refill. */
  refillTo?: number;
  /** Probability per transaction of a "manual mode" totaliser jump (theft simulation). */
  faultInject?: number;
  /** PRNG seed (deterministic output for tests). */
  seed?: number;
  /** First transaction number per pump (default 1). */
  startTransactionNo?: number;
  /** Starting totaliser values (litres) per nozzle (default random 100k-900k). */
  startTotalizerL?: number;
  /** Probability per tick of a random alert record (pump offline etc). */
  alertProbability?: number;
  /** Max packets per request. */
  maxPacketsPerRequest?: number;
  /** UTC offset of the controller clock (PTS-2 sends local time without offset). */
  tzOffsetMinutes?: number;
}

export interface JsonPtsPacket {
  Id: number;
  Type: string;
  Data: Record<string, unknown>;
}

export interface JsonPtsRequest {
  Protocol: 'jsonPTS';
  PtsId: string;
  Packets: JsonPtsPacket[];
}

export interface JsonPtsResponse {
  Protocol?: string;
  Packets?: Array<{ Id: number; Error?: boolean; Message?: string }>;
}

interface NozzleState {
  no: number;
  gradeId: number;
  tankNo: number;
  totalVolume: number;
  totalAmount: number;
}

interface PumpState {
  no: number;
  nextTransactionNo: number;
  nozzles: NozzleState[];
  busyUntil: number;
  online: boolean;
}

interface TankState {
  cfg: Required<SimTankConfig>;
  volume: number;
  waterMm: number;
  temperature: number;
  lastReportedHeight: number;
  /** PTS-2 timestamps have 1 s resolution: at most one measurement per tank per second. */
  lastReportedSec: number;
  forceNext: boolean;
  activeAlarms: Set<string>;
  delivering: { startAt: number; endAt: number; startVolume: number; target: number; startTemp: number; startWater: number } | null;
}

export interface SimStats {
  transactions: number;
  volumeL: number;
  amount: number;
  tankMeasurements: number;
  deliveries: number;
  alerts: number;
  statuses: number;
  faultsInjected: number;
  packetsQueued: number;
  packetsConfirmed: number;
  packetsResent: number;
}

export const DEFAULT_GRADES: SimFuelGrade[] = [
  { id: 1, name: 'Unleaded Petrol', price: 31.85 },
  { id: 2, name: 'Diesel LSD', price: 29.95 },
];

/** mulberry32: small fast deterministic PRNG. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Format as PTS-2 local wall-clock time "YYYY-MM-DDTHH:mm:ss" (no offset). */
export function ptsLocalTime(ms: number, tzOffsetMinutes = 120): string {
  const d = new Date(ms + tzOffsetMinutes * 60_000);
  return d.toISOString().slice(0, 19);
}

/** Increment a 24-hex PTS id by n (used for --controllers N). */
export function incrementPtsId(ptsId: string, n: number): string {
  const v = BigInt(`0x${ptsId}`) + BigInt(n);
  return v.toString(16).toUpperCase().padStart(ptsId.length, '0');
}

export class PtsControllerSim {
  readonly ptsId: string;
  readonly grades: SimFuelGrade[];
  readonly stats: SimStats = {
    transactions: 0, volumeL: 0, amount: 0, tankMeasurements: 0, deliveries: 0, alerts: 0,
    statuses: 0, faultsInjected: 0, packetsQueued: 0, packetsConfirmed: 0, packetsResent: 0,
  };
  private readonly rng: () => number;
  private readonly opts: Required<Omit<ControllerSimOptions, 'tankConfigs' | 'grades' | 'ptsId'>>;
  private readonly pumps: PumpState[] = [];
  private readonly tanks: TankState[] = [];
  private queue: JsonPtsPacket[] = [];
  private inFlight = new Set<number>();
  private everSent = new Set<number>();
  private nextPacketId = 1;
  private lastStatusAt = -Infinity;
  private lastTickAt: number | null = null;

  constructor(options: ControllerSimOptions) {
    this.ptsId = options.ptsId;
    this.grades = options.grades && options.grades.length ? options.grades : DEFAULT_GRADES;
    this.opts = {
      pumps: options.pumps ?? 4,
      tanks: options.tanks ?? Math.max(1, Math.min(this.grades.length, 2)),
      rate: options.rate ?? 0.5,
      statusIntervalS: options.statusIntervalS ?? 5,
      refillBelow: options.refillBelow ?? 0.25,
      refillTo: options.refillTo ?? 0.9,
      faultInject: options.faultInject ?? 0,
      seed: options.seed ?? Math.floor(Math.random() * 2 ** 31),
      startTransactionNo: options.startTransactionNo ?? 1,
      startTotalizerL: options.startTotalizerL ?? -1,
      alertProbability: options.alertProbability ?? 0.002,
      maxPacketsPerRequest: options.maxPacketsPerRequest ?? 50,
      tzOffsetMinutes: options.tzOffsetMinutes ?? 120,
    };
    this.rng = createRng(this.opts.seed);

    const tankCfgs: SimTankConfig[] = options.tankConfigs ?? Array.from({ length: this.opts.tanks }, (_, i) => ({
      no: i + 1,
      gradeId: this.grades[i % this.grades.length].id,
      capacityL: i % 2 === 0 ? 30000 : 40000,
    }));
    for (const c of tankCfgs) {
      const cfg: Required<SimTankConfig> = {
        no: c.no, gradeId: c.gradeId, capacityL: c.capacityL,
        heightMm: c.heightMm ?? 2500,
        initialL: c.initialL ?? c.capacityL * (0.5 + this.rng() * 0.4),
      };
      this.tanks.push({
        cfg, volume: cfg.initialL, waterMm: round(5 + this.rng() * 10, 1), temperature: round(22 + this.rng() * 4, 1),
        lastReportedHeight: -1, lastReportedSec: -1, forceNext: false, activeAlarms: new Set(), delivering: null,
      });
    }
    // Every pump has one nozzle per grade that has a tank (nozzle n -> n-th grade).
    const gradesWithTank = this.grades.filter((g) => this.tanks.some((t) => t.cfg.gradeId === g.id));
    for (let p = 1; p <= this.opts.pumps; p++) {
      this.pumps.push({
        no: p,
        nextTransactionNo: this.opts.startTransactionNo,
        busyUntil: 0,
        online: true,
        nozzles: gradesWithTank.map((g, i) => {
          const tank = this.tanks.find((t) => t.cfg.gradeId === g.id)!;
          const tv = this.opts.startTotalizerL >= 0 ? this.opts.startTotalizerL : round(100000 + this.rng() * 800000);
          return { no: i + 1, gradeId: g.id, tankNo: tank.cfg.no, totalVolume: tv, totalAmount: round(tv * g.price) };
        }),
      });
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Current tank volumes (for test assertions). */
  tankVolumes(): Array<{ tankNo: number; volume: number }> {
    return this.tanks.map((t) => ({ tankNo: t.cfg.no, volume: round(t.volume) }));
  }

  /** Change grade prices (applied to subsequent transactions), as if the server sent a price update. */
  setPrice(gradeId: number, price: number): void {
    const g = this.grades.find((x) => x.id === gradeId);
    if (g) g.price = price;
  }

  private enqueue(type: string, data: Record<string, unknown>): void {
    this.queue.push({ Id: this.nextPacketId++, Type: type, Data: data });
    this.stats.packetsQueued++;
  }

  private poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.rng();
    } while (p > l && k < 1000);
    return k - 1;
  }

  private height(t: TankState): number {
    return round((t.volume / t.cfg.capacityL) * t.cfg.heightMm, 1);
  }

  private measurementData(t: TankState, at: number): Record<string, unknown> {
    const vol = round(t.volume);
    const tc = round(vol * (1 - 0.00095 * (t.temperature - 15)));
    const density = t.cfg.gradeId === 1 ? 740 : 835;
    return {
      DateTime: ptsLocalTime(at, this.opts.tzOffsetMinutes),
      Tank: t.cfg.no,
      FuelGradeId: t.cfg.gradeId,
      FuelGradeName: this.grades.find((g) => g.id === t.cfg.gradeId)?.name ?? null,
      Status: 'OK',
      Alarms: [...t.activeAlarms],
      ProductHeight: this.height(t),
      WaterHeight: t.waterMm,
      Temperature: t.temperature,
      ProductVolume: vol,
      WaterVolume: round(t.waterMm * 4.2, 1),
      ProductUllage: round(t.cfg.capacityL - vol),
      ProductTCVolume: tc,
      ProductDensity: density,
      ProductMass: round((vol * density) / 1000, 1),
    };
  }

  private evaluateAlarms(t: TankState, at: number): void {
    const fill = t.volume / t.cfg.capacityL;
    const want = new Set<string>();
    if (fill < 0.1) want.add('CriticalLowProduct');
    else if (fill < 0.2) want.add('LowProduct');
    if (fill > 0.97) want.add('CriticalHighProduct');
    else if (fill > 0.95) want.add('HighProduct');
    if (t.waterMm > 50) want.add('HighWater');
    for (const a of want) {
      if (!t.activeAlarms.has(a)) {
        this.enqueue('UploadAlertRecord', {
          DateTime: ptsLocalTime(at, this.opts.tzOffsetMinutes),
          DeviceType: 'Probe', DeviceNumber: t.cfg.no, Type: a, State: 'Active',
          Message: `Tank ${t.cfg.no} ${a}`,
        });
        this.stats.alerts++;
      }
    }
    t.activeAlarms = want;
  }

  private reportTank(t: TankState, at: number, force = false): void {
    const h = this.height(t);
    if (!force && h === t.lastReportedHeight) return;
    const sec = Math.floor(at / 1000);
    if (sec === t.lastReportedSec) {
      if (force) t.forceNext = true;
      return; // report on a later tick
    }
    t.lastReportedSec = sec;
    t.forceNext = false;
    this.evaluateAlarms(t, at);
    t.lastReportedHeight = h;
    this.enqueue('UploadTankMeasurement', this.measurementData(t, at));
    this.stats.tankMeasurements++;
  }

  private doTransaction(now: number): void {
    const free = this.pumps.filter((p) => p.online && p.busyUntil <= now);
    if (!free.length) return;
    const pump = free[Math.floor(this.rng() * free.length)];
    const nozzle = pump.nozzles[Math.floor(this.rng() * pump.nozzles.length)];
    const grade = this.grades.find((g) => g.id === nozzle.gradeId)!;
    const tank = this.tanks.find((t) => t.cfg.no === nozzle.tankNo)!;
    // Typical sale: 5..60 L, with a few big diesel fills.
    let volume = round(5 + this.rng() * 55 + (this.rng() < 0.05 ? this.rng() * 150 : 0));
    volume = Math.min(volume, Math.max(0, round(tank.volume - 50)));
    const amount = round(volume * grade.price);
    const durationS = Math.max(10, volume / 0.6);
    const ended = now;
    const started = ended - durationS * 1000;

    tank.volume = Math.max(0, tank.volume - volume);
    nozzle.totalVolume = round(nozzle.totalVolume + volume);
    nozzle.totalAmount = round(nozzle.totalAmount + amount);
    const txNo = pump.nextTransactionNo;
    pump.nextTransactionNo = pump.nextTransactionNo >= 65535 ? 1 : pump.nextTransactionNo + 1;
    pump.busyUntil = now + 1000; // at most one sale per pump per second (ended_at uniqueness)

    // Theft simulation: the pump was used in manual mode before this sale; the totaliser advanced
    // (and the tank dropped) without the controller registering a transaction.
    if (this.opts.faultInject > 0 && this.rng() < this.opts.faultInject) {
      const stolen = round(10 + this.rng() * 40);
      nozzle.totalVolume = round(nozzle.totalVolume + stolen);
      nozzle.totalAmount = round(nozzle.totalAmount + stolen * grade.price);
      tank.volume = Math.max(0, tank.volume - stolen);
      this.stats.faultsInjected++;
    }

    this.enqueue('UploadPumpTransaction', {
      DateTimeStart: ptsLocalTime(started, this.opts.tzOffsetMinutes),
      DateTime: ptsLocalTime(ended, this.opts.tzOffsetMinutes),
      Pump: pump.no,
      Nozzle: nozzle.no,
      FuelGradeId: grade.id,
      FuelGradeName: grade.name,
      Transaction: txNo,
      UserId: 1,
      Volume: volume,
      TCVolume: round(volume * (1 - 0.00095 * (tank.temperature - 15))),
      Price: grade.price,
      Amount: amount,
      TotalVolume: nozzle.totalVolume,
      TotalAmount: nozzle.totalAmount,
      Tag: this.rng() < 0.3 ? `A${Math.floor(this.rng() * 1e6).toString(16).toUpperCase().padStart(6, '0')}` : '',
    });
    this.stats.transactions++;
    this.stats.volumeL = round(this.stats.volumeL + volume);
    this.stats.amount = round(this.stats.amount + amount);
  }

  private tickDeliveries(now: number): void {
    for (const t of this.tanks) {
      if (t.delivering) {
        const d = t.delivering;
        if (now >= d.endAt) {
          t.volume = d.target;
          t.temperature = round(t.temperature + (this.rng() - 0.5) * 1.5, 1);
          this.reportTank(t, now, true);
          const end = this.measurementData(t, d.endAt);
          this.enqueue('UploadInTankDelivery', {
            Tank: t.cfg.no,
            FuelGradeId: t.cfg.gradeId,
            StartMeasurement: {
              DateTime: ptsLocalTime(d.startAt, this.opts.tzOffsetMinutes),
              ProductHeight: round((d.startVolume / t.cfg.capacityL) * t.cfg.heightMm, 1),
              WaterHeight: d.startWater,
              Temperature: d.startTemp,
              ProductVolume: round(d.startVolume),
              ProductTCVolume: round(d.startVolume * (1 - 0.00095 * (d.startTemp - 15))),
              ProductDensity: end.ProductDensity,
            },
            EndMeasurement: {
              DateTime: end.DateTime,
              ProductHeight: end.ProductHeight,
              WaterHeight: end.WaterHeight,
              Temperature: end.Temperature,
              ProductVolume: end.ProductVolume,
              ProductTCVolume: end.ProductTCVolume,
              ProductDensity: end.ProductDensity,
            },
          });
          this.stats.deliveries++;
          t.delivering = null;
        }
      } else if (t.volume < t.cfg.capacityL * this.opts.refillBelow) {
        t.delivering = {
          startAt: now, endAt: now + 2000, startVolume: t.volume, target: round(t.cfg.capacityL * this.opts.refillTo),
          startTemp: t.temperature, startWater: t.waterMm,
        };
      }
    }
  }

  /**
   * Advance the simulation to `now` (epoch ms). Generates transactions at the configured rate,
   * the tank measurements they cause, deliveries, alerts and periodic status.
   */
  tick(now = Date.now()): void {
    const dtS = this.lastTickAt === null ? 1 : Math.max(0, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;

    // random pump offline/online events
    if (this.rng() < this.opts.alertProbability) {
      const p = this.pumps[Math.floor(this.rng() * this.pumps.length)];
      p.online = !p.online;
      this.enqueue('UploadAlertRecord', {
        DateTime: ptsLocalTime(now, this.opts.tzOffsetMinutes),
        DeviceType: 'Pump', DeviceNumber: p.no, Type: p.online ? 'PumpOnline' : 'PumpOffline',
        State: p.online ? 'Cleared' : 'Active', Message: `Pump ${p.no} ${p.online ? 'online' : 'offline'}`,
      });
      this.stats.alerts++;
    }

    const n = this.poisson(this.opts.rate * dtS);
    for (let i = 0; i < n; i++) this.doTransaction(now);

    // temperature drift, slow water ingress
    for (const t of this.tanks) {
      t.temperature = round(Math.min(32, Math.max(15, t.temperature + (this.rng() - 0.5) * 0.05 * dtS)), 1);
      if (this.rng() < 0.0005 * dtS) t.waterMm = round(t.waterMm + 1, 1);
    }

    for (const t of this.tanks) if (!t.delivering) this.reportTank(t, now, t.forceNext);
    this.tickDeliveries(now);

    if ((now - this.lastStatusAt) / 1000 >= this.opts.statusIntervalS) {
      this.lastStatusAt = now;
      this.enqueue('UploadStatus', {
        DateTime: ptsLocalTime(now, this.opts.tzOffsetMinutes),
        Pumps: this.pumps.map((p) => ({ Pump: p.no, Status: p.online ? (p.busyUntil > now ? 'Filling' : 'Idle') : 'Offline' })),
        Probes: this.tanks.map((t) => ({ Probe: t.cfg.no, Status: 'OK', ProductHeight: this.height(t) })),
        Controller: { FirmwareVersion: 'SIM-1.0', PowerSupply: 'OK', CpuTemperature: 45 },
      });
      this.stats.statuses++;
    }
  }

  /**
   * Build the next upload request from the oldest unconfirmed packets (null if nothing pending).
   * Packets returned here stay in the queue until confirmed.
   */
  takeRequest(max = this.opts.maxPacketsPerRequest): JsonPtsRequest | null {
    if (!this.queue.length) return null;
    const packets = this.queue.slice(0, max);
    for (const p of packets) {
      if (this.everSent.has(p.Id)) this.stats.packetsResent++;
      this.everSent.add(p.Id);
      this.inFlight.add(p.Id);
    }
    return { Protocol: 'jsonPTS', PtsId: this.ptsId, Packets: packets };
  }

  /** Apply a server response: drop packets acknowledged with Error=false. Returns number confirmed. */
  confirm(res: JsonPtsResponse | null | undefined): number {
    this.inFlight.clear();
    const ok = new Set((res?.Packets ?? []).filter((p) => p && p.Error === false).map((p) => p.Id));
    if (!ok.size) return 0;
    const before = this.queue.length;
    this.queue = this.queue.filter((p) => !ok.has(p.Id));
    for (const id of ok) this.everSent.delete(id);
    const n = before - this.queue.length;
    this.stats.packetsConfirmed += n;
    return n;
  }

  /** Inject an arbitrary packet (tests: malformed packets, custom alerts). */
  inject(type: string, data: Record<string, unknown>): number {
    this.enqueue(type, data);
    return this.nextPacketId - 1;
  }
}
