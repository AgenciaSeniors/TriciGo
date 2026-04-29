# Design: Sub-project #6 — Perfil Redesign

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Parent:** [2026-04-29-client-redesign-master-design.md](./2026-04-29-client-redesign-master-design.md)

## Goal

Apply Cuban Modern identity to `NativeProfileScreen` in `apps/client/app/(tabs)/profile.tsx`. The screen is small (331 lines total, ~190 lines for the native screen) and already structurally good — uses `<Screen>`, `<Card>`, `<MenuRow>`, theme store. Just needs the visual polish.

## Changes

### NativeProfileScreen
- Add `useTokens()`.
- Title "Perfil": `variant="h3"` → `variant="displayLg"` (Bricolage 28pt) with `tokens.ink.primary`.
- Outer ScrollView container: `style={{ backgroundColor: tokens.bg.paper, flex: 1 }}` for the cream/navy background.
- User info card: replace `<Card variant="filled">` with cuban-styled View (bg.elev1 + line + soft shadow). Avatar gradient kept (it's brand-defining).
- User name: `variant="h4"` → `variant="displayMd"` with `tokens.ink.primary`.
- Phone: kept `bodySmall` but explicit `tokens.ink.secondary` color.
- Section headers: caption uppercase tracking → `variant="captionMono"` with `tokens.ink.subtle`. Cleaner, more design-system.
- MenuRow + StatusBadge primitives: untouched (they handle dark mode themselves).

## Out of scope

- WebProfileScreen (web later).
- Profile sub-pages (settings, edit, help, etc. — 17 files). Roll into a follow-up "Profile sub-pages dark mode pass" if needed; most use `<Screen bg="white">` which already maps to dark.
- Avatar primitive — keep current behavior.
- StatusBadge primitive — keep current behavior.
- LinearGradient avatar border — orange→light orange gradient stays, brand-defining.

## Files touched

- `apps/client/app/(tabs)/profile.tsx` (NativeProfileScreen only)

## Verification

- Typecheck delta = 0 in client.
- Multi-agent: driver/admin/web/db deltas = 0.

~15 min.
