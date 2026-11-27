/**
 * Pluggable alert notifiers for the `notify` job. Every notifier receives the
 * same Notification; channels are enabled by environment variables:
 *   (always)          LogNotifier
 *   SMTP_HOST         SmtpNotifier   — stub: logs the e-mail; plug in an SMTP transport (e.g. nodemailer)
 *   SMS_GATEWAY_URL   SmsNotifier    — POSTs {to, message} JSON to an SMS gateway (Bearer SMS_GATEWAY_TOKEN)
 *   FCM_PROJECT_ID    FcmNotifier    — stub: logs the push to topic station-<id>; needs FCM HTTP v1 credentials
 */
import type { WorkerConfig } from './config.js';
import type { Logger } from './core.js';
import { JobError } from './core.js';

export interface Notification {
  station: { id: string; code: string; name: string; province_id: number; company_id: string };
  alert: Record<string, unknown>;
  severity: string;
  subject: string;
  text: string;
  recipients: { emails: string[]; phones: string[] };
}

export interface Notifier {
  readonly channel: string;
  send(n: Notification): Promise<void>;
}

export class LogNotifier implements Notifier {
  readonly channel = 'log';
  constructor(private readonly log: Logger) {}
  async send(n: Notification) {
    this.log.warn({ station: n.station.code, severity: n.severity, alert: n.alert, recipients: n.recipients }, n.subject);
  }
}

export class SmtpNotifier implements Notifier {
  readonly channel = 'email';
  constructor(private readonly cfg: NonNullable<WorkerConfig['notify']['smtp']>, private readonly log: Logger) {}
  async send(n: Notification) {
    if (!n.recipients.emails.length) return;
    // Stub: wire an SMTP transport here (kept dependency-free on purpose).
    this.log.info({ smtp: `${this.cfg.host}:${this.cfg.port}`, from: this.cfg.from, to: n.recipients.emails, subject: n.subject }, 'email notification (stub)');
  }
}

export class SmsNotifier implements Notifier {
  readonly channel = 'sms';
  constructor(
    private readonly cfg: NonNullable<WorkerConfig['notify']['sms']>,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(n: Notification) {
    if (!n.recipients.phones.length) return;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;
    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: n.recipients.phones, message: `${n.subject}\n${n.text}`.slice(0, 480) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new JobError(`SMS gateway HTTP ${res.status}`, true);
    this.log.info({ to: n.recipients.phones.length }, 'sms notification sent');
  }
}

export class FcmNotifier implements Notifier {
  readonly channel = 'push';
  constructor(private readonly cfg: NonNullable<WorkerConfig['notify']['fcm']>, private readonly log: Logger) {}
  async send(n: Notification) {
    // Stub: needs FCM HTTP v1 OAuth credentials; the mobile app subscribes to topic station-<id>.
    this.log.info({ project: this.cfg.projectId, topic: `station-${n.station.id}`, title: n.subject }, 'push notification (stub)');
  }
}

export function notifiersFromConfig(cfg: WorkerConfig, log: Logger, fetchImpl: typeof fetch = fetch): Notifier[] {
  const out: Notifier[] = [new LogNotifier(log)];
  if (cfg.notify.smtp) out.push(new SmtpNotifier(cfg.notify.smtp, log));
  if (cfg.notify.sms) out.push(new SmsNotifier(cfg.notify.sms, log, fetchImpl));
  if (cfg.notify.fcm) out.push(new FcmNotifier(cfg.notify.fcm, log));
  return out;
}
