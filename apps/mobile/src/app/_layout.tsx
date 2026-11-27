import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createQueryClient, persister, wireQueryEnvironment } from '../api/queryClient';
import { AuthProvider } from '../auth/AuthProvider';
import { APP_VERSION, CACHE_MAX_AGE_MS } from '../config';
import { configureForegroundHandler } from '../notifications/push';
import { SettingsProvider } from '../settings/SettingsProvider';
import { useTheme } from '../theme';

wireQueryEnvironment();
configureForegroundHandler();

function ThemedStack() {
  const t = useTheme();
  return (
    <>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="login" />
        <Stack.Screen name="(app)" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(createQueryClient);
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{ persister, maxAge: CACHE_MAX_AGE_MS, buster: APP_VERSION }}
        >
          <AuthProvider
            onSignedOut={() => {
              queryClient.clear();
              persister.removeClient();
            }}
          >
            <ThemedStack />
          </AuthProvider>
        </PersistQueryClientProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
