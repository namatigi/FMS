import * as LocalAuthentication from 'expo-local-authentication';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiProvider } from '../api/ApiContext';
import { ApiClient, ApiError } from '../api/client';
import type { AuthResponse, User } from '../api/types';
import { DEFAULT_ANALYTICS_URL, DEFAULT_API_URL } from '../config';
import { useSettings } from '../settings/SettingsProvider';
import { KEYS, secureRefreshStore, secureStorage } from './secureStorage';

export type AuthStatus = 'loading' | 'signedOut' | 'locked' | 'signedIn';

interface AuthCtx {
  status: AuthStatus;
  user: User | null;
  /** True when restored without reaching the server (cached session, offline). */
  offlineSession: boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Biometric unlock of a stored session. Resolves false if cancelled/failed. */
  unlock: () => Promise<boolean>;
  /** Forget the stored session and show the password form. */
  switchToPassword: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export async function biometricAvailable(): Promise<boolean> {
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

export async function biometricPrompt(reason: string): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return r.success;
  } catch {
    return false;
  }
}

export function AuthProvider({ children, onSignedOut }: { children: React.ReactNode; onSignedOut?: () => void }) {
  const { settings, loaded } = useSettings();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [offlineSession, setOfflineSession] = useState(false);

  const urls = useRef({ api: DEFAULT_API_URL, analytics: DEFAULT_ANALYTICS_URL });
  urls.current = {
    api: settings.apiUrlOverride || DEFAULT_API_URL,
    analytics: settings.analyticsUrlOverride || settings.apiUrlOverride || DEFAULT_ANALYTICS_URL || DEFAULT_API_URL,
  };
  const onSignedOutRef = useRef(onSignedOut);
  onSignedOutRef.current = onSignedOut;

  const client = useMemo(
    () =>
      new ApiClient({
        getBaseUrl: () => urls.current.api,
        getAnalyticsUrl: () => urls.current.analytics,
        refreshStore: secureRefreshStore,
        onAuthResponse: (res: AuthResponse) => {
          setUser(res.user);
          secureStorage.set(KEYS.user, JSON.stringify(res.user)).catch(() => {});
        },
        onSessionExpired: () => {
          secureStorage.remove(KEYS.user);
          setUser(null);
          setStatus('signedOut');
          onSignedOutRef.current?.();
        },
      }),
    [],
  );

  /** Restore a stored session by refreshing; tolerate offline using the cached user. */
  const restore = useCallback(async (): Promise<boolean> => {
    try {
      await client.refresh();
      setOfflineSession(false);
      setStatus('signedIn');
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) {
        const cached = await secureStorage.get(KEYS.user);
        if (cached) {
          setUser(JSON.parse(cached) as User);
          setOfflineSession(true);
          setStatus('signedIn');
          return true;
        }
      }
      setStatus('signedOut');
      return false;
    }
  }, [client]);

  // Boot: wait for settings, then decide signedOut / locked / signedIn.
  const booted = useRef(false);
  useEffect(() => {
    if (!loaded || booted.current) return;
    booted.current = true;
    (async () => {
      const rt = await secureRefreshStore.get();
      if (!rt) return setStatus('signedOut');
      const cached = await secureStorage.get(KEYS.user);
      if (cached) setUser(JSON.parse(cached) as User);
      if (settings.biometricEnabled && (await biometricAvailable())) {
        setStatus('locked');
        return;
      }
      await restore();
    })();
  }, [loaded, settings.biometricEnabled, restore]);

  const login = useCallback(
    async (email: string, password: string, totpCode?: string) => {
      const res = await client.login(email.trim().toLowerCase(), password, totpCode);
      setOfflineSession(false);
      setStatus('signedIn');
      return res.user;
    },
    [client],
  );

  const logout = useCallback(async () => {
    await client.logout();
    await secureStorage.remove(KEYS.user);
    setUser(null);
    setStatus('signedOut');
    onSignedOutRef.current?.();
  }, [client]);

  const unlock = useCallback(async () => {
    const ok = await biometricPrompt('Unlock FMS');
    if (!ok) return false;
    return restore();
  }, [restore]);

  const switchToPassword = useCallback(async () => {
    await client.clearSession();
    await secureStorage.remove(KEYS.user);
    setUser(null);
    setStatus('signedOut');
    onSignedOutRef.current?.();
  }, [client]);

  const value = useMemo<AuthCtx>(
    () => ({ status, user, offlineSession, login, logout, unlock, switchToPassword }),
    [status, user, offlineSession, login, logout, unlock, switchToPassword],
  );

  return (
    <Ctx.Provider value={value}>
      <ApiProvider client={client} user={status === 'signedIn' ? user : null}>
        {children}
      </ApiProvider>
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}
