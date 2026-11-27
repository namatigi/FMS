/**
 * Active/standby detection. Two gateways on the station LAN each have their own local Postgres, so
 * there is no shared lock to elect a leader. Instead keepalived (VRRP) owns the decision: it moves
 * a virtual IP to the healthy primary, the PTS-2 uploads to that VIP, and only the instance that
 * currently holds the VIP runs the fiscal pipeline and cloud sync. See deploy/REDUNDANCY.md.
 *
 *   HA_MODE=always   single gateway (default) - always active
 *   HA_MODE=vip      active while HA_VIP is assigned to a local network interface
 *   HA_MODE=file     active while HA_STATE_FILE contains MASTER (written by keepalived notify script)
 *   HA_MODE=standby  never active (cold standby: stores uploads, never fiscalises/syncs)
 */
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { GatewayConfig } from './config.js';

export class HaMonitor {
  private active: boolean;
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(active: boolean) => void> = [];

  constructor(private readonly cfg: GatewayConfig['ha'], private readonly log: Logger) {
    this.active = cfg.mode === 'always';
  }

  isActive(): boolean {
    return this.active;
  }

  onChange(fn: (active: boolean) => void): void {
    this.listeners.push(fn);
  }

  async check(): Promise<boolean> {
    let next: boolean;
    switch (this.cfg.mode) {
      case 'always':
        next = true;
        break;
      case 'standby':
        next = false;
        break;
      case 'vip': {
        const vip = this.cfg.vip;
        next = !!vip && Object.values(networkInterfaces()).some((list) => (list ?? []).some((a) => a.address === vip));
        break;
      }
      case 'file': {
        try {
          const s = this.cfg.stateFile ? await readFile(this.cfg.stateFile, 'utf8') : '';
          next = /MASTER/i.test(s);
        } catch {
          next = false;
        }
        break;
      }
    }
    if (next !== this.active) {
      this.active = next;
      this.log.warn({ active: next, mode: this.cfg.mode }, next ? 'HA: this gateway is now ACTIVE' : 'HA: this gateway is now STANDBY');
      for (const l of this.listeners) l(next);
    }
    return next;
  }

  async start(): Promise<void> {
    await this.check();
    if (this.cfg.mode === 'vip' || this.cfg.mode === 'file') {
      this.timer = setInterval(() => void this.check(), this.cfg.checkMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
