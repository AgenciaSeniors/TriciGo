# Design: Sub-project #2 — Dark Mode Systematic Coverage

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Parent:** [2026-04-29-client-redesign-master-design.md](./2026-04-29-client-redesign-master-design.md)

## Goal

Fix dark mode in the client app where it's verifiably broken via hardcoded white/orange inline styles. The user reports "el modo oscuro se pone solo en la parte del home" — verified via grep: 11+ hardcoded `#fff` in `(tabs)/index.tsx` (Home — gets redesigned in #3, defer), plus hardcoded styles in Login, Verify-phone, DriverProfileScreen, and a handful of components.

## Audit findings

A first-pass agent audit miscategorized many screens as "broken" because they don't import `useThemeStore` directly. **Most actually work** because they use the `<Screen bg="white">` wrapper, which already maps to `bg-white dark:bg-neutral-900` (Screen.tsx:25). UI primitives (`Card`, `MenuRow`) call `useColorScheme()` internally and respond to NativeWind's color scheme sync.

The truly broken pieces (verified via `grep "backgroundColor:.*'#[Ff][Ff][Ff]'"`):

| File | Lines | Severity |
|---|---|---|
| `app/(auth)/login.tsx` | 76-80 (gradient), 161, 309 | **HIGH** — first impression, brand-defining |
| `app/(auth)/verify-phone.tsx` | 189 | **HIGH** — auth flow continuation |
| `src/components/DriverProfileScreen.tsx` | 358, 530 | **MEDIUM** — visible during/after ride |
| `app/(tabs)/index.tsx` | 11 instances | **DEFER to #3 (home redesign)** |
| `src/components/Web*.tsx` | several | **SKIP** — web-only paths, doesn't affect Android |
| `src/components/DriverInfoMiniCard.tsx` | 186 | LOW — overlay, brief visibility |
| `src/components/OnboardingOverlay.tsx` | 247 (already commented as "overridden inline for dark mode") | LOW — already handled |

## What changes

### 1. `app/(auth)/login.tsx`

**Hardcoded LinearGradient (lines 76-80):**
```jsx
<LinearGradient colors={['#FF4D00', '#FF6B2C', '#FF8F5C']} ...>
```

In light mode, the orange gradient is brand-defining and stays.
In dark mode, blends with deep navy bg via lower-saturation oranges.

Pattern: read `useThemeStore` → conditional gradient colors.

```jsx
const resolvedScheme = useThemeStore(s => s.resolvedScheme);
const heroColors = resolvedScheme === 'dark'
  ? ['#8B2900', '#B53600', '#FF4D00']  // muted in dark
  : ['#FF4D00', '#FF6B2C', '#FF8F5C']; // current vibrant in light
<LinearGradient colors={heroColors} ...>
```

**`backgroundColor: '#fff'` instances (lines 161, 309):**
- 161 — small icon container inside gradient — keep white (it's INSIDE an orange gradient, white is correct contrast).
- 309 — modal full-screen `View` — replace with theme-aware bg.

### 2. `app/(auth)/verify-phone.tsx`

Same pattern as login — line 189 is inside a gradient hero (same as login:161). **Keep white** since it's on the orange gradient. No fix needed if the gradient is also made theme-aware (it should be — verify).

### 3. `src/components/DriverProfileScreen.tsx`

Lines 358, 530 — both `backgroundColor: '#FFFFFF'`. Replace with `useTokens().bg.elev1` (cream `#FFFFFF` in light, navy `#11172A` in dark).

### 4. `src/components/DriverInfoMiniCard.tsx` (LOW priority)

Line 186 — small mini-card. Replace with `useTokens().bg.elev1`.

### 5. Defer to redesign sub-projects

- Home `(tabs)/index.tsx` 11 hardcoded `#fff` → fixed during #3 (home redesign)
- `(tabs)/rides.tsx` `darkColors` partial → fixed during #4
- `(tabs)/wallet.tsx` `darkColors` partial → fixed during #5
- Profile sub-pages → fixed incrementally during #6

## Non-Goals

- Don't refactor screens that already work via `<Screen>` wrapper.
- Don't touch `WebActiveRideView` / `WebAddressInput` (web-only, separate platform).
- Don't change UI primitive defaults (Card, MenuRow, Text) — they already work.
- Don't migrate every hardcoded color in the codebase. Only what's user-visible AND broken in dark mode.

## Verification

After implementation, parallel agents verify:
1. **Driver app** typecheck delta = 0
2. **Web app** typecheck delta = 0
3. **Admin app** typecheck delta = 0
4. **Client app** typecheck delta ≤ 0 (we may fix some pre-existing typing on the way)
5. Build a dev client APK via `client-v1.1.17-dev` tag → smoke test login + driver profile in dark mode.

## Files touched

- `apps/client/app/(auth)/login.tsx`
- `apps/client/app/(auth)/verify-phone.tsx`
- `apps/client/src/components/DriverProfileScreen.tsx`
- `apps/client/src/components/DriverInfoMiniCard.tsx`

~4 files. Should complete in 30 minutes.
