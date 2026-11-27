import React, { useEffect, useState } from 'react';
import { Alert as RNAlert, Pressable, Switch, View } from 'react-native';
import { useApi } from '../api/ApiContext';
import { useMe } from '../api/queries';
import { biometricAvailable, biometricPrompt, useAuth } from '../auth/AuthProvider';
import { Button, Card, Field, KV, Row, Screen, Section, T } from '../components/ui';
import { API_ENVIRONMENTS, APP_VERSION, DEFAULT_API_URL } from '../config';
import { syncNotificationPrefs, unregisterPush } from '../notifications/push';
import { useSettings, type NotificationPrefs } from '../settings/SettingsProvider';
import { font, radius, space, TAP, useTheme } from '../theme';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Station manager',
  platform_admin: 'Platform admin',
  erb_national: 'ERB (national)',
  erb_provincial: 'ERB (provincial)',
  zra_auditor: 'ZRA auditor',
};

function ToggleRow({ label, sub, value, onChange, testID }: {
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testID?: string;
}) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: TAP }}>
      <View style={{ flex: 1, paddingRight: space.md }}>
        <T style={{ fontWeight: '700' }}>{label}</T>
        {sub ? <T variant="small">{sub}</T> : null}
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ true: t.primary, false: t.border }}
      />
    </Row>
  );
}

export default function SettingsScreen() {
  const t = useTheme();
  const api = useApi();
  const { user, logout } = useAuth();
  const me = useMe();
  const { settings, update } = useSettings();
  const [bioAvailable, setBioAvailable] = useState(false);
  const [apiUrl, setApiUrl] = useState(settings.apiUrlOverride);
  const [analyticsUrl, setAnalyticsUrl] = useState(settings.analyticsUrlOverride);
  const profile = me.data ?? user;

  useEffect(() => {
    biometricAvailable().then(setBioAvailable);
  }, []);

  const toggleBiometric = async (v: boolean) => {
    if (v) {
      const ok = await biometricPrompt('Confirm to enable biometric unlock');
      if (!ok) return;
    }
    update({ biometricEnabled: v, biometricOffered: true });
  };

  const setPref = (k: keyof NotificationPrefs, v: boolean) => {
    const next = { ...settings.notifications, [k]: v };
    update({ notifications: next });
    syncNotificationPrefs(api, next);
  };

  const applyEnv = (url: string, analytics: string) => {
    RNAlert.alert('Switch API environment?', `${url || DEFAULT_API_URL}\n\nYou will be signed out.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Switch',
        style: 'destructive',
        onPress: async () => {
          await unregisterPush(api);
          await logout();
          update({ apiUrlOverride: url, analyticsUrlOverride: analytics });
        },
      },
    ]);
  };

  const onLogout = () =>
    RNAlert.alert('Sign out?', 'Cached data on this device will be cleared.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await unregisterPush(api);
          await logout();
        },
      },
    ]);

  return (
    <Screen>
      <Section title="Profile">
        <Card>
          <T variant="h2">{profile?.full_name ?? '—'}</T>
          <KV k="Email" v={profile?.email ?? '—'} />
          <KV k="Role" v={ROLE_LABEL[profile?.role ?? ''] ?? profile?.role ?? '—'} />
        </Card>
      </Section>

      <Section title="Notifications">
        <Card>
          <ToggleRow label="Critical alerts" sub="Leaks, totaliser mismatch, station offline" value={settings.notifications.critical_alerts} onChange={(v) => setPref('critical_alerts', v)} />
          <ToggleRow label="Warning alerts" value={settings.notifications.warning_alerts} onChange={(v) => setPref('warning_alerts', v)} />
          <ToggleRow label="Low stock" sub="Tank below low-level threshold" value={settings.notifications.low_stock} onChange={(v) => setPref('low_stock', v)} />
          <ToggleRow label="Daily summary" value={settings.notifications.daily_summary} onChange={(v) => setPref('daily_summary', v)} />
        </Card>
      </Section>

      <Section title="Security">
        <Card>
          <ToggleRow
            testID="biometric-toggle"
            label="Biometric unlock"
            sub={bioAvailable ? 'Use fingerprint / Face ID to open the app' : 'Not available on this device'}
            value={settings.biometricEnabled}
            onChange={toggleBiometric}
          />
        </Card>
      </Section>

      <Section title="Appearance">
        <Row gap={0} style={{ borderRadius: radius.md, overflow: 'hidden', borderWidth: 2, borderColor: t.border }}>
          {(['system', 'light', 'dark'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityState={{ selected: settings.theme === m }}
              onPress={() => update({ theme: m })}
              style={{ flex: 1, minHeight: TAP, alignItems: 'center', justifyContent: 'center', backgroundColor: settings.theme === m ? t.primary : t.surface }}
            >
              <T style={{ fontWeight: '800', fontSize: font.md }} color={settings.theme === m ? t.primaryText : t.text}>
                {m === 'system' ? 'Auto' : m === 'light' ? 'Light (sun)' : 'Dark'}
              </T>
            </Pressable>
          ))}
        </Row>
      </Section>

      {__DEV__ ? (
        <Section title="API environment (dev only)">
          <Card>
            <KV k="Current" v={settings.apiUrlOverride || DEFAULT_API_URL} />
            {API_ENVIRONMENTS.map((e) => (
              <Button key={e.key} variant="secondary" title={`${e.label}`} onPress={() => applyEnv(e.key === 'default' ? '' : e.url, e.key === 'default' ? '' : e.analyticsUrl ?? '')} />
            ))}
            <Field label="Custom API origin" value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" autoCorrect={false} placeholder="http://192.168.1.10:8080" keyboardType="url" />
            <Field label="Analytics origin (optional)" value={analyticsUrl} onChangeText={setAnalyticsUrl} autoCapitalize="none" autoCorrect={false} placeholder="http://192.168.1.10:8090" keyboardType="url" />
            <Button title="Use custom" onPress={() => applyEnv(apiUrl.trim(), analyticsUrl.trim())} disabled={!apiUrl.trim()} />
          </Card>
        </Section>
      ) : null}

      <Button title="Sign out" variant="danger" onPress={onLogout} testID="logout" />
      <T variant="small" style={{ textAlign: 'center' }}>FMS mobile v{APP_VERSION}</T>
    </Screen>
  );
}
