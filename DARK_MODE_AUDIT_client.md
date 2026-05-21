# client — Dark Mode Contrast Audit

Scope: `apps/client` only (React Native / Expo passenger app). Every `.tsx`
under `apps/client/app` and `apps/client/src` was grepped for hex literals,
`color`/`backgroundColor`/`borderColor` literals (StyleSheet, inline, props)
and bare NativeWind classes (`text-white`, `bg-white`, `text-neutral-900`,
etc.), then read in context.

Theme model recap: NativeWind `dark:` variants flip with a Zustand theme
store; StyleSheet/inline code reads `useColorScheme()` / `useThemeStore` /
`useTokens()` (Cuban Modern `cubanLight`/`cubanDark`). The shared `<Screen
bg="white">` resolves to `bg-white dark:bg-neutral-900` (it DOES flip — not a
bug), `bg="cuban"` → `bg-cuban-paper dark:bg-cuban-dark-paper`. The shared
`<Card>` variants flip (`bg-white dark:bg-neutral-800`, etc.).

## Summary

- Files scanned: 79. Files with findings: 12.
- FIX: 17  |  KEEP: (large, not enumerated — see Notes)  |  REVIEW: 14

The vast majority of candidates are **KEEP**: white text/icons on the
permanent brand-orange (`#FF4D00`) gradient/buttons/badges, white on
permanently-colored status banners (green arrival, sky/violet proximity, red
SOS), `shadowColor:'#000'`, semantic status colors (green/amber/red), map
markers/overlays (the client map is always `MAP_STYLE_LIGHT` by design), and
hex literals that are explicitly gated by an `isDark ? darkColors.X : <hex>`
conditional. Those are not listed row-by-row.

## Findings

| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| **apps/client/app/+not-found.tsx** | | | | |
| +not-found.tsx:8 | `<View className="flex-1 items-center justify-center bg-white">` | 1 | FIX | Add `dark:bg-neutral-900`. Whole 404 screen surface locked white; `<Text color="secondary">` flips to light-gray → low contrast on white in dark. |
| **apps/client/app/(tabs)/index.tsx** (NativeHomeScreen path) | | | | |
| index.tsx:2023-2024 | `backgroundColor: '#f5f5f5'` / `'#e5e7eb'` (initialLoading skeleton) | 2 | FIX | Gate with `isDark`/`tokens.bg.*`. Transient loading screen flashes light-gray in dark mode. |
| index.tsx:2694 | `idleStyles.bottomPanel` → `backgroundColor: '#fff'` | 2 | FIX | Loading-skeleton bottom panel locked white. Drive from `useTokens()` (`bg.elev1`). |
| index.tsx:3178 | `<ScrollView style={{ ...backgroundColor: '#fff', zIndex: 20 }}>` (fullscreen address-search panel) | 2 | FIX | Fullscreen panel (top/left/right/bottom:0) locked white. Should read `tokens.bg.paper`. |
| index.tsx:3246 | `<View style={{ ...backgroundColor: '#fff' ... }}>` (SelectingView services/payment bottom panel) | 2 | FIX | Bottom content panel (~50% screen height) locked white. Root of the locked-light SelectingView panel — see Notes. |
| index.tsx:3256,3301,3341,3467 | `backgroundColor: isSelected ? '#FFF5F0' : '#fff'` (service / vehicle / category / payment cards) | 2 | FIX | Cards inside the bottom panel never flip; light-pink/white locked. Pair with theme-aware surfaces. |
| index.tsx:3311,3315,3349,3355,3357 | `<TextInput style={{ backgroundColor: '#fff', ... color: colors.neutral[900] }}>` (delivery form inputs) | 2 | FIX | Inputs locked white with near-black text; whole delivery form is a locked-light island in dark mode. |
| index.tsx:3682 | `<View ... style={{ ...backgroundColor: '#fff' }}>` (ReviewingView recommended-service card) | 2 | FIX | Recommended-service card locked white; ReviewingView sits on the flipping `cuban` Screen. |
| **apps/client/app/chat/[rideId].tsx** (`Screen bg="cuban"`) | | | | |
| chat/[rideId].tsx:114 | `isOwn ? 'bg-primary-500 ...' : 'bg-neutral-200 ...'` (incoming chat bubble) | 1 | FIX | `bg-neutral-200` has no `dark:`; the bubble's `<Text color="primary">` flips to light text → light-on-light. Add `dark:bg-neutral-800` (+ keep readable text). |
| chat/[rideId].tsx:265 | `<TextInput className="flex-1 bg-neutral-100 rounded-full ...">` (message input) | 1 | FIX | Input bg locked light on a dark `cuban` screen. Add `dark:bg-neutral-800` and set input text color for dark. |
| chat/[rideId].tsx:150,258 | `border-b/border-t border-neutral-100` (header / input-bar dividers) | 1 | REVIEW | Hairline dividers, no `dark:`; near-invisible/slightly wrong on dark. Low impact. |
| **apps/client/app/profile/terms.tsx** (`Screen bg="cuban"`) | | | | |
| terms.tsx:76 | `<Text ... style={{ color: '#334155', lineHeight: 22 }}>` (legal body paragraphs) | 2 | FIX | Slate-700 body text on the dark navy `cuban` bg (`#0A0E1A`) = dark-on-near-black, unreadable. Use `tokens.ink.primary`/`secondary`. |
| **apps/client/app/profile/privacy.tsx** (`Screen bg="cuban"`) | | | | |
| privacy.tsx:73 | `<Text ... style={{ color: '#334155', lineHeight: 22 }}>` (legal body paragraphs) | 2 | FIX | Same as terms.tsx — slate-700 text invisible on dark navy. Use a theme token. |
| **apps/client/app/profile/ride-preferences.tsx** (`<Screen>` → flips; cards via `<Card>` → flip) | | | | |
| ride-preferences.tsx:129,150,192,214,236 | `<Text className="text-base font-medium text-neutral-900">` | 1 | FIX | Near-black text, no `dark:`, inside `<Card>` whose bg flips to `dark:bg-neutral-800` → near-black-on-dark. Add `dark:text-neutral-100`. |
| ride-preferences.tsx:132,195,217,239,269 | `<Text className="text-sm text-neutral-500 ...">` (option descriptions) | 1 | REVIEW | Mid-gray, no `dark:`; low-contrast (not invisible) on dark Card. Pair with `dark:text-neutral-400`. |
| ride-preferences.tsx:164,253 | `selected ? 'bg-primary-50 ...' : 'bg-white border-neutral-200'` (temp / a11y option cards) | 1 | FIX | Unselected option pill `bg-white` no `dark:` → locked-white pill on a dark Card. Add `dark:bg-neutral-900 dark:border-neutral-700`. |
| ride-preferences.tsx:174,264 | `selected ? 'text-primary-...' : 'text-neutral-600/800'` (unselected option label) | 1 | REVIEW | Dark label text — matches the locked-white pill above; compounds the same bug. Fix together with the pill. |
| **apps/client/app/profile/ticket-detail.tsx** (`Screen bg="cuban"`) | | | | |
| ticket-detail.tsx:166 | `<View className="flex-row ... border-t border-neutral-100 bg-white">` (message input bar) | 1 | FIX | Input bar `bg-white` no `dark:` → locked white on dark `cuban` screen. Add `dark:bg-neutral-900`. |
| ticket-detail.tsx:185 | `<View className="px-4 py-3 border-t border-neutral-100 bg-neutral-50">` (closed-ticket bar) | 1 | FIX | Closed-state bar `bg-neutral-50` no `dark:` → locked light on dark screen. Add `dark:bg-neutral-900`. |
| ticket-detail.tsx:85 | `isOwn ? 'bg-primary-500' : item.is_admin ? 'bg-blue-100' : 'bg-neutral-100'` (chat bubbles) | 1 | REVIEW | Incoming/admin bubble bg locked light; `text-neutral-900` (line 95) matches it so it stays readable, but it is a locked-light island on a dark screen. |
| ticket-detail.tsx:130 | `border-b border-neutral-100` (header divider) | 1 | REVIEW | Hairline divider, no `dark:`. Low impact. |
| **apps/client/app/profile/corporate.tsx** (`Screen bg="cuban"`) | | | | |
| corporate.tsx:639 | `selected ? 'bg-primary-500 ...' : 'bg-neutral-50 border-neutral-200'` (allowed-service chip) | 1 | FIX | Unselected chip `bg-neutral-50` no `dark:`; its `<Text color="secondary">` flips to light → light-on-near-white. Add `dark:bg-neutral-800 dark:border-neutral-700`. |
| corporate.tsx:1002 | `newRole === role ? 'bg-primary-500/10 ...' : 'bg-neutral-50 border-neutral-200'` (role chip) | 1 | FIX | Same as :639 — unselected role chip locked light with light text in dark. |
| corporate.tsx:941 | `<Card variant="filled" ... className="mb-2 bg-neutral-50">` | 1 | REVIEW | Bare `bg-neutral-50` on a `filled` Card; the Card variant still supplies `dark:bg-neutral-800` so it flips, just loses the intended tint. Fragile but functional. |
| **apps/client/app/(tabs)/wallet.tsx** (`Screen bg="cuban"`; recharge sheet) | | | | |
| wallet.tsx:1569 | `<Text ... style={{ marginTop: 6, color: '#b45309', fontWeight: '600' }}>` (min-recharge warning) | 2 | FIX | Amber-700 text on `bg-neutral-50 dark:bg-neutral-800` — poor contrast on the dark `neutral-800` surface. Gate the color by theme (use a lighter amber in dark). |
| wallet.tsx:1581 | `<Text ... style={{ color: '#b45309' }}>` (stripe-not-ready note) | 2 | FIX | Amber-700 text on `bg-amber-50 dark:bg-amber-900/20` — low contrast on the dark amber tint. Use a lighter amber in dark. |
| **apps/client/src/components/OfflineBanner.tsx** (permanent amber/yellow banner) | | | | |
| OfflineBanner.tsx:119 | `<Text variant="caption" className="text-red-800 font-medium">` (retry counter) | 1 | FIX | `text-red-800` has no `dark:`; on the `bg-yellow-900/80` dark banner a dark-red counter is low-contrast. Add `dark:text-red-300`. |
| **apps/client/src/components/DriverProfileScreen.tsx** (theme-aware via `useTokens()`) | | | | |
| DriverProfileScreen.tsx:112 | `<Ionicons name="arrow-back" size={24} color="#1F2937" />` | 2 | FIX | Header back arrow hardcoded slate-800; the header bg is `tokens.bg.paper` which flips to dark navy → near-invisible arrow in dark. Use `tokens.ink.primary`. |
| DriverProfileScreen.tsx:139 | `<View style={{ ...backgroundColor: '#E5E7EB' }} />` (rating skeleton block) | 2 | REVIEW | Light-gray skeleton placeholder; transient, but stands out as a light box on a dark card. Consider `tokens.bg.elev2`. |
| DriverProfileScreen.tsx:188,246 | `<Ionicons ... color="#9CA3AF" />` (vehicle-placeholder car / report-flag icon) | 2 | REVIEW | Mid-gray icons sit on `tokens.bg.elev2` (dark in dark mode) — dim but visible. Borderline; a theme token would be cleaner. |
| DriverProfileScreen.tsx:290 | `color={i < review.rating ? '#F59E0B' : '#D1D5DB'}` (empty review star) | 2 | REVIEW | The unfilled-star `#D1D5DB` nearly disappears on a dark review card. Use a darker neutral in dark mode. |
| DriverProfileScreen.tsx:214,225,260 | `<Ionicons ... color="#0EA5E9" />`, `<ActivityIndicator color="#0EA5E9" />` (call/chat) | 2 | REVIEW | Sky-blue accent on a card surface; readable on both themes but not a theme token — borderline. |
| **apps/client/app/profile/support.tsx** (`Screen bg="cuban"`) | | | | |
| support.tsx:113 | `style={idx > 0 ? { borderTopWidth: 1, borderTopColor: '#f3f4f6' } : undefined}` (FAQ row divider) | 2 | REVIEW | Hardcoded light-gray divider inside a `Card` that flips to `dark:bg-neutral-800`; locked-light divider, low readability impact. |
| **apps/client/app/ride/dispute/[rideId].tsx** (theme-aware via `isDark`) | | | | |
| ride/dispute/[rideId].tsx:184 | `reason === r ? 'border-primary-500 ...' : 'border-neutral-300'` (radio ring) | 1 | REVIEW | Unselected radio border `border-neutral-300` no `dark:`; low-contrast light ring on the dark `cuban` bg. Minor. |
| **apps/client/src/components/SafetySheet.tsx** (renders inside the shared `BottomSheet`) | | | | |
| SafetySheet.tsx:203 | `<Pressable className="flex-row ... border-b border-neutral-100">` | 1 | REVIEW | Divider `border-neutral-100` no `dark:`. Within the (separately-broken) BottomSheet container — see Notes. |
| **apps/client/app/profile/recurring-rides.tsx** (theme-aware) | | | | |
| profile/recurring-rides.tsx:267 | `<Text className="text-xs font-medium text-red-600">` (delete label) | 1 | REVIEW | `text-red-600` no `dark:` on `bg-red-50 dark:bg-red-950`; mid-red on dark-red is acceptable but not paired. |

