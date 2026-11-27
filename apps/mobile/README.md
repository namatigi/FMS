# FMS mobile: station owner and manager app

This is the Expo (React Native and TypeScript) app for the National Fuel Monitoring System. It talks to core-api (`/api/v1`) and analytics (`/analytics/v1`), using the shapes in `docs/api/CONTRACTS.md`. It does not depend on `@fms/shared` at runtime. The types it needs are copied into `src/api/types.ts`.

## Features

| Screen | What it does |
|---|---|
| Login | Email and password sign-in. If the API returns 401 `mfa_required`, the app asks for a TOTP code and retries with `totp_code`. A 429 `account_locked` shows a lockout message. After the first login the app offers biometric unlock (`expo-local-authentication`). The refresh token is stored in Keychain or Keystore (`expo-secure-store`). Token refresh is automatic: it runs on a 401, or proactively when the token is within 30 s of expiry, and is single-flight. |
| Home | Today's sales (volume, `K 1,234.56`, transaction count), stations online and offline, open alerts, a sales-by-product chart with stock bars, and the low-stock tanks list. Pull to refresh; auto-refresh every 30 s. |
| Stations | Search, with a connectivity dot per station. The detail view shows animated tank gauges (fill, water band, temperature, days of cover, alarms), today's sales by product and by pump, recent transactions with fiscal status and ZRA receipt number, the last 14 days of deliveries, and stock-out risk from `/analytics/v1/forecast/stockout?station_id=`. |
| Alerts | Open and All lists sorted by severity, with severity colours. The detail view has an acknowledge action (optimistic). Tapping a push notification opens the alert. |
| Prices | Owner and admin only; the tab is hidden for managers. Shows current price against the ERB cap and headroom. Prices are validated on the device first, and changes go through a confirmation dialog before `PUT /stations/:id/prices`. API errors such as "above cap" are shown inline. |
| Settings | Profile (`GET /me`), notification preferences, biometric toggle, theme (Auto, Light for sunlight, Dark) and, in dev builds only, the API environment switcher. |

**Offline support:** TanStack Query persists its cache to AsyncStorage for 24 h. NetInfo drives online and offline status. When the device is offline, or the server can't be reached while cached data is on screen, a banner shows "Offline — showing data from HH:MM".

## Configuration

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_API_URL` | The origin that serves `/api/v1`, and `/analytics/v1` behind the reverse proxy. The default is `http://localhost:8080`. |
| `EXPO_PUBLIC_ANALYTICS_URL` | Optional. A separate origin for analytics, for example `http://<host>:8090` in development without the proxy. |
| `EAS_PROJECT_ID` | Set after `eas init`. It enables Expo push tokens; without it the app registers the raw FCM or APNs token. |
| `APP_VARIANT` | `development`, `preview` or `production`. It sets the bundle id suffix and the app name. |

Copy `.env.example` to `.env.local`. On a physical phone, use your PC's LAN IP rather than `localhost`.

## Run

```bash
cd apps/mobile
npm install
npx expo start            # scan the QR code with Expo Go (Android or iOS)
npx expo start --web      # quick check in a browser
```

Demo logins from `db/seed/001_demo.sql` use the password `ChangeMe123!`:
- `owner@zambezi.local` sees every Zambezi station and the Prices tab.
- `manager@zambezi.local` sees Cairo Road only and has no Prices tab.

Expo Go is enough for most screens. Push tokens and biometric prompts are more reliable in a development build: `npx eas-cli@latest build --profile development`.

## Test and typecheck

```bash
npx tsc --noEmit
npm test                  # jest-expo + @testing-library/react-native
npx expo export --platform web   # bundling smoke test
```

## Build and release (EAS)

```bash
npm i -g eas-cli          # or: npx eas-cli@latest <cmd>
eas login && eas init     # creates the project id; export it as EAS_PROJECT_ID
eas build --profile development --platform android   # dev client APK
eas build --profile preview --platform all           # internal testers (APK / ad-hoc)
eas build --profile production --platform android    # AAB for the Play Store
eas build --profile production --platform ios        # IPA for the App Store
eas submit --profile production --platform android   # needs secrets/play-service-account.json
eas submit --profile production --platform ios       # set ascAppId in eas.json
```

Edit the API URLs for each profile in `eas.json` before building preview or production.

## Proposed core-api contract additions

These are not yet in `CONTRACTS.md`. The app calls them on a best-effort basis and ignores 404s.

1. `POST /api/v1/me/devices` takes `{platform: "ios"|"android", token}` and returns 204. It is an idempotent upsert per user and token, and accepts both Expo push tokens and raw FCM/APNs tokens.
2. `DELETE /api/v1/me/devices/:token`, called on logout.
3. `PUT /api/v1/me/notification-preferences` takes `{critical_alerts, warning_alerts, low_stock, daily_summary}`.
4. A push payload `data` of `{type:"alert", alert_id, station_id, severity}`, used for deep links.
5. `erb_cap` on `GET /stations/:id` `fuel_grades[]`, or an owner-readable `GET /api/v1/prices/caps`. Today caps are only exposed at `/regulator/prices`, which owners can't call. Until then the app shows "checked on save" and relies on the 4xx from `PUT /prices`.
6. `GET /api/v1/alerts/:id` for deep links. For now the detail view is resolved from `/alerts?status=all`.
7. Alert items should include `station_name`.

## Layout

```
src/app/            expo-router routes (login, (app)/(tabs)/*, station/[id], alert/[id])
src/screens/        screen components (testable without the router)
src/api/            ApiClient (auth + refresh), TanStack Query hooks, types, persistence
src/auth/           AuthProvider (login / biometric lock / logout), secure storage
src/components/     UI kit, SVG bar chart, animated tank gauge
src/notifications/  push registration + handlers
```
