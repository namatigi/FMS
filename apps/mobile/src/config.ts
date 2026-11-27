import Constants from 'expo-constants';

type Extra = { apiUrl?: string; analyticsUrl?: string; eas?: { projectId?: string } };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

/**
 * API origin. Priority: EXPO_PUBLIC_API_URL (inlined at build time) > app.config extra.apiUrl > localhost.
 * Paths /api/v1 and /analytics/v1 are appended by the client (same origin behind the reverse proxy).
 */
export const DEFAULT_API_URL: string =
  process.env.EXPO_PUBLIC_API_URL || extra.apiUrl || 'http://localhost:8080';

/** Optional separate analytics origin (dev without proxy: http://<host>:8090). Empty = same as API. */
export const DEFAULT_ANALYTICS_URL: string = process.env.EXPO_PUBLIC_ANALYTICS_URL || extra.analyticsUrl || '';

export const EAS_PROJECT_ID: string | undefined = extra.eas?.projectId;

/** Presets offered in Settings > API environment (dev builds only). */
export const API_ENVIRONMENTS: { key: string; label: string; url: string; analyticsUrl?: string }[] = [
  { key: 'default', label: 'Build default', url: DEFAULT_API_URL, analyticsUrl: DEFAULT_ANALYTICS_URL },
  { key: 'localhost', label: 'Localhost (iOS sim / web)', url: 'http://localhost:8080', analyticsUrl: 'http://localhost:8090' },
  { key: 'android-emu', label: 'Android emulator host', url: 'http://10.0.2.2:8080', analyticsUrl: 'http://10.0.2.2:8090' },
];

export const AUTO_REFRESH_MS = 30_000;
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const APP_VERSION: string = Constants.expoConfig?.version ?? '0.0.0';
