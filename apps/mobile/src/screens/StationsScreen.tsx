import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useStations } from '../api/queries';
import { Card, Dot, Empty, ErrorBox, Field, Loading, OfflineBanner, Row, T } from '../components/ui';
import { formatRelative } from '../lib/format';
import { connectivityColor, space, useTheme } from '../theme';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export default function StationsScreen() {
  const t = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const q = useStations(useDebounced(search.trim(), 300));

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={q.data ?? []}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={t.primary} />}
        ListHeaderComponent={
          <View style={{ gap: space.md }}>
            <Field
              label="Search stations"
              placeholder="Name, code or town"
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
            <OfflineBanner updatedAt={q.dataUpdatedAt || undefined} failed={q.isError && !!q.data} />
            {q.isPending ? <Loading /> : null}
            {q.isError && !q.data ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
          </View>
        }
        ListEmptyComponent={q.isSuccess ? <Empty text={search ? 'No stations match your search.' : 'No stations assigned to you.'} /> : undefined}
        renderItem={({ item: s }) => (
          <Card onPress={() => router.push(`/station/${s.id}`)} accessibilityLabel={`${s.name}, ${s.connectivity}`} testID={`station-${s.code}`}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row style={{ flex: 1 }}>
                <Dot color={connectivityColor(t, s.connectivity)} size={14} label={s.connectivity} />
                <T variant="h2" numberOfLines={1} style={{ flex: 1 }}>
                  {s.name}
                </T>
              </Row>
              <T variant="muted">{s.code}</T>
            </Row>
            <T variant="muted">
              {[s.town, s.province_name].filter(Boolean).join(', ')} · {s.connectivity} · seen {formatRelative(s.controller_last_seen_at)}
            </T>
          </Card>
        )}
      />
    </SafeAreaView>
  );
}
