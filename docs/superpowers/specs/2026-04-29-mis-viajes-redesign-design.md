# Design: Sub-project #4 — Mis Viajes (Rides History) Redesign

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Parent:** [2026-04-29-client-redesign-master-design.md](./2026-04-29-client-redesign-master-design.md)

## Goal

Apply Cuban Modern identity to the passenger rides history screen (`apps/client/app/(tabs)/rides.tsx`). Currently uses Montserrat + neutral grays + `Card variant="outlined"` — generic. Replace with Bricolage Grotesque for headings, JetBrains Mono for numbers, cream surface in light mode, full Cuban Modern dark mode.

## Scope

**In scope:**
- `NativeRidesScreen` (mobile path, `apps/client/app/(tabs)/rides.tsx:386-713`)
- Apply `useTokens()` for resolved palette
- Apply Bricolage for screen title ("Historial de viajes") and section heading ("Viajes programados")
- Apply JetBrains Mono for fare amounts
- Apply captionMono for date group headers and meta labels
- Replace `Card variant="outlined"` with Cuban-styled card surface
- Maintain all existing functionality (filters, CSV export, refresh, load more, scheduled rides)

**Out of scope:**
- `WebRidesScreen` (mobile-first iteration; web later)
- Filter component redesign (`HistoryFilters` — separate component)
- StatusBadge restyling (used elsewhere; out of #4)

## Visual changes

### Title row
- Was: `<Text variant="h3">{t('rides_history.title')}</Text>` (Montserrat 20pt bold)
- Will be: `<Text variant="displayLg">{t('rides_history.title')}</Text>` (Bricolage 28pt semibold, tighter tracking)

### Date group headers
- Was: `<Text variant="caption" color="secondary">` ("Hoy", "Ayer")
- Will be: captionMono uppercase ("HOY", "AYER") with `letterSpacing: 1.5` and `tokens.ink.secondary` color

### Ride card
- Was: `<Card variant="outlined" padding="md">` — neutral border, white bg
- Will be: cuban surface card — `tokens.bg.elev1` background, subtle `tokens.line` border, soft shadow on light, no shadow on dark
- Keep the same internal layout (vehicle icon row, route summary, fare row)

### Fare amount
- Was: `<Text variant="body" className="font-semibold">{formatTRC(fare)}</Text>`
- Will be: `<Text variant="numberMono">{formatTRC(fare)}</Text>` (JetBrains Mono 16pt)
- USD secondary stays the same

### Empty state
- Keeps existing `EmptyState` component — that's a separate primitive, out of scope for #4.

### Scheduled rides section
- Title from `<Text variant="h4">` → `<Text variant="displayMd">` (Bricolage 20pt semibold)
- Card border from `border-primary-500/30` → use `tokens.accent.orange` with reduced opacity inline

## Dark mode

The screen already uses `<Screen bg="white">` (which maps `bg-white dark:bg-neutral-900`) and consumes `useColorScheme()` for the CSV button icon. The redesign upgrades this to:

- Read `useTokens()` (Cuban palette resolution).
- Background: in light mode, `cubanLight.bg.paper` (`#FFFBF5` cream); in dark, `cubanDark.bg.paper` (`#0A0E1A` deep navy).
- Card: in light, `cubanLight.bg.elev1` (`#FFFFFF`); in dark, `cubanDark.bg.elev1` (`#11172A`).
- Body text: `tokens.ink.primary`. Secondary: `tokens.ink.secondary`. Subtle: `tokens.ink.subtle`.
- Borders: `tokens.line`.
- The `Screen` wrapper's default `bg="white"` is replaced with explicit `style={{ backgroundColor: tokens.bg.paper }}` on the outer container, since cream `#FFFBF5` is intentionally NOT pure white.

## Files touched

- `apps/client/app/(tabs)/rides.tsx` (NativeRidesScreen function only, lines 386-713)

That's one file, ~327 lines being touched in place. Web code untouched.

## Verification

1. Typecheck delta = 0 in client app.
2. Multi-agent: driver, web, admin, db typecheck deltas all = 0 (none consume rides.tsx).
3. Visual: build dev client APK, install, open Mis Viajes tab in light mode — see cream bg + Bricolage title. Toggle to dark mode — see navy bg + same Bricolage. Tap a ride → opens detail (existing flow, unchanged).
4. Functional: all existing flows work — filters, CSV export, refresh, load more, scheduled rides.

## Risks

- `Card variant="outlined"` is used widely. We're NOT changing the Card component itself, only how rides.tsx uses it. Other consumers stay unaffected.
- Adding `useTokens` adds a `useThemeStore` subscription; same pattern Home already uses, no perf concern.
- Bricolage font might not be loaded yet. Already loaded in `_layout.tsx:14-17` — verified.

That's it. Estimated effort: 30-40 min.
