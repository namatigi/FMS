import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Alert as RNAlert, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../api/client';
import { useAckAlert, useAlerts } from '../api/queries';
import type { Alert } from '../api/types';
import { Badge, Button, Card, Empty, ErrorBox, KV, Loading, OfflineBanner, Row, Screen, T } from '../components/ui';
import { formatDateTime, formatRelative, humanizeCode } from '../lib/format';
import { font, radius, severityColor, space, TAP, useTheme } from '../theme';

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function sortAlerts(list: Alert[]): Alert[] {
  return [...list].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
      new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
  );
}

function AlertRow({ a, onPress }: { a: Alert; onPress: () => void }) {
  const t = useTheme();
  const color = severityColor(t, a.severity);
  return (
    <Card onPress={onPress} style={{ borderLeftWidth: 8, borderLeftColor: color }} accessibilityLabel={`${a.severity} ${a.code}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2" style={{ flex: 1 }} numberOfLines={1}>
          {humanizeCode(a.code)}
        </T>
        <Badge label={a.severity.toUpperCase()} color={color} />
      </Row>
      <T variant="muted" numberOfLines={2}>
        {a.station_name ?? a.station_code ?? 'Station'} · {a.device_type}
        {a.device_no != null ? ` ${a.device_no}` : ''} · {formatRelative(a.occurred_at)}
      </T>
      {a.message ? <T numberOfLines={2}>{a.message}</T> : null}
      {a.acknowledged_at ? <T variant="small">Acknowledged {formatRelative(a.acknowledged_at)}</T> : null}
    </Card>
  );
}

export default function AlertsScreen() {
  const t = useTheme();
  const router = useRouter();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const q = useAlerts(status);
  const data = useMemo(() => sortAlerts(q.data ?? []), [q.data]);

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={data}
        keyExtractor={(a) => String(a.id)}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={t.primary} />}
        ListHeaderComponent={
          <View style={{ gap: space.md }}>
            <Row gap={0} style={{ borderRadius: radius.md, overflow: 'hidden', borderWidth: 2, borderColor: t.border }}>
              {(['open', 'all'] as const).map((s) => (
                <Pressable
                  key={s}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: status === s }}
                  onPress={() => setStatus(s)}
                  style={{ flex: 1, minHeight: TAP, alignItems: 'center', justifyContent: 'center', backgroundColor: status === s ? t.primary : t.surface }}
                >
                  <T style={{ fontWeight: '800', fontSize: font.md }} color={status === s ? t.primaryText : t.text}>
                    {s === 'open' ? 'Open' : 'All'}
                  </T>
                </Pressable>
              ))}
            </Row>
            <OfflineBanner updatedAt={q.dataUpdatedAt || undefined} failed={q.isError && !!q.data} />
            {q.isPending ? <Loading /> : null}
            {q.isError && !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
          </View>
        }
        ListEmptyComponent={q.isSuccess ? <Empty text={status === 'open' ? 'No open alerts. All clear.' : 'No alerts.'} /> : undefined}
        renderItem={({ item }) => <AlertRow a={item} onPress={() => router.push(`/alert/${item.id}`)} />}
      />
    </SafeAreaView>
  );
}

/** Find an alert in any cached alerts list (the contract has no GET /alerts/:id). */
function useCachedAlert(id: string): Alert | undefined {
  const qc = useQueryClient();
  const all = useAlerts('all'); // ensures we eventually have it even on cold start / deep link
  const fromCache = qc
    .getQueriesData<Alert[]>({ queryKey: ['alerts'] })
    .flatMap(([, d]) => d ?? [])
    .filter((a) => String(a.id) === id);
  // Prefer the freshest acknowledged state
  return (all.data ?? []).find((a) => String(a.id) === id) ?? fromCache.find((a) => a.acknowledged_at) ?? fromCache[0];
}

export function AlertDetailScreen({ id }: { id: string }) {
  const t = useTheme();
  const router = useRouter();
  const alert = useCachedAlert(id);
  const ack = useAckAlert();

  if (!alert) return <Screen><Loading label="Loading alert…" /></Screen>;
  const color = severityColor(t, alert.severity);
  const acknowledged = !!alert.acknowledged_at || ack.isSuccess;

  const onAck = () => {
    RNAlert.alert('Acknowledge alert?', `${humanizeCode(alert.code)} at ${alert.station_name ?? 'station'}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Acknowledge',
        onPress: () =>
          ack.mutate(alert.id, {
            onError: (e) => RNAlert.alert('Could not acknowledge', errorMessage(e)),
          }),
      },
    ]);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: humanizeCode(alert.code) }} />
      <OfflineBanner />
      <Card style={{ borderLeftWidth: 10, borderLeftColor: color }}>
        <Badge label={alert.severity.toUpperCase()} color={color} />
        <T variant="title">{humanizeCode(alert.code)}</T>
        {alert.message ? <T>{alert.message}</T> : null}
        <KV k="Station" v={alert.station_name ?? alert.station_code ?? alert.station_id} />
        <KV k="Device" v={`${alert.device_type}${alert.device_no != null ? ` ${alert.device_no}` : ''}`} />
        <KV k="Occurred" v={formatDateTime(alert.occurred_at)} />
        <KV k="Status" v={acknowledged ? `Acknowledged ${formatRelative(alert.acknowledged_at ?? new Date())}` : 'Open'} vColor={acknowledged ? t.success : color} />
      </Card>
      {alert.data && Object.keys(alert.data).length ? (
        <Card>
          <T variant="label">Details</T>
          {Object.entries(alert.data).map(([k, v]) => (
            <KV key={k} k={k} v={typeof v === 'object' ? JSON.stringify(v) : String(v)} />
          ))}
        </Card>
      ) : null}
      {!acknowledged ? <Button testID="ack-button" title="Acknowledge" onPress={onAck} loading={ack.isPending} /> : null}
      <Button title="Open station" variant="secondary" onPress={() => router.push(`/station/${alert.station_id}`)} />
    </Screen>
  );
}
