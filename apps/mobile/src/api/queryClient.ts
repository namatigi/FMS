import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { AppState, Platform } from 'react-native';
import { CACHE_MAX_AGE_MS } from '../config';
import { ApiError } from './client';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: CACHE_MAX_AGE_MS, // must be >= persist maxAge
        networkMode: 'offlineFirst',
        retry: (count, err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { networkMode: 'online', retry: false },
    },
  });
}

export const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'fms.query-cache.v1',
  throttleTime: 1000,
});

let wired = false;
/** Connect TanStack Query to NetInfo (online/offline) and AppState (refetch on foreground). */
export function wireQueryEnvironment(): void {
  if (wired) return;
  wired = true;
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    }),
  );
  if (Platform.OS !== 'web') {
    AppState.addEventListener('change', (s) => focusManager.setFocused(s === 'active'));
  }
}
