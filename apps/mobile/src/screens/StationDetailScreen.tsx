import { Stack } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import {
  useDeliveries,
  usePumps,
  useStation,
  useStockout,
  useTanks,
  useTodaySales,
  useTodayTransactions,
} from '../api/queries';
import type { FiscalStatus, SalesSummaryRow } from '../api/types';
import { HBarChart, PumpCard, TankCard } from '../components/charts';
import { Badge, Card, Dot, Empty, ErrorBox, KV, Loading, OfflineBanner, Row, Screen, Section, T } from '../components/ui';
import {
  formatDateTime,
  formatDaysOfCover,
  formatLitres,
  formatNumber,
  formatRelative,
  formatTimeHHMM,
  formatZmw,
  productLabel,
  toNum,
} from '../lib/format';
import { connectivityColor, fuelColor, space, useTheme, type Palette } from '../theme';

export function fiscalColor(t: Palette, s: FiscalStatus | string): string {
  if (s === 'signed' || s === 'printed') return t.success;
  if (s === 'pending') return t.warning;
  if (s === 'failed') return t.danger;
  return t.textMuted;
}

function riskColor(t: Palette, r: string) {
  return r === 'high' ? t.danger : r === 'medium' ? t.warning : t.success;
}

/** Merge rows that share a key (e.g. several product rows for one pump). */
function aggregate(rows: SalesSummaryRow[], keyOf: (r: SalesSummaryRow) => string) {
  const m = new Map<string, { key: string; volume: number; amount: number; tx: number; product: string | null }>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = m.get(k) ?? { key: k, volume: 0, amount: 0, tx: 0, product: r.product_code };
    cur.volume += toNum(r.volume_l) ?? 0;
    cur.amount += toNum(r.amount) ?? 0;
    cur.tx += toNum(r.tx_count) ?? 0;
    m.set(k, cur);
  }
  return [...m.values()];
}

