/** `notify` — alert notifications. payload: { station_id, alert } */
import { JobError, errorMessage, permanent, req } from '../core.js';
import type { Notification } from '../notifiers.js';
import type { JobHandler } from './types.js';

export const notifyHandler: JobHandler = {
  kind: 'notify',
  async handle(ctx) {
    const stationId = req.uuid(ctx.job.payload, 'station_id');
    const alert = (ctx.job.payload.alert ?? {}) as Record<string, unknown>;
    const { rows } = await ctx.db.query<{
      id: string; code: string; name: string; province_id: number; company_id: string; contact_email: string | null; contact_phone: string | null;
    }>(
      `SELECT s.id, s.code, s.name, s.province_id, s.company_id, c.contact_email, c.contact_phone
         FROM fms.stations s JOIN fms.companies c ON c.id = s.company_id WHERE s.id = $1::uuid`,
      [stationId],
    );
    const st = rows[0];
    if (!st) throw permanent(`station ${stationId} not found`, 'STATION_NOT_FOUND');

    // Owners of the company + managers with access to the station.
    const users = await ctx.db.query<{ email: string; phone: string | null }>(
      `SELECT u.email, u.phone FROM fms.users u
        WHERE u.is_active AND (
              (u.role = 'owner' AND u.company_id = $2::uuid)
           OR (u.role = 'manager' AND EXISTS (SELECT 1 FROM fms.user_station_access a WHERE a.user_id = u.id AND a.station_id = $1::uuid)))`,
      [st.id, st.company_id],
    );
    const emails = new Set<string>();
    const phones = new Set<string>();
    if (st.contact_email) emails.add(st.contact_email);
    if (st.contact_phone) phones.add(st.contact_phone);
    for (const u of users.rows) {
      emails.add(u.email);
      if (u.phone) phones.add(u.phone);
    }

    const severity = String(alert.severity ?? 'warning');
    const code = String(alert.code ?? 'Alert');
    const n: Notification = {
      station: { id: st.id, code: st.code, name: st.name, province_id: st.province_id, company_id: st.company_id },
      alert,
      severity,
      subject: `[FMS ${severity.toUpperCase()}] ${code} at ${st.name} (${st.code})`,
      text: [alert.message, alert.occurred_at ? `Time: ${String(alert.occurred_at)}` : null].filter(Boolean).join('\n') || code,
      recipients: { emails: [...emails], phones: [...phones] },
    };

    const failures: string[] = [];
    for (const notifier of ctx.notifiers) {
      try {
        await notifier.send(n);
        ctx.metrics.notifications.inc({ channel: notifier.channel, outcome: 'sent' });
      } catch (err) {
        ctx.metrics.notifications.inc({ channel: notifier.channel, outcome: 'error' });
        failures.push(`${notifier.channel}: ${errorMessage(err)}`);
      }
    }
    if (failures.length) throw new JobError(`notification channel(s) failed: ${failures.join('; ')}`, true, 'NOTIFY_FAILED');
  },
};
