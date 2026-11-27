/**
 * Local admin UI (EDGE_UI_PORT): server-rendered HTML status page (no build step), JSON API,
 * health and Prometheus metrics. Works without internet: everything comes from the local DB.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Gauge } from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import type { FiscalClient, ReceiptPrinter } from '@fms/shared';
import type { Logger } from 'pino';
import type { GatewayConfig } from '../config.js';
import type { ConfigStore } from '../configStore.js';
import type { Pool } from '../db.js';
import type { FiscalPipeline } from '../fiscal/pipeline.js';
import type { HaMonitor } from '../ha.js';
import type { Metrics } from '../metrics.js';
import type { SyncLoop } from '../sync/sync.js';

export interface UiDeps {
  pool: Pool;
  cfg: GatewayConfig;
  log: Logger;
  metrics: Metrics;
  config: ConfigStore;
  pipeline: FiscalPipeline;
  sync: SyncLoop;
  ha: HaMonitor;
  fiscalClient: FiscalClient;
  printer: ReceiptPrinter;
  startedAt: number;
}

const ONLINE_WINDOW_S = 60;

export async function backlog(pool: Pool) {
  const r = await pool.query<{
    outbox_unsent: number; outbox_parked: number; outbox_oldest_unsent: Date | null;
    fiscal_pending: number; fiscal_unprinted: number; fiscal_failed: number; fiscal_oldest_pending: Date | null;
  }>(`SELECT
      (SELECT count(*) FROM edge.outbox WHERE sent_at IS NULL AND parked_at IS NULL)::int AS outbox_unsent,
      (SELECT count(*) FROM edge.outbox WHERE parked_at IS NOT NULL AND sent_at IS NULL)::int AS outbox_parked,
      (SELECT min(created_at) FROM edge.outbox WHERE sent_at IS NULL AND parked_at IS NULL) AS outbox_oldest_unsent,
      (SELECT count(*) FROM edge.fiscal_receipts WHERE status = 'pending')::int AS fiscal_pending,
      (SELECT count(*) FROM edge.fiscal_receipts WHERE status = 'signed')::int AS fiscal_unprinted,
      (SELECT count(*) FROM edge.fiscal_receipts WHERE status = 'failed')::int AS fiscal_failed,
      (SELECT min(created_at) FROM edge.fiscal_receipts WHERE status = 'pending') AS fiscal_oldest_pending`);
  return r.rows[0];
}

export async function controllersStatus(pool: Pool, cfg: GatewayConfig) {
  const r = await pool.query<{ pts_id: string; last_seen_at: Date | null; last_status_at: Date | null; packets_ok: number; packets_error: number; online: boolean }>(
    `SELECT pts_id, last_seen_at, last_status_at, packets_ok, packets_error,
            COALESCE(last_seen_at > now() - make_interval(secs => $1), false) AS online
       FROM edge.controllers ORDER BY pts_id`,
    [ONLINE_WINDOW_S],
  );
  const seen = new Map(r.rows.map((x) => [x.pts_id, x]));
  const out = cfg.controllers.map((c) => ({
    ...(seen.get(c.pts_id) ?? { last_seen_at: null, last_status_at: null, packets_ok: 0, packets_error: 0, online: false }),
    pts_id: c.pts_id, configured: true, control_url: c.control_url ?? null, signed: !!c.secret,
  }));
  for (const x of r.rows) if (!cfg.controllers.some((c) => c.pts_id === x.pts_id)) out.push({ ...x, configured: false, control_url: null, signed: false });
  return out;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
const fmtTime = (v: unknown) => (v ? new Date(v as string).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '-');
const fmtNum = (v: unknown, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));

export function buildUiServer(deps: UiDeps): FastifyInstance {
  const { pool, cfg, metrics } = deps;
  const app = Fastify({ loggerInstance: deps.log.child({ component: 'ui' }, { level: deps.log.levelVal > 40 ? deps.log.level : 'warn' }) as unknown as FastifyBaseLogger });

  // Gauges computed from the DB at scrape time.
  new Gauge({
    name: 'edge_outbox_backlog', help: 'Outbox records not yet accepted by the cloud', labelNames: ['state'], registers: [metrics.registry],
    async collect() {
      const b = await backlog(pool);
      this.set({ state: 'unsent' }, b.outbox_unsent);
      this.set({ state: 'parked' }, b.outbox_parked);
    },
  });
  new Gauge({
    name: 'edge_fiscal_backlog', help: 'Fiscal receipts by unfinished state', labelNames: ['state'], registers: [metrics.registry],
    async collect() {
      const b = await backlog(pool);
      this.set({ state: 'pending' }, b.fiscal_pending);
      this.set({ state: 'signed_unprinted' }, b.fiscal_unprinted);
      this.set({ state: 'failed' }, b.fiscal_failed);
    },
  });
  new Gauge({
    name: 'edge_controllers_online', help: 'PTS-2 controllers heard from in the last 60 s', registers: [metrics.registry],
    async collect() {
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM edge.controllers WHERE last_seen_at > now() - interval '60 seconds'`);
      this.set(r.rows[0].n);
    },
  });

  let fiscalHealth: { at: number; value: { ok: boolean; detail?: string } } | null = null;
  const getFiscalHealth = async () => {
    if (fiscalHealth && Date.now() - fiscalHealth.at < 30_000) return fiscalHealth.value;
    const value = await Promise.race([
      deps.fiscalClient.health().catch((e: Error) => ({ ok: false, detail: e.message })),
      new Promise<{ ok: boolean; detail: string }>((r) => setTimeout(() => r({ ok: false, detail: 'health check timeout' }), 3000).unref()),
    ]);
    fiscalHealth = { at: Date.now(), value };
    return value;
  };

  // Optional basic auth for everything except probes/metrics.
  if (cfg.ui.user && cfg.ui.password) {
    const expected = Buffer.from(`Basic ${Buffer.from(`${cfg.ui.user}:${cfg.ui.password}`).toString('base64')}`);
    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      if (['/healthz', '/readyz', '/metrics'].includes(req.url.split('?')[0])) return;
      const got = Buffer.from(req.headers.authorization ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return reply.code(401).header('www-authenticate', 'Basic realm="FMS edge gateway"').send({ error: 'unauthorized' });
      }
    });
  }

  const status = async () => {
    const [b, controllers, printer, fiscal] = await Promise.all([
      backlog(pool),
      controllersStatus(pool, cfg),
      deps.printer.status().catch((e: Error) => ({ online: false, paper: 'unknown', detail: e.message })),
      getFiscalHealth(),
    ]);
    return {
      station: deps.config.station,
      gateway: { code: cfg.cloud.gatewayCode, version: cfg.version, uptime_s: Math.round((Date.now() - deps.startedAt) / 1000) },
      ha: { mode: cfg.ha.mode, vip: cfg.ha.vip, active: deps.ha.isActive() },
      controllers,
      cloud: { url: cfg.cloud.ingestUrl, ...deps.sync.state },
      backlog: b,
      fiscal_client: fiscal,
      printer,
    };
  };

  const transactions = async (limit: number) =>
    (await pool.query(
      `SELECT t.id, t.pts_id, t.pump_no, t.nozzle_no, t.pts_transaction_no, t.grade_name, t.ended_at, t.volume_l, t.price, t.amount,
              t.fiscal_status, f.id AS receipt_id, f.invoice_no, f.zra_rcpt_no, f.attempts, f.last_error, f.printed_at
         FROM edge.transactions t LEFT JOIN edge.fiscal_receipts f ON f.transaction_id = t.id
        ORDER BY t.ended_at DESC, t.id DESC LIMIT $1`,
      [limit],
    )).rows;
  const tanks = async () =>
    (await pool.query(`SELECT * FROM edge.tank_latest ORDER BY pts_id, tank_no`)).rows;
  const alerts = async (limit: number) =>
    (await pool.query(`SELECT id, pts_id, occurred_at, device_type, device_no, code, severity, message, source FROM edge.alerts ORDER BY occurred_at DESC, id DESC LIMIT $1`, [limit])).rows;
  const lim = (q: unknown, d = 50) => Math.min(500, Math.max(1, Number((q as { limit?: string })?.limit ?? d) || d));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, active: deps.ha.isActive() };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });
  app.get('/metrics', async (_req, reply) => {
    metrics.haActive.set(deps.ha.isActive() ? 1 : 0);
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.get('/api/status', status);
  app.get('/api/transactions', async (req) => ({ items: await transactions(lim(req.query)) }));
  app.get('/api/tanks', async () => ({ items: await tanks() }));
  app.get('/api/alerts', async (req) => ({ items: await alerts(lim(req.query)) }));
  app.get('/api/fiscal', async (req) => {
    const q = req.query as { status?: string };
    const r = await pool.query(
      `SELECT f.*, t.pump_no, t.pts_transaction_no, t.ended_at, t.amount FROM edge.fiscal_receipts f JOIN edge.transactions t ON t.id = f.transaction_id
        WHERE ($1::text IS NULL OR f.status = $1) ORDER BY f.id DESC LIMIT $2`,
      [q.status ?? null, lim(req.query)],
    );
    return { items: r.rows };
  });
  app.get('/api/outbox', async () => {
    const byKind = await pool.query(
      `SELECT kind, count(*) FILTER (WHERE sent_at IS NULL AND parked_at IS NULL)::int AS unsent,
              count(*) FILTER (WHERE parked_at IS NOT NULL AND sent_at IS NULL)::int AS parked,
              count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent
         FROM edge.outbox GROUP BY kind ORDER BY kind`,
    );
    const parked = await pool.query(`SELECT seq, kind, created_at, attempts, last_error, parked_at FROM edge.outbox WHERE parked_at IS NOT NULL AND sent_at IS NULL ORDER BY seq LIMIT 100`);
    return { by_kind: byKind.rows, parked: parked.rows, sync: deps.sync.state };
  });
  app.get('/api/config', async () => ({ station: deps.config.station, fuel_grades: deps.config.allGrades() }));
  app.get('/api/commands', async () => ({ items: (await pool.query(`SELECT * FROM edge.commands_applied ORDER BY received_at DESC LIMIT 100`)).rows }));

  const reprint = async (id: number) => deps.pipeline.reprint(id);
  app.post('/api/fiscal/:id/reprint', async (req, reply) => {
    try {
      return { ok: true, ...(await reprint(Number((req.params as { id: string }).id))) };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 502).send({ ok: false, error: err.message });
    }
  });
  app.post('/api/fiscal/:id/retry', async (req, reply) => {
    const ok = await deps.pipeline.requeue(Number((req.params as { id: string }).id));
    return ok ? { ok } : reply.code(409).send({ ok: false, error: 'receipt is not in failed state' });
  });
  app.post('/api/outbox/unpark', async () => {
    const r = await pool.query(`UPDATE edge.outbox SET parked_at = NULL, attempts = 0 WHERE parked_at IS NOT NULL AND sent_at IS NULL`);
    deps.sync.kick();
    return { ok: true, requeued: r.rowCount };
  });
  // HTML form variants (no JS needed)
  app.post('/ui/fiscal/:id/reprint', async (req, reply) => {
    let msg: string;
    try {
      msg = `Reprinted ${(await reprint(Number((req.params as { id: string }).id))).invoice_no}`;
    } catch (e) {
      msg = `Reprint failed: ${(e as Error).message}`;
    }
    return reply.redirect(`/?msg=${encodeURIComponent(msg)}`, 303);
  });
  app.post('/ui/fiscal/:id/retry', async (req, reply) => {
    const ok = await deps.pipeline.requeue(Number((req.params as { id: string }).id));
    return reply.redirect(`/?msg=${encodeURIComponent(ok ? 'Receipt queued for fiscalisation' : 'Receipt is not failed')}`, 303);
  });

  app.get('/', async (req, reply) => {
    const [s, tx, tk, al] = await Promise.all([status(), transactions(30), tanks(), alerts(15)]);
    const msg = (req.query as { msg?: string }).msg;
    const badge = (ok: boolean, yes: string, no: string) => `<span class="b ${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`;
    const fsBadge = (st: string) => `<span class="b fs-${esc(st)}">${esc(st)}</span>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Edge gateway ${esc(s.station.code)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1d2330}
header{background:#13315c;color:#fff;padding:12px 16px}header h1{margin:0;font-size:18px}header p{margin:4px 0 0;opacity:.8}
main{padding:16px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
section{background:#fff;border-radius:8px;padding:12px 14px;box-shadow:0 1px 2px #0002;overflow-x:auto}
section.wide{grid-column:1/-1}h2{font-size:15px;margin:0 0 8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee;white-space:nowrap}th{color:#667;font-weight:600}
.b{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#eee}.ok,.fs-printed{background:#d5f5dd;color:#11602a}
.bad,.fs-failed{background:#fbd9d9;color:#8a1111}.fs-pending,.fs-signed{background:#fff1c9;color:#7a5600}.fs-exempt{background:#e6e8ee}
.msg{grid-column:1/-1;background:#e7f0ff;padding:8px 12px;border-radius:6px}.kv td:first-child{color:#667}
button{font-size:12px;padding:2px 8px;cursor:pointer}.bar{height:8px;background:#e6e8ee;border-radius:4px;min-width:80px}.bar>i{display:block;height:8px;border-radius:4px;background:#2a7de1}
.sev-critical{color:#8a1111;font-weight:600}.sev-warning{color:#7a5600}
</style></head><body>
<header><h1>${esc(s.station.name)} (${esc(s.station.code)}) - edge gateway ${esc(s.gateway.code)}</h1>
<p>v${esc(s.gateway.version)} - up ${Math.round(s.gateway.uptime_s / 60)} min - HA ${esc(s.ha.mode)}: ${s.ha.active ? 'ACTIVE' : 'STANDBY'} - ${fmtTime(new Date())}</p></header>
<main>
${msg ? `<div class="msg">${esc(msg)}</div>` : ''}
<section><h2>Cloud connectivity</h2><table class="kv">
<tr><td>Status</td><td>${s.cloud.url ? badge(s.cloud.connected, 'connected', s.cloud.lastAttemptAt ? 'offline' : 'not yet synced') : '<span class="b bad">disabled</span>'}</td></tr>
<tr><td>Last success</td><td>${fmtTime(s.cloud.lastSuccessAt)}</td></tr>
<tr><td>Last error</td><td>${esc(s.cloud.lastError ?? '-')}</td></tr>
<tr><td>Outbox backlog</td><td>${s.backlog.outbox_unsent} unsent, ${s.backlog.outbox_parked} parked</td></tr>
<tr><td>Oldest unsent</td><td>${fmtTime(s.backlog.outbox_oldest_unsent)}</td></tr></table></section>
<section><h2>Fiscalisation (ZRA VSDC)</h2><table class="kv">
<tr><td>VSDC</td><td>${badge(s.fiscal_client.ok, 'ok', 'unavailable')} ${esc(s.fiscal_client.detail ?? '')}</td></tr>
<tr><td>Printer</td><td>${badge(s.printer.online, 'online', 'offline')} paper ${esc(s.printer.paper)} ${esc(s.printer.detail ?? '')}</td></tr>
<tr><td>Pending signature</td><td>${s.backlog.fiscal_pending}</td></tr>
<tr><td>Signed, not printed</td><td>${s.backlog.fiscal_unprinted}</td></tr>
<tr><td>Failed</td><td>${s.backlog.fiscal_failed}</td></tr>
<tr><td>Oldest pending</td><td>${fmtTime(s.backlog.fiscal_oldest_pending)}</td></tr></table></section>
<section><h2>PTS-2 controllers</h2><table><tr><th>PTS id</th><th>Status</th><th>Last seen</th><th>Packets ok/err</th></tr>
${s.controllers.map((c) => `<tr><td>${esc(c.pts_id)}${c.configured ? '' : ' (unconfigured)'}</td><td>${badge(!!c.online, 'online', 'offline')}</td><td>${fmtTime(c.last_seen_at)}</td><td>${c.packets_ok}/${c.packets_error}</td></tr>`).join('') || '<tr><td colspan="4">none</td></tr>'}
</table></section>
<section><h2>Tanks</h2><table><tr><th>Tank</th><th>Volume L</th><th>Fill</th><th>Water mm</th><th>Temp C</th><th>Alarms</th><th>Measured</th></tr>
${tk.map((t) => {
  const cap = Number(t.product_volume_l ?? 0) + Number(t.ullage_l ?? 0);
  const pct = cap > 0 ? Math.round((Number(t.product_volume_l) / cap) * 100) : 0;
  return `<tr><td>${esc(t.tank_no)}</td><td>${fmtNum(t.product_volume_l, 0)}</td><td><div class="bar"><i style="width:${pct}%"></i></div>${pct}%</td><td>${fmtNum(t.water_height_mm, 1)}</td><td>${fmtNum(t.temperature_c, 1)}</td><td>${esc((t.alarms ?? []).join(', '))}</td><td>${fmtTime(t.measured_at)}</td></tr>`;
}).join('') || '<tr><td colspan="7">no measurements yet</td></tr>'}
</table></section>
<section class="wide"><h2>Last transactions</h2><table><tr><th>Ended</th><th>Pump/Nozzle</th><th>Tx no</th><th>Grade</th><th>Volume L</th><th>Price</th><th>Amount</th><th>Fiscal</th><th>Invoice</th><th>ZRA rcpt</th><th>Error</th><th></th></tr>
${tx.map((t) => `<tr><td>${fmtTime(t.ended_at)}</td><td>${t.pump_no}/${t.nozzle_no}</td><td>${t.pts_transaction_no}</td><td>${esc(t.grade_name)}</td><td>${fmtNum(t.volume_l)}</td><td>${fmtNum(t.price)}</td><td>${fmtNum(t.amount)}</td><td>${fsBadge(t.fiscal_status)}</td><td>${esc(t.invoice_no ?? '-')}</td><td>${esc(t.zra_rcpt_no ?? '-')}</td><td>${esc((t.last_error ?? '').slice(0, 60))}</td><td>${
  t.receipt_id && (t.fiscal_status === 'signed' || t.fiscal_status === 'printed') ? `<form method="post" action="/ui/fiscal/${t.receipt_id}/reprint"><button>Reprint</button></form>`
  : t.receipt_id && t.fiscal_status === 'failed' ? `<form method="post" action="/ui/fiscal/${t.receipt_id}/retry"><button>Retry</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="12">no transactions yet</td></tr>'}
</table></section>
<section class="wide"><h2>Recent alerts</h2><table><tr><th>Time</th><th>Device</th><th>Code</th><th>Severity</th><th>Message</th></tr>
${al.map((a) => `<tr><td>${fmtTime(a.occurred_at)}</td><td>${esc(a.device_type)} ${esc(a.device_no ?? '')}</td><td>${esc(a.code)}</td><td class="sev-${esc(a.severity)}">${esc(a.severity)}</td><td>${esc(a.message ?? '')}</td></tr>`).join('') || '<tr><td colspan="5">none</td></tr>'}
</table></section>
</main></body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });

  return app;
}
