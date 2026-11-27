/**
 * `webhook` — signed outbound webhooks (DESIGN §8, CONTRACTS "Partner API").
 *
 * payload: { event, data, subscription_id?, delivery_id? }
 *  - without subscription_id: fan-out. One child job per matching active subscription is
 *    enqueued (dedupe "webhook:<job id>:<subscription id>"), so each endpoint retries independently.
 *  - with subscription_id: deliver once; non-2xx / network errors → retry with backoff.
 *
 * Scoping: when the event data identifies a province (data.province_id, or data.station_id →
 * stations.province_id) or company, subscriptions of province/company-scoped API clients only
 * receive matching events. A `province_id: null` (national data) is NOT sent to provincial clients.
 *
 * Request: POST <url>, JSON body {id, event, created_at, data},
 *   headers X-FMS-Signature: t=<unix>,v1=<hmac>, X-FMS-Event, X-FMS-Delivery.
 */
import { signWebhook } from '@fms/shared';
import { JobError, errorMessage, req } from '../core.js';
import type { HandlerContext, JobHandler } from './types.js';

interface SubRow {
  id: string;
  url: string;
  secret: string;
  province_id: number | null;
  company_id: string | null;
}

async function resolveScope(ctx: HandlerContext, data: Record<string, unknown>) {
  let province: number | null | undefined = 'province_id' in data ? (data.province_id === null ? null : Number(data.province_id)) : undefined;
  let company: string | null | undefined = typeof data.company_id === 'string' ? data.company_id : undefined;
  if ((province === undefined || company === undefined) && typeof data.station_id === 'string') {
    const { rows } = await ctx.db.query<{ province_id: number; company_id: string }>(
      'SELECT province_id, company_id FROM fms.stations WHERE id = $1::uuid',
      [data.station_id],
    );
    if (rows[0]) {
      province ??= rows[0].province_id;
      company ??= rows[0].company_id;
    }
  }
  return { province, company };
}

export function subscriptionInScope(sub: Pick<SubRow, 'province_id' | 'company_id'>, scope: { province?: number | null; company?: string | null }): boolean {
  if (sub.province_id !== null && scope.province !== undefined && scope.province !== sub.province_id) return false;
  if (sub.company_id !== null && scope.company !== undefined && scope.company !== sub.company_id) return false;
  return true;
}

async function fanOut(ctx: HandlerContext, event: string, data: Record<string, unknown>) {
  const { rows } = await ctx.db.query<SubRow>(
    `SELECT ws.id, ws.url, ws.secret, ac.province_id, ac.company_id
       FROM fms.webhook_subscriptions ws
       JOIN fms.api_clients ac ON ac.id = ws.api_client_id
      WHERE ws.is_active AND ac.is_active AND $1 = ANY(ws.events)`,
    [event],
  );
  const scope = await resolveScope(ctx, data);
  const targets = rows.filter((s) => subscriptionInScope(s, scope));
  let queued = 0;
  for (const s of targets) {
    const deliveryId = `${ctx.job.id}:${s.id}`;
    const id = await ctx.queue.enqueue({
      kind: 'webhook',
      payload: { event, data, subscription_id: s.id, delivery_id: deliveryId },
      dedupeKey: `webhook:${deliveryId}`,
      maxAttempts: ctx.config.webhook.maxAttempts,
    });
    if (id) queued++;
  }
  ctx.log.info({ event, subscriptions: rows.length, in_scope: targets.length, queued }, 'webhook fan-out');
}

async function deliver(ctx: HandlerContext, event: string, data: unknown, subscriptionId: string, deliveryId: string) {
  const { rows } = await ctx.db.query<SubRow>(
    `SELECT ws.id, ws.url, ws.secret, ac.province_id, ac.company_id
       FROM fms.webhook_subscriptions ws JOIN fms.api_clients ac ON ac.id = ws.api_client_id
      WHERE ws.id = $1::uuid AND ws.is_active AND ac.is_active`,
    [subscriptionId],
  );
  const sub = rows[0];
  if (!sub) {
    ctx.log.info({ subscription_id: subscriptionId }, 'webhook subscription inactive or deleted, dropping delivery');
    return;
  }
  const body = JSON.stringify({ id: deliveryId, event, created_at: ctx.job.created_at.toISOString(), data });
  let res: Response;
  try {
    res = await ctx.fetchImpl(sub.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': ctx.config.webhook.userAgent,
        'x-fms-event': event,
        'x-fms-delivery': deliveryId,
        'x-fms-signature': signWebhook(sub.secret, body),
      },
      body,
      signal: AbortSignal.timeout(ctx.config.webhook.timeoutMs),
      redirect: 'manual',
    });
    await res.arrayBuffer().catch(() => undefined);
  } catch (err) {
    ctx.metrics.webhookDeliveries.inc({ event, outcome: 'error' });
    throw new JobError(`webhook POST ${sub.url} failed: ${errorMessage(err)}`, true, 'WEBHOOK_NETWORK');
  }
  if (res.status < 200 || res.status >= 300) {
    ctx.metrics.webhookDeliveries.inc({ event, outcome: 'non_2xx' });
    throw new JobError(`webhook POST ${sub.url} returned HTTP ${res.status}`, true, 'WEBHOOK_HTTP');
  }
  ctx.metrics.webhookDeliveries.inc({ event, outcome: 'delivered' });
  ctx.log.info({ event, subscription_id: sub.id, status: res.status, delivery_id: deliveryId }, 'webhook delivered');
}

export const webhookHandler: JobHandler = {
  kind: 'webhook',
  async handle(ctx) {
    const p = ctx.job.payload;
    const event = req.str(p, 'event');
    const data = (p.data ?? {}) as Record<string, unknown>;
    if (typeof p.subscription_id === 'string' && p.subscription_id) {
      const deliveryId = typeof p.delivery_id === 'string' ? p.delivery_id : `${ctx.job.id}:${p.subscription_id}`;
      return deliver(ctx, event, data, req.uuid(p, 'subscription_id'), deliveryId);
    }
    return fanOut(ctx, event, data);
  },
  async onDead(ctx, error) {
    ctx.log.error({ event: ctx.job.payload.event, subscription_id: ctx.job.payload.subscription_id, error }, 'webhook delivery abandoned');
  },
};