export default function StationDetailScreen({ id }: { id: string }) {
  const t = useTheme();
  const station = useStation(id);
  const pumps = usePumps(id);
  const tanks = useTanks(id);
  const byProduct = useTodaySales(id, 'product');
  const byPump = useTodaySales(id, 'pump');
  const txs = useTodayTransactions(id);
  const deliveries = useDeliveries(id);
  const stockout = useStockout(id);

  const s = station.data;
  const all = [station, pumps, tanks, byProduct, byPump, txs, deliveries];
  const refreshing = all.some((q) => q.isRefetching);
  const anyFailedWithData = all.some((q) => q.isError && q.data);
  const updatedAt = Math.max(...all.map((q) => q.dataUpdatedAt || 0)) || undefined;
  const tankList = tanks.data ?? s?.tanks ?? [];
  const connectivity = s?.connectivity ?? s?.health?.connectivity;

  return (
    <Screen refreshing={refreshing} onRefresh={() => all.forEach((q) => q.refetch())}>
      <Stack.Screen options={{ title: s?.name ?? 'Station' }} />
      <OfflineBanner updatedAt={updatedAt} failed={anyFailedWithData} />
      {station.isPending ? <Loading /> : null}
      {station.isError && !s ? <ErrorBox error={station.error} onRetry={() => station.refetch()} /> : null}

      {s ? (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="title" style={{ flex: 1 }}>{s.name}</T>
            <T variant="muted">{s.code}</T>
          </Row>
          <Row>
            <Dot color={connectivityColor(t, connectivity)} size={14} />
            <T style={{ fontWeight: '700' }}>{connectivity ?? 'unknown'}</T>
            <T variant="muted">· last seen {formatRelative(s.health?.controller_last_seen_at ?? s.controller_last_seen_at)}</T>
          </Row>
          <T variant="muted">{[s.town, s.district, s.province_name].filter(Boolean).join(', ')}</T>
          {s.health?.gateway_backlog ? (
            <T color={t.warning} style={{ fontWeight: '700' }}>
              Gateway backlog: {formatNumber(s.health.gateway_backlog)} records waiting to upload
            </T>
          ) : null}
        </Card>
      ) : null}

      <Section title="Pumps">
        {pumps.isPending ? <Loading /> : null}
        {pumps.isError && !pumps.data ? <Empty text="Pump data unavailable." /> : null}
        {pumps.data && pumps.data.length === 0 ? <Empty text="No pump has reported a sale yet." /> : null}
        {[...(pumps.data ?? [])]
          .sort((a, b) => a.pump_no - b.pump_no)
          .map((p) => (
            <PumpCard key={p.pump_no} pump={p} testID={`pump-${p.pump_no}`} />
          ))}
        <T variant="small">Totalizers as reported with each nozzle&apos;s latest sale.</T>
      </Section>

      <Section title="Tanks">
        {tanks.isPending && !s ? <Loading /> : null}
        {tankList.length === 0 && !tanks.isPending ? <Empty text="No tank data." /> : null}
        {tankList.map((tk) => (
          <TankCard key={tk.tank_no} tank={tk} testID={`tank-${tk.tank_no}`} />
        ))}
      </Section>

      <Section title="Stock-out risk">
        {stockout.isError ? (
          <Empty text="Forecast unavailable right now." />
        ) : stockout.data && stockout.data.length ? (
          stockout.data.map((r) => (
            <Card key={`${r.station_id}-${r.product_code}`}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="h2">{productLabel(r.product_code)}</T>
                <Badge label={`${r.risk.toUpperCase()} RISK`} color={riskColor(t, r.risk)} />
              </Row>
              <KV k="Days of cover" v={formatDaysOfCover(r.days_of_cover)} />
              <KV k="Avg daily sales" v={formatLitres(r.avg_daily_sales_l)} />
              <KV k="Predicted stock-out" v={r.predicted_stockout_date ?? 'not expected'} />
            </Card>
          ))
        ) : stockout.isPending ? (
          <Loading />
        ) : (
          <Empty text="No forecast for this station yet." />
        )}
      </Section>

      <Section title="Today by product">
        <Card>
          {byProduct.data?.length ? (
            <HBarChart
              data={aggregate(byProduct.data, (r) => r.product_code ?? r.bucket).map((r) => ({
                key: r.key,
                label: `${productLabel(r.key)} · ${formatLitres(r.volume)} · ${r.tx} tx`,
                value: r.amount,
                display: formatZmw(r.amount),
                color: fuelColor(t, r.key),
              }))}
            />
          ) : (
            <T variant="muted">{byProduct.isPending ? 'Loading…' : 'No sales yet today.'}</T>
          )}
        </Card>
      </Section>

      <Section title="Today by pump">
        <Card>
          {byPump.data?.length ? (
            <HBarChart
              data={aggregate(byPump.data, (r) => String(r.bucket ?? r.pump_no))
                .sort((a, b) => Number(a.key) - Number(b.key))
                .map((r) => ({
                  key: r.key,
                  label: `Pump ${r.key} · ${formatLitres(r.volume)}`,
                  value: r.amount,
                  display: formatZmw(r.amount),
                }))}
            />
          ) : (
            <T variant="muted">{byPump.isPending ? 'Loading…' : 'No sales yet today.'}</T>
          )}
        </Card>
      </Section>

      <Section title="Recent transactions">
        {txs.isError && !txs.data ? <ErrorBox error={txs.error} onRetry={() => txs.refetch()} /> : null}
        {txs.data && txs.data.length === 0 ? <Empty text="No transactions today." /> : null}
        {txs.data?.map((tx) => (
          <Card key={String(tx.id)} testID={`tx-${tx.id}`}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="h2">{formatZmw(tx.amount)}</T>
              <Badge label={tx.fiscal_status.toUpperCase()} color={fiscalColor(t, tx.fiscal_status)} />
            </Row>
            <T variant="muted">
              {formatTimeHHMM(tx.ended_at)} · Pump {tx.pump_no}/{tx.nozzle_no} · {productLabel(tx.product_code)} ·{' '}
              {formatLitres(tx.volume_l, 2)} @ {formatZmw(tx.price)}
            </T>
            <T variant="small">ZRA receipt: {tx.zra_rcpt_no ?? (tx.fiscal_status === 'failed' ? 'failed — will retry' : 'pending')}</T>
          </Card>
        ))}
      </Section>

      <Section title="Deliveries (14 days)">
        {deliveries.data && deliveries.data.length === 0 ? <Empty text="No deliveries recorded." /> : null}
        {deliveries.isError && !deliveries.data ? <Empty text="Deliveries unavailable." /> : null}
        {deliveries.data?.map((dv) => {
          const received = toNum(dv.received_volume_l) ?? ((toNum(dv.end_volume_l) ?? 0) - (toNum(dv.start_volume_l) ?? 0));
          const invoiced = toNum(dv.invoiced_volume_l);
          const diff = invoiced !== null ? received - invoiced : null;
          return (
            <Card key={String(dv.id)}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="h2">
                  Tank {dv.tank_no} · {productLabel(dv.product_code)}
                </T>
                <T style={{ fontWeight: '700' }}>{formatLitres(received)}</T>
              </Row>
              <T variant="muted">
                {formatDateTime(dv.ended_at)}
                {dv.supplier ? ` · ${dv.supplier}` : ''}
                {dv.delivery_note_no ? ` · note ${dv.delivery_note_no}` : ''}
              </T>
              {diff !== null ? (
                <T color={Math.abs(diff) > 50 ? t.danger : t.textMuted} style={{ fontWeight: '700' }}>
                  Invoiced {formatLitres(invoiced)} · difference {formatLitres(diff)}
                </T>
              ) : null}
            </Card>
          );
        })}
      </Section>
      <View style={{ height: space.lg }} />
    </Screen>
  );
}
