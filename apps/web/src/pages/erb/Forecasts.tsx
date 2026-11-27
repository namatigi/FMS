import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { formatDate, formatDays, formatLitres, formatLitresCompact, formatNumber, formatPct, formatZMW, lusakaDate, num } from '../../lib/format';
import { productLabel, provinceName, type AiModel, type PricingBreakdownItem } from '../../types';
import { productColor } from '../../lib/theme';
import { Card, DateRange, Empty, Field, PageHeader, QueryView, RiskBadge, riskTone, FillBar, Kpi } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { ProductSelect, ProvinceSelect, useProvinceScope } from './common';

const SECTIONS = [
  { id: 'reserve', label: 'National reserve' },
  { id: 'demand', label: 'Demand forecast' },
  { id: 'stockout', label: 'Stock-out risk' },
  { id: 'anomalies', label: 'Anomalies' },
  { id: 'pricing', label: 'Pricing simulator' },
  { id: 'models', label: 'Custom AI models' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border)' };

function Reserve() {
  const q = useQuery({ queryKey: ['analytics', 'reserve'], queryFn: api.reserve, refetchInterval: 300_000 });
  return (
    <QueryView q={q} isEmpty={(d) => !d?.by_product?.length} empty={<Empty title="No reserve data" />}>
      {(d) => (
        <>
          <p className="muted">As of {formatDate(d.as_of)} · days of cover = stock ÷ average daily demand</p>
          <div className="product-cards">
            {d.by_product.map((p) => (
              <div key={p.product_code} className={`pcard pcard-${riskTone(p.risk)}`}>
                <div className="pcard-head">
                  <span className="prod"><i style={{ background: productColor(p.product_code) }} />{productLabel(p.product_code)}</span>
                  <RiskBadge value={p.risk} />
                </div>
                <div className="pcard-big">{formatDays(p.days_of_cover)}</div>
                <div className="muted">national days of cover</div>
                <FillBar pct={num(p.capacity_l) ? (num(p.stock_l) / num(p.capacity_l)) * 100 : 0} />
                <dl className="mini-dl">
                  <dt>Stock</dt><dd>{formatLitresCompact(p.stock_l)}</dd>
                  <dt>Demand/day</dt><dd>{formatLitresCompact(p.avg_daily_demand_l)}</dd>
                </dl>
                {p.by_province?.length ? (
                  <details className="details">
                    <summary>By province</summary>
                    <ul className="ptile-products">
                      {p.by_province.map((b) => (
                        <li key={b.province_id}>
                          <span>{b.province_name ?? provinceName(b.province_id)}</span>
                          <span className={`text-${riskTone(b.risk)}`}>{formatDays(b.days_of_cover)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </QueryView>
  );
}

function Demand({ scope }: { scope: ReturnType<typeof useProvinceScope> }) {
  const [product, setProduct] = useState('PETROL');
  const [horizon, setHorizon] = useState(14);
  const q = useQuery({
    queryKey: ['analytics', 'demand', scope.provinceId, product, horizon],
    queryFn: () => api.forecastDemand({ province_id: scope.provinceId || undefined, product_code: product, horizon_days: horizon }),
  });
  const data = useMemo(() => {
    if (!q.data) return [];
    const h = (q.data.history ?? []).map((x) => ({ date: x.date.slice(0, 10), actual: num(x.value) }));
    const f = (q.data.forecast ?? []).map((x) => ({ date: x.date.slice(0, 10), forecast: num(x.value), band: [num(x.lower), num(x.upper)] as [number, number] }));
    // join last actual to first forecast for a continuous line
    if (h.length && f.length) Object.assign(h[h.length - 1], { forecast: h[h.length - 1].actual });
    return [...h, ...f];
  }, [q.data]);
  return (
    <>
      <div className="toolbar">
        <ProvinceSelect scope={scope} />
        <ProductSelect value={product} onChange={setProduct} allowAll={false} />
        <Field label="Horizon (days)">
          {(id) => (
            <select id={id} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[7, 14, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
        </Field>
      </div>
      <QueryView q={q} isEmpty={(d) => !d?.history?.length && !d?.forecast?.length} empty={<Empty title="Not enough history to forecast" />}>
        {(d) => (
          <>
            <div className="kpi-grid kpi-grid-3">
              <Kpi label="Model" value={<span className="mono small">{d.model}</span>} />
              <Kpi label="MAPE (backtest)" value={formatPct(d.mape != null ? num(d.mape) * (num(d.mape) <= 1 ? 100 : 1) : null, 1)} />
              <Kpi label={`Forecast total (${horizon} d)`} value={formatLitresCompact((d.forecast ?? []).reduce((a, x) => a + num(x.value), 0))} />
            </div>
            <div className="chart" style={{ height: 340 }} aria-label="Demand forecast chart">
              <ResponsiveContainer>
                <ComposedChart data={data} margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tickFormatter={(x) => formatDate(x).slice(0, 6)} tick={{ fill: 'var(--muted)', fontSize: 12 }} minTickGap={20} />
                  <YAxis tickFormatter={(v) => formatLitresCompact(v)} width={80} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                  <Tooltip
                    labelFormatter={(x) => formatDate(x)}
                    formatter={(v: number | [number, number], name: string) => (Array.isArray(v) ? [`${formatLitres(v[0])} – ${formatLitres(v[1])}`, name] : [formatLitres(v), name])}
                    contentStyle={tooltipStyle}
                  />
                  <Legend />
                  <Area dataKey="band" name="Prediction interval" stroke="none" fill="#2563eb" fillOpacity={0.18} isAnimationActive={false} />
                  <Line dataKey="actual" name="Actual" stroke="#0891b2" strokeWidth={2} dot={false} />
                  <Line dataKey="forecast" name="Forecast" stroke="#2563eb" strokeDasharray="6 4" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </QueryView>
    </>
  );
}

function Stockout({ scope }: { scope: ReturnType<typeof useProvinceScope> }) {
  const [product, setProduct] = useState('');
  const q = useQuery({ queryKey: ['analytics', 'stockout', scope.provinceId, product], queryFn: () => api.stockout({ province_id: scope.provinceId || undefined, product_code: product || undefined }) });
  return (
    <>
      <div className="toolbar">
        <ProvinceSelect scope={scope} />
        <ProductSelect value={product} onChange={setProduct} />
      </div>
      <QueryView q={q} empty={<Empty title="No stations at risk" />}>
        {(rows) => (
          <DataTable
            dense
            caption="Stock-out risk"
            rows={[...rows].sort((a, b) => num(a.days_of_cover) - num(b.days_of_cover))}
            rowKey={(r) => `${r.station_id}-${r.product_code}`}
            rowClassName={(r) => (r.risk === 'high' ? 'row-bad' : r.risk === 'medium' ? 'row-warn' : undefined)}
            columns={[
              { key: 'station_name', header: 'Station', render: (r) => <Link to={`/stations/${r.station_id}`}>{r.station_name}</Link> },
              { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
              { key: 'stock_l', header: 'Stock', align: 'right', render: (r) => formatLitres(r.stock_l) },
              { key: 'avg_daily_sales_l', header: 'Avg daily sales', align: 'right', render: (r) => formatLitres(r.avg_daily_sales_l) },
              { key: 'days_of_cover', header: 'Days of cover', align: 'right', render: (r) => formatDays(r.days_of_cover) },
              { key: 'predicted_stockout_date', header: 'Predicted stock-out', render: (r) => formatDate(r.predicted_stockout_date) },
              { key: 'risk', header: 'Risk', render: (r) => <RiskBadge value={r.risk} /> },
            ]}
          />
        )}
      </QueryView>
    </>
  );
}

function Anomalies({ scope }: { scope: ReturnType<typeof useProvinceScope> }) {
  const [range, setRange] = useState({ from: lusakaDate(-29), to: lusakaDate(0) });
  const q = useQuery({ queryKey: ['analytics', 'anomalies', scope.provinceId, range], queryFn: () => api.anomalies({ province_id: scope.provinceId || undefined, from: range.from, to: range.to }) });
  const KIND: Record<string, string> = { stock_loss: 'Stock loss', totalizer: 'Totaliser mismatch', price: 'Price deviation' };
  return (
    <>
      <div className="toolbar">
        <ProvinceSelect scope={scope} />
        <DateRange from={range.from} to={range.to} onChange={(from, to) => setRange({ from, to })} />
      </div>
      <QueryView q={q} empty={<Empty title="No anomalies detected" />}>
        {(rows) => (
          <DataTable
            dense
            caption="Anomalies"
            rows={rows}
            rowKey={(r, i) => `${r.station_id}-${r.business_date}-${r.product_code}-${r.kind}-${i}`}
            rowClassName={(r) => (Math.abs(num(r.zscore)) >= 5 ? 'row-bad' : undefined)}
            columns={[
              { key: 'business_date', header: 'Date', render: (r) => formatDate(String(r.business_date).slice(0, 10)) },
              { key: 'station_name', header: 'Station', render: (r) => <Link to={`/stations/${r.station_id}/reconciliation`}>{r.station_name ?? r.station_id.slice(0, 8)}</Link> },
              { key: 'product_code', header: 'Product', render: (r) => productLabel(r.product_code) },
              { key: 'kind', header: 'Kind', render: (r) => KIND[r.kind] ?? r.kind },
              { key: 'variance_l', header: 'Variance', align: 'right', render: (r) => formatLitres(r.variance_l, 1) },
              { key: 'variance_pct', header: 'Variance %', align: 'right', render: (r) => formatPct(r.variance_pct, 2) },
              { key: 'zscore', header: 'Robust z', align: 'right', render: (r) => formatNumber(r.zscore, 2) },
            ]}
          />
        )}
      </QueryView>
    </>
  );
}

function breakdownLabel(b: PricingBreakdownItem) {
  return b.component ?? b.label ?? b.name ?? '?';
}
function breakdownValue(b: PricingBreakdownItem) {
  return num(b.zmw_per_l ?? b.value ?? b.amount);
}

/** Build waterfall rows: invisible base + visible delta, ending with a total bar. */
export function waterfall(items: PricingBreakdownItem[], total?: number) {
  let acc = 0;
  const rows = items.map((b) => {
    const v = breakdownValue(b);
    const start = acc;
    acc += v;
    return { name: breakdownLabel(b), base: Math.min(start, acc), delta: Math.abs(v), value: v, kind: v < 0 ? 'neg' : 'pos' };
  });
  rows.push({ name: 'Indicative price', base: 0, delta: total ?? acc, value: total ?? acc, kind: 'total' });
  return rows;
}

function Pricing() {
  const [form, setForm] = useState({ product_code: 'PETROL', fob_usd_per_mt: '780', fx_rate: '27.10', freight: '95', taxes: '', margins: '' });
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { product_code: form.product_code };
      for (const k of ['fob_usd_per_mt', 'fx_rate', 'freight', 'taxes', 'margins'] as const) if (form[k] !== '') body[k] = Number(form[k]);
      return api.simulatePrice(body);
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const wf = m.data ? waterfall(m.data.breakdown ?? [], num(m.data.indicative_price)) : [];
  return (
    <div className="grid-2 grid-narrow-left">
      <form className="form" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ProductSelect value={form.product_code} onChange={(v) => setForm((f) => ({ ...f, product_code: v }))} allowAll={false} />
        <Field label="FOB price (USD per metric tonne)">{(id) => <input id={id} inputMode="decimal" value={form.fob_usd_per_mt} onChange={set('fob_usd_per_mt')} />}</Field>
        <Field label="FX rate (ZMW per USD)">{(id) => <input id={id} inputMode="decimal" value={form.fx_rate} onChange={set('fx_rate')} />}</Field>
        <Field label="Freight (USD per metric tonne)">{(id) => <input id={id} inputMode="decimal" value={form.freight} onChange={set('freight')} />}</Field>
        <Field label="Taxes & levies override (ZMW/L)" hint="Leave blank to use the model default">{(id) => <input id={id} inputMode="decimal" value={form.taxes} onChange={set('taxes')} />}</Field>
        <Field label="Margins override (ZMW/L)" hint="Leave blank to use the model default">{(id) => <input id={id} inputMode="decimal" value={form.margins} onChange={set('margins')} />}</Field>
        <button type="submit" className="btn btn-primary" disabled={m.isPending}>{m.isPending ? 'Simulating…' : 'Simulate price'}</button>
        {m.isError && <div className="alert alert-error" role="alert">{errorMessage(m.error)}</div>}
      </form>
      <div>
        {!m.data ? (
          <Empty title="Run a simulation">Enter cost assumptions and press Simulate to see the ERB-style price build-up.</Empty>
        ) : (
          <>
            <div className="kpi-grid kpi-grid-2">
              <Kpi label="Indicative pump price" value={`${formatZMW(m.data.indicative_price)} /L`} tone="info" />
              <Kpi label="Model" value={<span className="mono small">{m.data.model}</span>} />
            </div>
            <div className="chart" style={{ height: 300 }}>
              <ResponsiveContainer>
                <BarChart data={wf} margin={{ left: 8, right: 8, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="name" interval={0} angle={-30} textAnchor="end" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `K${v}`} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                  <Tooltip formatter={(_v: number, _n: string, p: { payload?: { value: number } }) => [formatZMW(p.payload?.value), 'ZMW/L']} contentStyle={tooltipStyle} />
                  <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} legendType="none" />
                  <Bar dataKey="delta" stackId="w" isAnimationActive={false}>
                    {wf.map((r, i) => <Cell key={i} fill={r.kind === 'total' ? '#0b5d3b' : r.kind === 'neg' ? '#dc2626' : '#2563eb'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <DataTable
              dense
              caption="Price build-up"
              rows={(m.data.breakdown ?? []).map((b, i) => ({ i, name: breakdownLabel(b), value: breakdownValue(b) }))}
              rowKey={(r) => r.i}
              columns={[
                { key: 'name', header: 'Component', sortable: false },
                { key: 'value', header: 'ZMW / L', align: 'right', sortable: false, render: (r) => formatZMW(r.value) },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}

function Models() {
  const q = useQuery({ queryKey: ['analytics', 'models'], queryFn: api.models });
  const [sel, setSel] = useState<string>('');
  const [input, setInput] = useState('{\n  \n}');
  const [parseErr, setParseErr] = useState<string | null>(null);
  const m = useMutation({ mutationFn: (inputs: unknown) => api.predict(sel, inputs) });
  const choose = (mdl: AiModel) => {
    setSel(mdl.name);
    setInput(JSON.stringify(mdl.example_inputs ?? {}, null, 2));
    setParseErr(null);
    m.reset();
  };
  return (
    <QueryView q={q} empty={<Empty title="No custom models registered">Register models in the analytics service configuration (Python entry point or HTTP endpoint).</Empty>}>
      {(models) => (
        <div className="grid-2 grid-narrow-left">
          <div>
            <ul className="model-list" role="listbox" aria-label="Registered models">
              {models.map((mdl) => (
                <li key={mdl.name}>
                  <button type="button" role="option" aria-selected={sel === mdl.name} className={sel === mdl.name ? 'active' : ''} onClick={() => choose(mdl)}>
                    <strong className="mono">{mdl.name}</strong>
                    <span className="muted">{[mdl.kind ?? mdl.type, mdl.version && `v${mdl.version}`].filter(Boolean).join(' · ')}</span>
                    {mdl.description && <small>{mdl.description}</small>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            {!sel ? (
              <Empty title="Select a model">Choose a model to run a prediction.</Empty>
            ) : (
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  try {
                    const parsed = JSON.parse(input);
                    setParseErr(null);
                    m.mutate(parsed);
                  } catch (err) {
                    setParseErr(`Invalid JSON: ${(err as Error).message}`);
                  }
                }}
              >
                <Field label={`Inputs for ${sel} (JSON)`} error={parseErr}>
                  {(id) => <textarea id={id} rows={10} className="mono" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />}
                </Field>
                <button type="submit" className="btn btn-primary" disabled={m.isPending}>{m.isPending ? 'Running…' : 'Predict'}</button>
                {m.isError && <div className="alert alert-error" role="alert">{errorMessage(m.error)}</div>}
                {m.data && (
                  <div className="result">
                    <div className="muted">
                      {m.data.model} · version {m.data.version}
                    </div>
                    <pre className="code-block">{JSON.stringify(m.data.outputs, null, 2)}</pre>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      )}
    </QueryView>
  );
}

export default function Forecasts() {
  const [params, setParams] = useSearchParams();
  const section = (params.get('s') as SectionId) || 'reserve';
  const scope = useProvinceScope();
  return (
    <>
      <PageHeader title="Forecasts & AI" subtitle="Demand forecasting, stock-out prediction, national reserve, anomaly detection, pricing and custom models" />
      <nav className="tabs" aria-label="Analytics sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`tab ${section === s.id ? 'active' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => setParams({ s: s.id })}>
            {s.label}
          </button>
        ))}
      </nav>
      <Card>
        {section === 'reserve' && <Reserve />}
        {section === 'demand' && <Demand scope={scope} />}
        {section === 'stockout' && <Stockout scope={scope} />}
        {section === 'anomalies' && <Anomalies scope={scope} />}
        {section === 'pricing' && <Pricing />}
        {section === 'models' && <Models />}
      </Card>
    </>
  );
}
