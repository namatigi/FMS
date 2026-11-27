import { useColorScheme } from 'react-native';
import { useSettings } from './settings/SettingsProvider';

/** High-contrast palettes (WCAG AA+ on surfaces) tuned for outdoor/sunlight use. */
export interface Palette {
  scheme: 'light' | 'dark';
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  water: string;
  fuel: Record<string, string>;
  bannerBg: string;
  bannerText: string;
}

const light: Palette = {
  scheme: 'light',
  bg: '#F2F4F7',
  surface: '#FFFFFF',
  surfaceAlt: '#E7EBF0',
  border: '#B8C0CC',
  text: '#0B1220',
  textMuted: '#3D4656',
  primary: '#0B5CAD',
  primaryText: '#FFFFFF',
  success: '#0A7A3E',
  warning: '#A35200',
  danger: '#B3261E',
  info: '#0B5CAD',
  water: '#1E6FD9',
  fuel: { PETROL: '#D97706', DIESEL: '#1F7A4D', KEROSENE: '#7C3AED', JETA1: '#0E7490', LPG: '#BE185D' },
  bannerBg: '#3D2A00',
  bannerText: '#FFE08A',
};

const dark: Palette = {
  scheme: 'dark',
  bg: '#05080D',
  surface: '#111823',
  surfaceAlt: '#1B2533',
  border: '#3A4658',
  text: '#F5F7FA',
  textMuted: '#B4BECC',
  primary: '#5AA9FF',
  primaryText: '#04121F',
  success: '#4ADE80',
  warning: '#FBBF24',
  danger: '#FF6B6B',
  info: '#5AA9FF',
  water: '#60A5FA',
  fuel: { PETROL: '#F59E0B', DIESEL: '#34D399', KEROSENE: '#A78BFA', JETA1: '#22D3EE', LPG: '#F472B6' },
  bannerBg: '#FFE08A',
  bannerText: '#2B1D00',
};

export const palettes = { light, dark };

export function useTheme(): Palette {
  const system = useColorScheme();
  const { settings } = useSettings();
  const scheme = settings.theme === 'system' ? (system === 'dark' ? 'dark' : 'light') : settings.theme;
  return scheme === 'dark' ? dark : light;
}

export function fuelColor(p: Palette, code: string | null | undefined): string {
  return (code && p.fuel[code]) || p.primary;
}

export function severityColor(p: Palette, severity: string): string {
  if (severity === 'critical') return p.danger;
  if (severity === 'warning') return p.warning;
  return p.info;
}

export function connectivityColor(p: Palette, c: string | null | undefined): string {
  if (c === 'online') return p.success;
  if (c === 'degraded') return p.warning;
  return p.danger;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 10, lg: 16 };
export const font = { sm: 14, md: 16, lg: 18, xl: 22, xxl: 30 };
/** Minimum tap target (dp). */
export const TAP = 52;
