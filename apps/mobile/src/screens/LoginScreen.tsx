import React, { useState } from 'react';
import { Alert as RNAlert, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, errorMessage } from '../api/client';
import { biometricAvailable, biometricPrompt, useAuth } from '../auth/AuthProvider';
import { Button, Card, Field, T } from '../components/ui';
import { useSettings } from '../settings/SettingsProvider';
import { space, useTheme } from '../theme';

export default function LoginScreen() {
  const t = useTheme();
  const { status, user, login, unlock, switchToPassword } = useAuth();
  const { settings, update } = useSettings();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [totp, setTotp] = useState('');

  const offerBiometric = async () => {
    if (settings.biometricOffered || !(await biometricAvailable())) return;
    update({ biometricOffered: true });
    RNAlert.alert('Use biometric unlock?', 'Next time, open the app with your fingerprint or face instead of your password.', [
      { text: 'Not now', style: 'cancel' },
      {
        text: 'Enable',
        onPress: async () => {
          if (await biometricPrompt('Confirm to enable biometric unlock')) update({ biometricEnabled: true });
        },
      },
    ]);
  };

  const onSubmit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (mfa && !/^d{6}$/.test(totp.trim())) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      await login(email, password, mfa ? totp.trim() : undefined);
      offerBiometric();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'mfa_required') {
        setError(mfa ? 'Code not accepted. Try the current code.' : null);
        setMfa(true);
        setTotp('');
        return;
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const onUnlock = async () => {
    setBusy(true);
    setError(null);
    const ok = await unlock();
    setBusy(false);
    if (!ok) setError('Unlock failed. Try again or sign in with your password.');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.lg }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: space.xs }}>
            <T variant="big">FMS</T>
            <T variant="h2">National Fuel Monitoring System</T>
            <T variant="muted">Station owners and managers</T>
          </View>

          {status === 'locked' ? (
            <Card>
              <T variant="h2">Welcome back{user ? `, ${user.full_name}` : ''}</T>
              <Button testID="unlock" title="Unlock" onPress={onUnlock} loading={busy} />
              <Button title="Sign in with password" variant="secondary" onPress={switchToPassword} />
            </Card>
          ) : (
            <Card>
              <Field
                testID="email"
                label="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                textContentType="username"
                placeholder="you@company.zm"
              />
              <Field
                testID="password"
                label="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="password"
                textContentType="password"
                onSubmitEditing={onSubmit}
                returnKeyType="go"
              />
              {mfa ? (
                <Field
                  testID="totp"
                  label="Authenticator code"
                  value={totp}
                  onChangeText={setTotp}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={6}
                  autoFocus
                  onSubmitEditing={onSubmit}
                />
              ) : null}
              <Button testID="sign-in" title="Sign in" onPress={onSubmit} loading={busy} />
            </Card>
          )}
          {error ? (
            <Card style={{ borderColor: t.danger, borderWidth: 2 }}>
              <T color={t.danger} style={{ fontWeight: '700' }} testID="login-error">
                {error}
              </T>
            </Card>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
