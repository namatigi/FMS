import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import React from 'react';
import type { ColorValue } from 'react-native';
import { canEditPrices, useCurrentUser } from '../../../api/ApiContext';
import { useOverview } from '../../../api/queries';
import { font, useTheme } from '../../../theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];
const icon = (name: IconName) =>
  function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} color={color as string} size={size + 2} />;
  };

export default function TabsLayout() {
  const t = useTheme();
  const user = useCurrentUser();
  const overview = useOverview();
  const openAlerts = (overview.data?.open_alerts.critical ?? 0) + (overview.data?.open_alerts.warning ?? 0);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontWeight: '800', fontSize: font.xl },
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, height: 68, paddingBottom: 10, paddingTop: 6 },
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textMuted,
        tabBarLabelStyle: { fontSize: 13, fontWeight: '700' },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('speedometer') }} />
      <Tabs.Screen name="stations" options={{ title: 'Stations', tabBarIcon: icon('business') }} />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: icon('warning'),
          tabBarBadge: openAlerts > 0 ? openAlerts : undefined,
          tabBarBadgeStyle: { backgroundColor: t.danger, color: '#FFFFFF', fontWeight: '800' },
        }}
      />
      <Tabs.Screen
        name="prices"
        options={{ title: 'Prices', tabBarIcon: icon('pricetag'), href: canEditPrices(user) ? undefined : null }}
      />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