## Hotspot files

1. **apps/client/app/(tabs)/index.tsx** — 7 FIX. The native `NativeHomeScreen`
   flow views are theme-aware at the top level (`useTokens()`), but three large
   panels are hardcoded white and never flip: the `initialLoading` skeleton,
   the fullscreen address-search panel (`SelectingView`, line 3178), and the
   `SelectingView` services/payment bottom panel (line 3246) together with all
   its descendant cards/inputs. `ReviewingView`'s recommended-service card
   (3682) is also locked white.
2. **apps/client/app/profile/ride-preferences.tsx** — ~7 FIX/REVIEW. Uses bare
   `text-neutral-900` / `text-neutral-500` / `bg-white border-neutral-200`
   throughout, with zero `dark:` variants, while sitting inside `<Card>`s that
   DO flip — the classic dark-text-on-dark-card failure.
3. **apps/client/app/profile/ticket-detail.tsx** — 2 FIX + 2 REVIEW (locked
   `bg-white`/`bg-neutral-50` bars + chat bubbles).
4. **apps/client/app/profile/corporate.tsx** — 2 FIX (unselected chips
   `bg-neutral-50` with light text in dark).
5. **apps/client/app/chat/[rideId].tsx** — 2 FIX (incoming bubble + message
   input locked light).

