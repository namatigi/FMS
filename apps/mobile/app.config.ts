import type { ExpoConfig } from 'expo/config';

/**
 * Environment-driven config.
 *   EXPO_PUBLIC_API_URL        origin serving /api/v1 (and /analytics/v1 behind the proxy)
 *   EXPO_PUBLIC_ANALYTICS_URL  optional separate origin for /analytics/v1 (dev: http://<host>:8090)
 *   EAS_PROJECT_ID             set after `eas init`; enables Expo push tokens
 *   APP_VARIANT                development | preview | production (set per EAS profile)
 */
const variant = process.env.APP_VARIANT ?? 'development';
const suffix = variant === 'production' ? '' : `.${variant}`;
const nameSuffix = variant === 'production' ? '' : variant === 'preview' ? ' (Preview)' : ' (Dev)';

const config: ExpoConfig = {
  name: `FMS Zambia${nameSuffix}`,
  slug: 'fms-zambia',
  scheme: 'fms',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: `zm.fms.mobile${suffix}`,
    supportsTablet: true,
    infoPlist: {
      NSFaceIDUsageDescription: 'Unlock the FMS app with Face ID.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: `zm.fms.mobile${suffix}`,
    adaptiveIcon: {
      backgroundColor: '#0B5CAD',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    permissions: ['USE_BIOMETRIC', 'USE_FINGERPRINT'],
  },
  web: { favicon: './assets/favicon.png', output: 'single' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-local-authentication', { faceIDPermission: 'Unlock the FMS app with Face ID.' }],
    ['expo-notifications', { color: '#0B5CAD' }],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080',
    analyticsUrl: process.env.EXPO_PUBLIC_ANALYTICS_URL ?? '',
    appVariant: variant,
    ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
  },
};

export default config;
