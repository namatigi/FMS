import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { ApiClient } from '../api/client';
import { EAS_PROJECT_ID } from '../config';
import type { NotificationPrefs } from '../settings/SettingsProvider';

/**
 * Push registration.
 *
 * PROPOSED CONTRACT ADDITIONS (core-api, not yet in docs/api/CONTRACTS.md):
 *   POST /api/v1/me/devices                  {platform: 'ios'|'android', token}   -> 204
 *        token is an Expo push token ("ExponentPushToken[...]") when an EAS projectId is configured,
 *        otherwise the raw FCM/APNs device token. Idempotent upsert per (user, token).
 *   DELETE /api/v1/me/devices/:token                                              -> 204 (on logout)
 *   PUT /api/v1/me/notification-preferences  {critical_alerts, warning_alerts, low_stock, daily_summary}
 * Push payload `data` from fiscal-worker notify jobs: {type:'alert', alert_id, station_id, severity}.
 */

export function configureForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

export async function getPushToken(): Promise<{ platform: 'ios' | 'android'; token: string } | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alerts', {
      name: 'Station alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }
  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain) {
    granted = (await Notifications.requestPermissionsAsync()).granted;
  }
  if (!granted) return null;
  const token = EAS_PROJECT_ID
    ? (await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })).data
    : String((await Notifications.getDevicePushTokenAsync()).data);
  return { platform: Platform.OS === 'ios' ? 'ios' : 'android', token };
}

let lastToken: string | null = null;

/** Register this device with core-api. Never throws (endpoint is a proposed addition). */
export async function registerForPush(api: ApiClient): Promise<string | null> {
  try {
    const t = await getPushToken();
    if (!t) return null;
    lastToken = t.token;
    await api.request('/me/devices', { method: 'POST', body: { platform: t.platform, token: t.token } });
    return t.token;
  } catch {
    return lastToken;
  }
}

export async function unregisterPush(api: ApiClient): Promise<void> {
  if (!lastToken) return;
  try {
    await api.request(`/me/devices/${encodeURIComponent(lastToken)}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

export async function syncNotificationPrefs(api: ApiClient, prefs: NotificationPrefs): Promise<boolean> {
  try {
    await api.request('/me/notification-preferences', { method: 'PUT', body: prefs });
    return true;
  } catch {
    return false;
  }
}

/** Extract the alert id from a tapped notification. */
export function alertIdFromNotification(n: Notifications.Notification): string | null {
  const data = (n.request.content.data ?? {}) as Record<string, unknown>;
  const id = data.alert_id ?? data.alertId;
  return id != null ? String(id) : null;
}
