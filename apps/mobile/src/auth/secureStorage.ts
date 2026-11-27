import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { RefreshTokenStore } from '../api/client';

/** Keychain/Keystore on device; AsyncStorage fallback on web (dev only). */
const useSecure = Platform.OS !== 'web';

export const secureStorage = {
  async get(key: string): Promise<string | null> {
    try {
      return useSecure ? await SecureStore.getItemAsync(key) : await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (useSecure) await SecureStore.setItemAsync(key, value);
    else await AsyncStorage.setItem(key, value);
  },
  async remove(key: string): Promise<void> {
    try {
      if (useSecure) await SecureStore.deleteItemAsync(key);
      else await AsyncStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

export const KEYS = {
  refreshToken: 'fms.refresh_token',
  user: 'fms.user',
} as const;

export const secureRefreshStore: RefreshTokenStore = {
  get: () => secureStorage.get(KEYS.refreshToken),
  set: (t) => secureStorage.set(KEYS.refreshToken, t),
  clear: () => secureStorage.remove(KEYS.refreshToken),
};
