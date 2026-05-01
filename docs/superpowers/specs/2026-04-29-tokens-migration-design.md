# Design: Sub-project #1 — Tokens + Typography Migration (Cuban Modern)

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Parent:** [2026-04-29-client-redesign-master-design.md](./2026-04-29-client-redesign-master-design.md)

## Goal

Expose the existing `cubanLight`/`cubanDark` color tokens via Tailwind preset, add Bricolage/Instrument Serif typography variants, and provide a single `useTokens()` hook that resolves to the right palette per theme mode. **No screen redesigns yet** — this sub-project just lays the foundation. Subsequent sub-projects consume these tokens.

## Non-Goals

- Don't touch any screen yet (Home, Mis Viajes, Wallet, Profile stay visually identical).
- Don't remove existing `colors.*` / `darkColors.*` tokens — they stay for backward compatibility. New work uses `cuban*` tokens; old code unchanged.
- Don't change driver/web/admin token usage.

## What changes

### 1. `packages/theme/src/typography.ts`

Add font family constants for Bricolage and Instrument Serif:

```ts
export const fontFamily = {
  sans: 'Inter',
  sansFallback: 'Montserrat',
  mono: 'JetBrains Mono',
  display: 'BricolageGrotesque',           // NEW — for headings
  accent: 'InstrumentSerif',               // NEW — for italic accent ("¿A dónde vamos?")
  accentItalic: 'InstrumentSerif-Italic',  // NEW
} as const;
```

Add new typography variants:

```ts
export const textVariants = {
  // ...existing variants kept...

  /** Display XL — hero numbers, balance amounts. Bricolage 42pt, tight tracking. */
  displayXl: {
    fontFamily: fontFamily.display,
    fontSize: 42,
    fontWeight: fontWeight.bold,
    lineHeight: 1.05,
    letterSpacing: -0.5,
  },
  /** Display L — section headings. Bricolage 28pt. */
  displayLg: {
    fontFamily: fontFamily.display,
    fontSize: 28,
    fontWeight: fontWeight.semibold,
    lineHeight: 1.15,
    letterSpacing: -0.25,
  },
  /** Accent — Instrument Serif italic for emotional anchor phrases. */
  accent: {
    fontFamily: fontFamily.accentItalic,
    fontSize: 28,
    fontWeight: fontWeight.regular,
    lineHeight: 1.2,
    fontStyle: 'italic',
  },
  /** Caption mono — uppercase metadata labels (SALDO DISPONIBLE, RECIENTES). */
  captionMono: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontWeight: fontWeight.medium,
    lineHeight: 1.3,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
};
```

### 2. `packages/theme/tailwind-preset.js`

Expose `cubanLight` / `cubanDark` colors via Tailwind, plus new font families. The preset is consumed by `apps/client/tailwind.config.ts` (and admin's, but admin only uses non-cuban tokens — additive change is safe).

Concretely add under `theme.extend`:

```js
colors: {
  // Cuban Modern — light mode (default)
  cuban: {
    paper: '#FFFBF5',
    elev1: '#FFFFFF',
    elev2: '#F4EEE2',
    'ink-1': '#1A1414',
    'ink-2': '#6B7F8F',
    'ink-3': '#A9B4BC',
    orange: '#FF4D00',
    warm: '#FFB547',
    dusk: '#6B7F8F',
    line: 'rgba(26, 20, 20, 0.08)',
  },
  'cuban-dark': {
    paper: '#0A0E1A',
    elev1: '#11172A',
    elev2: '#18203A',
    'ink-1': '#F4F0EA',
    'ink-2': '#B7C4CF',
    'ink-3': '#6B7F8F',
    orange: '#FF4D00',
    warm: '#FFB547',
    dusk: '#4A6278',
    line: 'rgba(244, 240, 234, 0.08)',
  },
},
fontFamily: {
  display: ['BricolageGrotesque', 'sans-serif'],
  accent: ['InstrumentSerif', 'serif'],
  'accent-italic': ['InstrumentSerif-Italic', 'serif'],
  mono: ['JetBrainsMono', 'monospace'],
},
```

### 3. `packages/theme/src/index.ts` — new `useTokens()` hook

A thin React hook that reads the theme store and returns the resolved palette. Lives in client app since it depends on `useThemeStore` (which is in client app, not theme package). So actually:

**Move:** create `apps/client/src/hooks/useTokens.ts`:

```ts
import { useThemeStore } from '@/stores/theme.store';
import { cubanLight, cubanDark } from '@tricigo/theme';

/**
 * Returns the resolved Cuban Modern palette based on the user's
 * current theme mode (light/dark, system-resolved). Use in
 * StyleSheet-based components (where Tailwind classes don't apply).
 *
 * For NativeWind components, prefer `dark:` class variants directly.
 */
export function useTokens() {
  const resolvedScheme = useThemeStore((s) => s.resolvedScheme);
  return resolvedScheme === 'dark' ? cubanDark : cubanLight;
}
```

### 4. Driver app — no change

Driver theme tokens stay separate (`driverDarkColors`, `driverMapDarkColors`, etc.). The Cuban tokens are client-only. Driver continues to use its own palette.

### 5. Admin app — no change

Admin already has LUCIA tokens. We're not unifying admin and client — they each have their own identity by design.

## Verification (after implementation)

Spawn 4 parallel agents:

1. **DB agent** — confirm zero schema changes, no migration needed.
2. **Driver agent** — typecheck `apps/driver/`, grep for any `cubanLight` / `cubanDark` import (should be zero).
3. **Web agent** — typecheck `apps/web/`, same grep.
4. **Admin agent** — typecheck `apps/admin/`, confirm new fonts don't conflict with admin's existing typography.

Then in `apps/client/`:
- `pnpm tsc --noEmit` clean.
- Build dev client APK via existing workflow → install → confirm app still opens (no visual changes expected at this stage).

## Files touched

- `packages/theme/src/typography.ts` (additive)
- `packages/theme/tailwind-preset.js` (additive)
- `apps/client/src/hooks/useTokens.ts` (new)

That's it. ~3 files. Should complete in under 30 minutes.
