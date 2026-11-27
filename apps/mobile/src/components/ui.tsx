import { onlineManager } from '@tanstack/react-query';
import React, { useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../api/client';
import { offlineMessage } from '../lib/format';
import { font, radius, space, TAP, useTheme, type Palette } from '../theme';

export function useIsOnline(): boolean {
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
    () => true,
  );
}

export function Screen({
  children,
  refreshing,
  onRefresh,
  scroll = true,
  edges = ['left', 'right'],
}: {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  const t = useTheme();
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: t.bg }}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl * 2, gap: space.lg }}
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.primary} colors={[t.primary]} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </SafeAreaView>
  );
}

export function T({
  children,
  variant = 'body',
  color,
  style,
  numberOfLines,
  testID,
}: {
  children: React.ReactNode;
  variant?: 'title' | 'h2' | 'body' | 'label' | 'muted' | 'big' | 'small';
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}) {
  const t = useTheme();
  const v: Record<string, TextStyle> = {
    title: { fontSize: font.xl, fontWeight: '800' },
    h2: { fontSize: font.lg, fontWeight: '700' },
    body: { fontSize: font.md },
    label: { fontSize: font.sm, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
    muted: { fontSize: font.sm, color: t.textMuted },
    small: { fontSize: 13, color: t.textMuted },
    big: { fontSize: font.xxl, fontWeight: '800' },
  };
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[{ color: t.text }, v[variant], color ? { color } : null, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style, onPress, testID, accessibilityLabel }: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const base: ViewStyle = {
    backgroundColor: t.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: t.border,
    padding: space.lg,
    gap: space.sm,
  };
  if (onPress) {
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => [base, { minHeight: TAP, opacity: pressed ? 0.75 : 1 }, style]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View testID={testID} style={[base, style]}>
      {children}
    </View>
  );
}

export function Row({ children, style, gap = space.sm }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const bg = variant === 'primary' ? t.primary : variant === 'danger' ? t.danger : t.surfaceAlt;
  const fg = variant === 'secondary' ? t.text : variant === 'danger' ? '#FFFFFF' : t.primaryText;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TAP,
        borderRadius: radius.md,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.lg,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderColor: t.border,
      })}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: font.lg, fontWeight: '700' }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string | null }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <T variant="label">{label}</T>
      <TextInput
        placeholderTextColor={t.textMuted}
        accessibilityLabel={label}
        {...props}
        style={[
          {
            minHeight: TAP,
            borderWidth: 2,
            borderColor: error ? t.danger : t.border,
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            fontSize: font.lg,
            color: t.text,
            backgroundColor: t.surface,
          },
          props.style,
        ]}
      />
      {error ? <T color={t.danger} variant="muted">{error}</T> : null}
    </View>
  );
}

export function Badge({ label, color, testID }: { label: string; color: string; testID?: string }) {
  return (
    <View testID={testID} style={{ backgroundColor: color, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 13 }}>{label}</Text>
    </View>
  );
}

export function Dot({ color, size = 12, label }: { color: string; size?: number; label?: string }) {
  return (
    <View
      accessibilityLabel={label}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, borderWidth: 1, borderColor: '#00000033' }}
    />
  );
}

export function StatTile({ label, value, sub, color, testID }: { label: string; value: string; sub?: string; color?: string; testID?: string }) {
  return (
    <Card style={{ flex: 1, minWidth: 140 }} testID={testID}>
      <T variant="label">{label}</T>
      <T variant="big" color={color} numberOfLines={1} style={{ fontSize: 26 }}>
        {value}
      </T>
      {sub ? <T variant="muted">{sub}</T> : null}
    </Card>
  );
}

export function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="h2">{title}</T>
        {right}
      </Row>
      {children}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.sm }}>
      <ActivityIndicator size="large" color={t.primary} />
      <T variant="muted">{label}</T>
    </View>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTheme();
  return (
    <Card style={{ borderColor: t.danger, borderWidth: 2 }}>
      <T variant="h2" color={t.danger}>Couldn’t load</T>
      <T>{errorMessage(error)}</T>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </Card>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <Card>
      <T variant="muted">{text}</T>
    </Card>
  );
}

/**
 * "Offline — showing data from HH:MM" when the device is offline, or the last fetch failed
 * but cached data is being shown.
 */
export function OfflineBanner({ updatedAt, failed }: { updatedAt?: number; failed?: boolean }) {
  const online = useIsOnline();
  const t = useTheme();
  if (online && !failed) return null;
  return (
    <View
      testID="offline-banner"
      accessibilityRole="alert"
      style={{ backgroundColor: t.bannerBg, borderRadius: radius.md, padding: space.md }}
    >
      <Text style={{ color: t.bannerText, fontWeight: '800', fontSize: font.md }}>
        {online ? offlineMessage(updatedAt).replace('Offline', 'Can’t reach server') : offlineMessage(updatedAt)}
      </Text>
    </View>
  );
}

export function KV({ k, v, vColor }: { k: string; v: string; vColor?: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="muted">{k}</T>
      <T style={{ fontWeight: '700' }} color={vColor}>
        {v}
      </T>
    </Row>
  );
}

export type { Palette };
