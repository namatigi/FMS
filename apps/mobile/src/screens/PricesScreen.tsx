import React, { useEffect, useMemo, useState } from 'react';
import { Alert as RNAlert, Pressable, ScrollView } from 'react-native';
import { canEditPrices, useCurrentUser } from '../api/ApiContext';
import { errorMessage } from '../api/client';
import { capFor, useErbCaps, useStation, useStations, useUpdatePrices } from '../api/queries';
import type { FuelGrade, PriceUpdateResponse } from '../api/types';
import { Badge, Button, Card, Empty, ErrorBox, Field, KV, Loading, OfflineBanner, Row, Screen, Section, T, useIsOnline } from '../components/ui';
import { formatDateTime, formatZmw, productLabel, toNum } from '../lib/format';
import { font, radius, space, TAP, useTheme } from '../theme';

/** Validate a typed price. Returns an error message or null. */
export function validatePrice(raw: string, cap: number | null): string | null {
  const s = raw.trim();
  if (!s) return 'Enter a price';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 'Use a number with up to 2 decimals, e.g. 31.85';
  const n = Number(s);
  if (n <= 0) return 'Price must be greater than zero';
  if (cap !== null && n > cap) return `Above ERB cap of ${formatZmw(cap)}`;
  return null;
}

export default function PricesScreen() {
  const user = useCurrentUser();
  const t = useTheme();
  const stations = useStations('');
  const [stationId, setStationId] = useState<string | null>(null);
  useEffect(() => {
    if (!stationId && stations.data?.length) setStationId(stations.data[0].id);
  }, [stations.data, stationId]);

  if (!canEditPrices(user)) {
    return (
      <Screen>
        <Empty text="Only station owners can change prices." />
      </Screen>
    );
  }

  return (
    <Screen refreshing={stations.isRefetching} onRefresh={() => stations.refetch()}>
      <OfflineBanner updatedAt={stations.dataUpdatedAt || undefined} failed={stations.isError && !!stations.data} />
      {stations.isPending ? <Loading /> : null}
      {stations.isError && !stations.data ? <ErrorBox error={stations.error} onRetry={() => stations.refetch()} /> : null}
      {stations.data?.length ? (
        <Section title="Station">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
            {stations.data.map((s) => {
              const sel = s.id === stationId;
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: sel }}
                  onPress={() => setStationId(s.id)}
                  style={{
                    minHeight: TAP,
                    paddingHorizontal: space.lg,
                    justifyContent: 'center',
                    borderRadius: radius.md,
                    borderWidth: 2,
                    borderColor: sel ? t.primary : t.border,
                    backgroundColor: sel ? t.primary : t.surface,
                  }}
                >
                  <T style={{ fontWeight: '800', fontSize: font.md }} color={sel ? t.primaryText : t.text}>
                    {s.name}
                  </T>
                </Pressable>
              );
            })}
          </ScrollView>
        </Section>
      ) : null}
      {stationId ? <StationPrices key={stationId} stationId={stationId} /> : null}
    </Screen>
  );
}

function StationPrices({ stationId }: { stationId: string }) {
  const t = useTheme();
  const online = useIsOnline();
  const station = useStation(stationId);
  const caps = useErbCaps();
  const update = useUpdatePrices(stationId);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PriceUpdateResponse | null>(null);

  const grades: FuelGrade[] = useMemo(
    () => [...(station.data?.fuel_grades ?? [])].sort((a, b) => a.pts_grade_id - b.pts_grade_id),
    [station.data],
  );
  const capOf = (g: FuelGrade): number | null =>
    toNum(g.erb_cap) ?? capFor(caps.data ?? [], g.product_code, station.data?.province_id);

  const changes = grades
    .filter((g) => draft[g.pts_grade_id] !== undefined && draft[g.pts_grade_id].trim() !== '')
    .filter((g) => Number(draft[g.pts_grade_id]) !== Number(g.price));
  const errors = Object.fromEntries(
    grades.map((g) => [g.pts_grade_id, draft[g.pts_grade_id] ? validatePrice(draft[g.pts_grade_id], capOf(g)) : null]),
  ) as Record<number, string | null>;
  const hasErrors = changes.some((g) => errors[g.pts_grade_id]);

  const submit = () => {
    const body = { prices: changes.map((g) => ({ pts_grade_id: g.pts_grade_id, price: Number(draft[g.pts_grade_id]) })) };
    const summary = changes
      .map((g) => `${g.name}: ${formatZmw(g.price)} → ${formatZmw(Number(draft[g.pts_grade_id]))}`)
      .join('\n');
    RNAlert.alert(
      'Change pump prices?',
      `${station.data?.name}\n\n${summary}\n\nThe new prices are sent to the station controller and apply to the next sale.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Change prices',
          style: 'destructive',
          onPress: () => {
            setServerError(null);
            setSaved(null);
            update.mutate(body, {
              onSuccess: (res) => {
                setDraft({});
                setSaved(res ?? ({} as PriceUpdateResponse));
              },
              onError: (e) => setServerError(errorMessage(e)),
            });
          },
        },
      ],
    );
  };

  if (station.isPending) return <Loading />;
  if (station.isError && !station.data) return <ErrorBox error={station.error} onRetry={() => station.refetch()} />;
  if (!grades.length) return <Empty text="No fuel grades configured for this station." />;

  return (
    <Section title="Current prices (ZMW / litre)">
      {grades.map((g) => {
        const cap = capOf(g);
        const price = toNum(g.price) ?? 0;
        const over = cap !== null && price > cap;
        return (
          <Card key={g.pts_grade_id} testID={`grade-${g.pts_grade_id}`}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="h2">{g.name}</T>
              {over ? <Badge label="ABOVE CAP" color={t.danger} /> : null}
            </Row>
            <T variant="muted">{productLabel(g.product_code)} · grade {g.pts_grade_id}</T>
            <KV k="Current price" v={formatZmw(price)} />
            <KV k="ERB cap" v={cap !== null ? formatZmw(cap) : 'not available (checked on save)'} />
            {cap !== null ? (
              <KV k="Headroom" v={formatZmw(cap - price)} vColor={over ? t.danger : t.success} />
            ) : null}
            <Field
              label="New price"
              placeholder={price.toFixed(2)}
              keyboardType="decimal-pad"
              value={draft[g.pts_grade_id] ?? ''}
              onChangeText={(v) => {
                setSaved(null);
                setDraft((d) => ({ ...d, [g.pts_grade_id]: v.replace(',', '.') }));
              }}
              error={errors[g.pts_grade_id]}
            />
          </Card>
        );
      })}
      {serverError ? (
        <Card style={{ borderColor: t.danger, borderWidth: 2 }} testID="price-error">
          <T variant="h2" color={t.danger}>Price change rejected</T>
          <T>{serverError}</T>
        </Card>
      ) : null}
      {saved ? (
        <Card style={{ borderColor: t.success, borderWidth: 2 }}>
          <T variant="h2" color={t.success}>Prices queued for the station</T>
          <T variant="muted">
            Effective {saved.effective_at ? formatDateTime(saved.effective_at) : 'immediately'}. The controller applies them when it next connects
            {saved.command_id ? ` (command ${saved.command_id})` : ''}.
          </T>
        </Card>
      ) : null}
      <Button
        title={changes.length ? `Review ${changes.length} change${changes.length > 1 ? 's' : ''}` : 'No changes'}
        onPress={submit}
        disabled={!changes.length || hasErrors || !online}
        loading={update.isPending}
      />
      {!online ? <T variant="muted">Price changes need a connection.</T> : null}
    </Section>
  );
}
