# Design: Sub-project #3 (revised) — Home Content Cards

**Status:** approved (auto mode)
**Date:** 2026-04-29
**Parent:** [2026-04-29-client-redesign-master-design.md](./2026-04-29-client-redesign-master-design.md)

## Goal

Add Uber-style content cards (promotions + blog posts) to the passenger home idle view **without changing the existing design**. The user explicitly said "manten el home como está" — so this is purely additive content, not a visual redesign. Match the home's existing aesthetic (Cuban tokens already in use, JetBrainsMono labels, BricolageGrotesque accents).

## Non-Goals

- No restyle of any existing home element.
- No new home routes / screens.
- No campaigns section (no rider-facing campaign service exists; would need a new schema/RLS/service — defer).
- No deep links into individual blog posts (no `/profile/blog/[slug]` route exists; tap routes to the blog list).

## What changes

### `apps/client/app/(tabs)/index.tsx` — IdleView only

**Imports added:**
- `blogService`, `type BlogPost` from `@tricigo/api`
- `type Promotion` from `@tricigo/types`

**State added (after `walletBalance`):**
- `activePromos: Promotion[]`
- `blogPosts: BlogPost[]`

**Effect added (after the wallet useEffect):**
- Single `useEffect` (no deps, fires once on mount).
- Promos query inline via `getSupabaseClient()`: `is_active = true AND (valid_until IS NULL OR valid_until > now)` — limit 6, ordered by created_at desc.
- Blog query: `blogService.getPublishedPosts(0, 6)`.
- Both wrapped in try/catch — silent failure (home still works without these sections).

**JSX inserted between RECIENTES (line 2110) and `<CapitolioDivider>` (line 2113):**

1. **Promos section** (only if `activePromos.length > 0`):
   - Mono uppercase label "PROMOS" matching the existing pattern (10pt, letterSpacing 2).
   - Horizontal `<ScrollView>` of cards.
   - Each card: 220px wide, `tokens.bg.elev1` bg, `tokens.accent.orange` border, rounded-2xl.
   - Card content: pricetag icon + code (mono small) + headline (Bricolage 22pt bold orange — `${X}% OFF` or `${Y} CUP`) + expiry mono caption.
   - On tap → `/profile/referral` (existing route).

2. **Novedades section** (only if `blogPosts.length > 0`):
   - Mono uppercase label "NOVEDADES".
   - Horizontal `<ScrollView>` of cards.
   - Each card: 240px wide, `tokens.bg.elev1` bg, `tokens.line` border, rounded-2xl, overflow hidden.
   - Card content: cover image (100px tall) or fallback newspaper icon + title (Bricolage SemiBold 14pt, 2 lines max) + excerpt (Inter 11pt, 2 lines max).
   - On tap → `/profile/blog` (existing route).

## Visual fidelity

The cards use the same tokens (`tokens.bg.elev1`, `tokens.line`, `tokens.ink.*`, `tokens.accent.orange`, `tokens.accent.orangeGlow`) and same fonts (JetBrainsMono labels, BricolageGrotesque accents) as the rest of the home. No NEW visual language.

## Files touched

- `apps/client/app/(tabs)/index.tsx` (additive: imports, 2 state hooks, 1 useEffect, ~140 lines of JSX between existing sections)
- `docs/superpowers/specs/2026-04-29-home-content-cards-design.md` (this file)

No new components, no service additions, no DB migrations.

## Verification

- Client typecheck delta: 0 (baseline 125, after 125 — pre-existing NativeWind className issues unaffected).
- Driver / Web / Admin typecheck delta: 0.
- DB: no schema changes.
- Functional: open app idle view → see PROMOS scroll if any active promo exists; see NOVEDADES scroll if any published blog post exists. Both gracefully hide when empty.

## Future iterations (parking lot)

- **Campaigns**: requires new `campaigns` table + RLS + rider service. Add when product needs it.
- **Blog post detail route** (`/profile/blog/[slug]`): would let card tap go directly to the post instead of the list.
- **Referral / promo share CTA**: wire the promo card to copy code to clipboard + show toast instead of navigating.
- **Skeletons**: while promos/blog are loading on cold start, the sections just don't render. Skeletons would be polish, not critical.