## Notes

### Systemic root cause #1 — `packages/ui/src/BottomSheet.tsx` is locked light (OUT OF SCOPE)
The shared `BottomSheet` component renders its content surface with a bare
`bg-white` and a `bg-neutral-300` handle — **no `dark:` variant**
(`packages/ui/src/BottomSheet.tsx:33,36`). Every client screen that mounts a
`BottomSheet` therefore shows a pure-white sheet in dark mode:
`SafetySheet`, `FareSplitSheet`, `CreateRecurringRideSheet`,
`EditRecurringRideSheet`, `CancelRideSheet`, `AddContactSheet`, and the create-
ticket sheet in `profile/help.tsx`. This file is in `packages/ui`, outside the
audited scope, so it is reported here as a note rather than a finding row.
Consequence for the audit: the recurring-ride sheets
(`CreateRecurringRideSheet`, `EditRecurringRideSheet`) and the `help.tsx` /
`saved-locations.tsx` sheet bodies use bare `bg-neutral-50/100`, `bg-primary-50`,
`text-neutral-500/600`, `border-neutral-200` with no `dark:` variants — those
are genuinely locked-to-light (Class 1), but they currently stay *internally
consistent* with their (also-locked-white) container. Fixing them in isolation
without first fixing `BottomSheet` would actually break them. They are marked
REVIEW for that reason; the correct fix order is BottomSheet first, then the
sheet bodies.

