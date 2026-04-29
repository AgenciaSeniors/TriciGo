# Design: Sub-project #5 — Tricicoin (Wallet) Redesign

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Parent:** [2026-04-29-client-redesign-master-design.md](./2026-04-29-client-redesign-master-design.md)

## Goal

Apply Cuban Modern identity to `NativeWalletScreen` in `apps/client/app/(tabs)/wallet.tsx` (lines 569-1316). Keep all functionality (balance, recharge, transfer, monthly insights, transaction list, Stripe sheet, transfer sheet) intact. Web wallet untouched.

## In scope

- Title row + Tricicoin logo image: `variant="h3"` → `variant="displayLg"`.
- Section headings ("Este mes", "Historial"): `variant="h4"` → `variant="displayMd"`.
- Monthly insights stats cards: replace `bg-primary-50/950` Tailwind classes with Cuban surface (`tokens.bg.elev1`) + orange-glow accent (`tokens.accent.orangeGlow`). Numbers use `numberMono` with `tokens.accent.orange`.
- Filter chips: keep tab-pill pattern, apply Cuban tokens (`tokens.bg.elev2` for inactive, `tokens.accent.orange` for active) instead of Tailwind classes.
- Transaction list items:
  - Description: `variant="bodySmall"` stays, color via `tokens.ink.primary`.
  - Date: `variant="caption"` → `variant="captionMono"` with `tokens.ink.subtle`.
  - Amount: `numberMono` with green/red conditional based on isCredit.
  - Border: `border-neutral-100 dark:border-neutral-800` → inline `tokens.line`.
- Background: explicit `tokens.bg.paper` on the outer container.

## Out of scope

- Web wallet (`WebWalletScreen`).
- BottomSheet content (recharge / transfer flows) — those are dense forms; redesign separately or roll into a future iteration.
- BalanceBadge component changes — this is a cross-app primitive and changes need broader audit. Keep the gradient `['#FF4D00', '#FF8A5C']` for now (brand-defining heroes).
- Skeleton states — keep current SkeletonBalance / SkeletonListItem.

## Files touched

- `apps/client/app/(tabs)/wallet.tsx` (NativeWalletScreen + renderTransaction only)

## Verification

- Typecheck delta = 0 in client.
- Multi-agent: driver/admin/web/db deltas = 0.
- Functional: tap Recharge → bottom sheet opens. Tap Transfer → bottom sheet opens. Filter chips switch correctly. Transaction list scrolls + refreshes.

That's ~30 min of edits.
