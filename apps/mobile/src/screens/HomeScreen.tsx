import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { useCurrentUser } from '../api/ApiContext';
import { useOverview } from '../api/queries';
import { FillBar, HBarChart } from '../components/charts';
import { Badge, Card, Empty, ErrorBox, Loading, OfflineBanner, Row, Screen, Section, StatTile, T } from '../components/ui';
import { formatLitres, formatNumber, formatPct, formatTimeHHMM, formatZmw, productLabel, toNum } from '../lib/format';
import { fuelColor, space, useTheme } from '../theme';

export default function HomeScreen() {
  const t = useTheme();
  const router = useRouter();
  const user = useCurrentUser();
  const q = useOverview();
  const d = q.data;

  return (
    <Screen refreshing={q.isRefetching} onRefresh={() => q.refetch()}>
      <View>
        <T variant="muted">Welcome{user ? `, ${user.full_name}` : ''}</T>
        <T variant="title">Today</T>
      </View>
      <OfflineBanner updatedAt={q.dataUpdatedAt || undefined} failed={q.isError && !!d} />

      {q.isPending ? <Loading /> : null}
      {q.isError && !d ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}

      {d ? (
        <>
          <Card testID="sales-today">
            <T variant="label">Sales today</T>
            <T variant="big" testID="sales-amount">{formatZmw(d.sales_today.amount)}</T>
            <Row gap={space.xl}>
              <T style={{ fontWeight: '700' }} testID="sales-volume">{formatLitres(d.sales_today.volume_l)}</T>
              <T style={{ fontWeight: '700' }} testID="sales-tx">{formatNumber(d.sales_today.tx_count)} sales</T>
            </Row>
          </Card>

          <Row style={{ flexWrap: 'wrap' }} gap={space.md}>
            <StatTile
              testID="stations-online"
              label="Online"
              value={`${d.stations_online}/${d.stations_total}`}
              color={t.success}
              sub={d.stations_offline ? `${d.stations_offline} offline / degraded` : 'all stations up'}
            />
            <Card
              style={{ flex: 1, minWidth: 140 }}
              onPress={() => router.push('/alerts')}
              testID="alerts-tile"
              accessibilityLabel="Open alerts"
            >
              <T variant="label">Open alerts</T>
              <Row>
                <Badge testID="alerts-critical" label={`${d.open_alerts.critical} critical`} color={d.open_alerts.critical ? t.danger : t.textMuted} />
              </Row>
              <Row>
                <Badge label={`${d.open_alerts.warning} warning`} color={d.open_alerts.warning ? t.warning : t.textMuted} />
              </Row>
            </Card>
          </Row>

          <Section title="Sales by product">
            <Card>
              {d.by_product.length ? (
                <HBarChart
                  testID="by-product-chart"
                  data={d.by_product.map((p) => ({
                    key: p.product_code,
                    label: `${productLabel(p.product_code)} · ${formatLitres(p.sales_today_l)}`,
                    value: toNum(p.sales_today_amount) ?? 0,
                    display: formatZmw(p.sales_today_amount),
                    color: fuelColor(t, p.product_code),
                  }))}
                />
              ) : (
                <T variant="muted">No sales yet today.</T>
              )}
              {d.by_product.map((p) => {
                const pct = p.capacity_l ? (p.stock_l / p.capacity_l) * 100 : 0;
                return (
                  <View key={p.product_code} style={{ gap: 4 }}>
                    <Row style={{ justifyContent: 'space-between' }}>
                      <T variant="muted">{productLabel(p.product_code)} stock</T>
                      <T style={{ fontWeight: '700' }}>
                        {formatLitres(p.stock_l)} ({formatPct(pct)})
                      </T>
                    </Row>
                    <FillBar pct={pct} color={fuelColor(t, p.product_code)} />
                  </View>
                );
              })}
            </Card>
          </Section>

          <Section title="Low stock tanks">
            {d.low_stock_tanks.length === 0 ? (
              <Empty text="No tanks below the low-level threshold." />
            ) : (
              d.low_stock_tanks.map((tk) => (
                <Card
                  key={`${tk.station_id}-${tk.tank_no}`}
                  onPress={() => router.push(`/station/${tk.station_id}`)}
                  accessibilityLabel={`${tk.station_name} tank ${tk.tank_no}`}
                >
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T variant="h2" numberOfLines={1} style={{ flex: 1 }}>
                      {tk.station_name}
                    </T>
                    <T variant="h2" color={t.danger}>
                      {formatPct(tk.fill_pct)}
                    </T>
                  </Row>
                  <T variant="muted">
                    Tank {tk.tank_no} · {productLabel(tk.product_code)} · {formatLitres(tk.product_volume_l)} of{' '}
                    {formatLitres(tk.capacity_l)}
                  </T>
                  <FillBar pct={tk.fill_pct} color={t.danger} />
                </Card>
              ))
            )}
          </Section>
          <T variant="small" style={{ textAlign: 'center' }}>
            Updated {formatTimeHHMM(q.dataUpdatedAt)} · refreshes every 30 s
          </T>
        </>
      ) : null}
    </Screen>
  );
}
