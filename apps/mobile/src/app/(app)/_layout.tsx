import * as Notifications from 'expo-notifications';
import { Redirect, Stack, useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { useApi } from '../../api/ApiContext';
import { useAuth } from '../../auth/AuthProvider';
import { Loading, Screen } from '../../components/ui';
import { alertIdFromNotification, registerForPush } from '../../notifications/push';
import { font, useTheme } from '../../theme';

export default function AppLayout() {
  const { status } = useAuth();
  const api = useApi();
  const router = useRouter();
  const t = useTheme();

  useEffect(() => {
    if (status !== 'signedIn') return;
    registerForPush(api);
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const id = alertIdFromNotification(resp.notification);
      if (id) router.push(`/alert/${id}`);
    });
    return () => sub.remove();
  }, [status, api, router]);

  if (status === 'loading') return <Screen><Loading /></Screen>;
  if (status !== 'signedIn') return <Redirect href="/login" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontWeight: '800', fontSize: font.lg },
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="station/[id]" options={{ title: 'Station' }} />
      <Stack.Screen name="alert/[id]" options={{ title: 'Alert' }} />
    </Stack>
  );
}
