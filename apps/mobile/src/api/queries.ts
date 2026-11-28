import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTO_REFRESH_MS } from '../config';
import { lusakaDayRange } from '../lib/format';
import { useApi } from './ApiContext';
import { ApiError } from './client';
import type {
  Alert,
  DashboardOverview,
  Delivery,
  ErbCapPrice,
  ListResponse,
  PriceUpdateRequest,
  PriceUpdateResponse,
  Pump,
  SalesSummaryRow,
  Station,
  StationDetail,
  StockoutRow,
  Tank,
  Transaction,
  User,
} from './types';

export const qk = {
  overview: ['overview'] as const,
  me: ['me'] as const,
  stations: (q: string) => ['stations', q] as const,
  station: (id: string) => ['station', id] as const,
  tanks: (id: string) => ['station', id, 'tanks'] as const,
  pumps: (id: string) => ['station', id, 'pumps'] as const,
  transactions: (id: string, day: string) => ['station', id, 'transactions', day] as const,
  sales: (id: string, group: string, day: string) => ['station', id, 'sales', group, day] as const,
  deliveries: (id: string) => ['station', id, 'deliveries'] as const,
  stockout: (id: string) => ['station', id, 'stockout'] as const,
  alerts: (status: 'open' | 'all', stationId?: string) => ['alerts', status, stationId ?? 'any'] as const,
  erbCaps: ['erb-caps'] as const,
};

/** Accept either a bare array or a {items} envelope. */
export function unwrapList<T>(r: T[] | ListResponse<T> | null | undefined): T[] {
  if (!r) return [];
  return Array.isArray(r) ? r : (r.items ?? []);
}

export function useOverview() {
  const api = useApi();
  return useQuery({
    queryKey: qk.overview,
    queryFn: () => api.get<DashboardOverview>('/dashboard/overview'),
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function useMe(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.me, queryFn: () => api.get<User>('/me'), enabled });
}

export function useStations(q = '') {
  const api = useApi();
  return useQuery({
    queryKey: qk.stations(q),
    queryFn: async () => unwrapList(await api.get<ListResponse<Station> | Station[]>('/stations', { q })),
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function useStation(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.station(id),
    queryFn: () => api.get<StationDetail>(`/stations/${id}`),
    enabled: !!id,
  });
}

export function useTanks(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.tanks(id),
    queryFn: async () => unwrapList(await api.get<Tank[] | ListResponse<Tank>>(`/stations/${id}/tanks`)),
    enabled: !!id,
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function usePumps(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.pumps(id),
    queryFn: async () => unwrapList(await api.get<Pump[] | ListResponse<Pump>>(`/stations/${id}/pumps`)),
    enabled: !!id,
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function useTodayTransactions(id: string, limit = 25) {
  const api = useApi();
  const { from, to, date } = lusakaDayRange();
  return useQuery({
    queryKey: qk.transactions(id, date),
    queryFn: async () =>
      unwrapList(await api.get<ListResponse<Transaction>>(`/stations/${id}/transactions`, { from, to, limit })),
    enabled: !!id,
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function useTodaySales(id: string, group: 'product' | 'pump') {
  const api = useApi();
  const { from, to, date } = lusakaDayRange();
  return useQuery({
    queryKey: qk.sales(id, group, date),
    queryFn: async () =>
      unwrapList(
        await api.get<SalesSummaryRow[] | ListResponse<SalesSummaryRow>>(`/stations/${id}/sales/summary`, {
          from,
          to,
          group,
        }),
      ),
    enabled: !!id,
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function useDeliveries(id: string, days = 14) {
  const api = useApi();
  return useQuery({
    queryKey: qk.deliveries(id),
    queryFn: async () => {
      const from = new Date(Date.now() - days * 86400_000).toISOString();
      return unwrapList(await api.get<Delivery[] | ListResponse<Delivery>>(`/stations/${id}/deliveries`, { from }));
    },
    enabled: !!id,
  });
}

export function useStockout(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.stockout(id),
    queryFn: async () =>
      unwrapList(
        await api.get<StockoutRow[] | ListResponse<StockoutRow>>('/forecast/stockout', { station_id: id }, {
          service: 'analytics',
        }),
      ),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
}

export function useAlerts(status: 'open' | 'all' = 'open', stationId?: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.alerts(status, stationId),
    queryFn: async () =>
      unwrapList(await api.get<ListResponse<Alert> | Alert[]>('/alerts', { status, station_id: stationId })),
    refetchInterval: AUTO_REFRESH_MS,
  });
}

export function useAckAlert() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: Alert['id']) => api.request<unknown>(`/alerts/${id}/ack`, { method: 'POST' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const now = new Date().toISOString();
      const snapshots = qc.getQueriesData<Alert[]>({ queryKey: ['alerts'] });
      for (const [key, data] of snapshots) {
        if (!data) continue;
        const isOpenList = key[1] === 'open';
        qc.setQueryData<Alert[]>(
          key,
          isOpenList
            ? data.filter((a) => String(a.id) !== String(id))
            : data.map((a) => (String(a.id) === String(id) ? { ...a, acknowledged_at: now } : a)),
        );
      }
      return { snapshots };
    },
    onError: (_e, _id, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: qk.overview });
    },
  });
}

/**
 * ERB caps. The contract only exposes them at /regulator/prices (regulator/admin roles), so for
 * owners this resolves to [] on 403/404 and the UI falls back to `fuel_grades[].erb_cap` (proposed)
 * or server-side validation on save.
 */
export function useErbCaps() {
  const api = useApi();
  return useQuery({
    queryKey: qk.erbCaps,
    queryFn: async () => {
      try {
        return unwrapList(await api.get<ErbCapPrice[] | ListResponse<ErbCapPrice>>('/regulator/prices'));
      } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return [] as ErbCapPrice[];
        throw e;
      }
    },
    staleTime: 60 * 60_000,
    retry: false,
  });
}

/** Most specific cap: province-level beats national (province_id null). */
export function capFor(caps: ErbCapPrice[], product: string, provinceId: number | null | undefined): number | null {
  const matching = caps.filter((c) => c.product_code === product);
  const prov = matching.find((c) => provinceId != null && c.province_id === provinceId);
  const nat = matching.find((c) => c.province_id == null);
  const pick = prov ?? nat;
  return pick ? Number(pick.price) : null;
}

export function useUpdatePrices(stationId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PriceUpdateRequest) =>
      api.request<PriceUpdateResponse>(`/stations/${stationId}/prices`, { method: 'PUT', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.station(stationId) });
    },
  });
}

/** Proposed contract addition: POST /api/v1/me/devices. Best effort. */
export async function registerDevice(api: ReturnType<typeof useApi>, platform: string, token: string) {
  return api.request('/me/devices', { method: 'POST', body: { platform, token } });
}