### Systemic root cause #2 — web render paths have no dark mode at all
`apps/client` ships separate web-only render paths that use raw
`<div>/<span>/<h1>` with inline styles. NativeWind `dark:` does not apply to
inline styles, and these components have **zero** `useColorScheme`/`isDark`
handling:
- `(tabs)/index.tsx` → `WebHomeScreen` / `WebSearchingState` (lines ~166–1564)
- `(tabs)/rides.tsx` → `WebRidesScreen` (lines ~78–394)
- `src/components/WebActiveRideView.tsx`
- `src/components/WebAddressInput.tsx`
Every hex color in those blocks (`#1a1a1a`, `#fff`, `#999`, `#9ca3af`,
`#6b7280`, `#e5e5e5`, …) is locked to a light palette. This is ~200+ of the raw
grep hits. They are NOT enumerated as individual findings because it is one
architectural gap ("the web build has no dark theme"), not per-line bugs — the
fix is a single decision (add a web dark theme, or accept web is light-only),
not 200 edits. The corresponding **native** paths (`NativeHomeScreen`,
`NativeRidesScreen`, `RideActiveView`, `AddressSearchInput`) are all properly
theme-aware.

### Map overlays are intentionally fixed — KEEP
The client map always uses `MAP_STYLE_LIGHT` (confirmed in
`PoiMapLayers.tsx:149-153`, `RideMapView`, `ConfirmLocationScreen`,
`SavedLocationsMapWeb`). White marker outlines, white floating cards / FABs and
POI label colors sitting *on the map* are deliberately light regardless of app
theme and read correctly against the light map tiles. This covers
`RideMapView`, `SearchingDriverMarkers`, `PoiMapLayers`, `ConfirmLocationScreen`
pins, `WebMapView` markers, `SavedLocationsMapWeb`, and the floating "Ir aquí" /
address-summary cards in `index.tsx`'s `SelectingView` (lines 3095, 3143, 3148,
3168) — all KEEP.

### Permanently-colored surfaces — KEEP
White text/icons on the brand-orange gradient or `colors.brand.orange`
buttons/avatars/badges (`login.tsx` hero, `wallet.tsx` balance card,
`AcceptedDriverCard`, `DemoBanner`, `AnimatedSplash`, `TripActionBar` badge,
`DriverInfoMiniCard` badges, every `bg-primary-500` selected chip / `text-white`
pair), white on the permanently-colored status banners (`ArrivalCard` green,
`ArrivalBanner` / `ProximityBanner` sky/violet, `SafetySheet` red SOS,
`RideActiveView` SOS, chat offline `bg-red-500`), and the semantic
amber/green/red status surfaces (`index.tsx` surge banner `#FEF3C7`/`#92400E`,
error banner `bg-red-50`, `cancelRideSheet` fee banners, success `bg-green-100`
icon circles) are all intentionally fixed and were classified KEEP.

### Correctly theme-aware files (no findings)
`AddressSearchInput`, `DriverInfoMiniCard`, `OnboardingOverlay`,
`ConfirmLocationScreen`, `TripActionBar`, `CancelRideSheet`, `notifications/index.tsx`
(`buildIconMap(isDark)`), `ride/lost-item/[rideId].tsx`, `safety.tsx`,
`trusted-contacts.tsx`, `recurring-rides.tsx`, `RideActiveView`,
`RideCompleteView`, all three auth screens, `(tabs)/profile.tsx`, `about.tsx`,
`edit.tsx`, `emergency-contact.tsx`, `blog.tsx`, and all `_layout.tsx` files
either gate every hex literal with `isDark`/`useTokens()` or pair every
NativeWind color class with a `dark:` variant. `shadowColor:'#000'` /
`'#1A1414'` everywhere is a shadow color (or already gated to light-only) — not
a readability concern.
