import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface NotificationPrefs {
  critical_alerts: boolean;
  warning_alerts: boolean;
  low_stock: boolean;
  daily_summary: boolean;
}

export interface AppSettings {
  biometricEnabled: boolean;
  /** Has the user been offered biometric unlock after first login? */
  biometricOffered: boolean;
  theme: 'system' | 'light' | 'dark';
  notifications: NotificationPrefs;
  /** Dev-only API origin override ('' = build default). */
  apiUrlOverride: string;
  analyticsUrlOverride: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  biometricEnabled: false,
  biometricOffered: false,
  theme: 'system',
  notifications: { critical_alerts: true, warning_alerts: true, low_stock: true, daily_summary: false },
  apiUrlOverride: '',
  analyticsUrlOverride: '',
};

const KEY = 'fms.settings.v1';

interface Ctx {
  settings: AppSettings;
  loaded: boolean;
  update: (patch: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<Ctx>({ settings: DEFAULT_SETTINGS, loaded: true, update: () => {} });

export function SettingsProvider({ children, initial }: { children: React.ReactNode; initial?: Partial<AppSettings> }) {
  const [settings, setSettings] = useState<AppSettings>({ ...DEFAULT_SETTINGS, ...initial });
  const [loaded, setLoaded] = useState(!!initial);

  useEffect(() => {
    if (initial) return;
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        setSettings((s) => ({ ...s, ...parsed, notifications: { ...s.notifications, ...parsed.notifications } }));
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [initial]);

  const update = useCallback((patch: Partial<AppSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, loaded, update }), [settings, loaded, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
