# Design: Android Dev Client Workflows (GitHub Actions)

**Status:** approved
**Date:** 2026-04-29
**Author:** Eduardo + Claude

## Goal

Add two GitHub Actions workflows that build standalone **dev client** APKs (one for `apps/client`, one for `apps/driver`) so Eduardo can install them on his Samsung in Brazil, run Metro on his laptop, and iterate on JS/TS code with hot reload — without rebuilding the APK each time.

## Non-Goals

- No OTA updates (`expo-updates`).
- No Play Store / production signing.
- No iOS dev client (Android-only for now).
- No combined "build both apps" workflow — apps stay separated by user request.

## Architecture

### Two separate workflow files

- `.github/workflows/android-dev-client-client.yml` — triggers only on `client-v*-dev` tags + `workflow_dispatch`
- `.github/workflows/android-dev-client-driver.yml` — triggers only on `driver-v*-dev` tags + `workflow_dispatch`

Each workflow is linear (no target detection). Pattern mirrors existing `android-apk.yml` but with key differences below.

### Build steps (per workflow)

1. Checkout code at tag.
2. Setup pnpm + Node 20 + JDK 17 + Gradle cache.
3. `pnpm install --frozen-lockfile`.
4. Write `google-services.json` from `CLIENT_GOOGLE_SERVICES_JSON` / `DRIVER_GOOGLE_SERVICES_JSON` secret; placeholder fallback.
5. `expo prebuild --platform android --no-install --clean` (NO `EXPO_PUBLIC_DEMO_*` env vars — those are runtime via Metro).
6. Bump Gradle JVM heap to 6GB (same OOM fix as existing workflow).
7. `./gradlew assembleDebug --no-daemon --stacktrace` — debug variant signed with auto-generated debug keystore (no signing patch needed; debug variant is signed by default).
8. Rename `app-debug.apk` → `tricigo-{app}-{tag}-dev.apk`.
9. Upload as artifact (90 days retention).
10. Step Summary with download link + Metro instructions.

### Differences vs `android-apk.yml`

| Concern | `android-apk.yml` (standalone) | `android-dev-client-*.yml` (this spec) |
|---|---|---|
| Gradle target | `assembleRelease` | `assembleDebug` |
| JS bundling | Bundled into APK | NOT bundled — Metro serves at runtime |
| ProGuard/R8 | Enabled (size diet) | Disabled (debug variant) |
| Signing | Patched release config → debug keystore | Native debug signing (no patching) |
| `expo-dev-client` | Disabled / inert | Active launcher screen |
| Demo flag | Build-time `EXPO_PUBLIC_DEMO_MODE` | Runtime via Metro env vars |
| Use case | Sideload-able APK for end users | Internal dev iteration only |

## Runtime Flow

After install:

1. Eduardo opens app → sees dev client launcher (empty server list).
2. On laptop, runs Metro: `cd apps/client && pnpm start` (optionally with `EXPO_PUBLIC_DEMO_MODE=true EXPO_PUBLIC_DEMO_CITY=sao_paulo`).
3. Pastes Metro URL into launcher (or scans QR).
4. APK downloads bundle from Metro, opens app.
5. Edit `.tsx` → save → HMR reflects in device (~1-3s).
6. Toggle demo↔prod by restarting Metro with/without env vars (no APK reinstall).
7. Fallback: `pnpm start --tunnel` if LAN doesn't work.

## Tagging Convention

Last shipped version: `1.1.16`. Next dev tags would be:

```bash
git tag client-v1.1.17-dev
git tag driver-v1.1.17-dev
git push origin client-v1.1.17-dev driver-v1.1.17-dev
```

Existing tag patterns remain untouched:
- `*-v*-apk` → standalone production APK (Cuba).
- `*-v*-demo-apk` → standalone demo APK (Brazil).
- `*-v*-dev` → **NEW** dev client APK.

## Secrets Required

Already exist (used by `android-apk.yml`):
- `CLIENT_GOOGLE_SERVICES_JSON`
- `DRIVER_GOOGLE_SERVICES_JSON`

If missing, builds still succeed with placeholder (push notifications won't work — acceptable for dev client).

## Verification

After PR merge + first dev tag:
1. Confirm workflow runs green on tag push.
2. Download APK artifact, install on Samsung.
3. Run Metro on laptop (same WiFi).
4. Confirm app loads bundle from Metro.
5. Edit a `.tsx` file → confirm HMR reflects.
6. Restart Metro with `EXPO_PUBLIC_DEMO_MODE=true` → confirm DemoBanner appears without APK reinstall.

## Risk / Rollback

- New workflows are additive — no edit to `android-apk.yml`. If broken, delete the two new files.
- Debug APK is sideload-able but useless without Metro — no risk of accidentally distributing to end users.
- Tag namespace `*-dev` doesn't collide with existing `*-apk` / `*-demo-apk` patterns.
