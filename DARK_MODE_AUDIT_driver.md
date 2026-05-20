# driver — Dark Mode Contrast Audit

## Summary

- Files scanned: 99 `.tsx` files under `apps/driver/app` (51) and `apps/driver/src` (48). Files with findings: 4.
- FIX: 1  |  KEEP: (all other color usages — see Notes)  |  REVIEW: 3

The driver app is **not** a normal theme-flipping app. It is built as two
locked single-mode surfaces:

- **Map / nav / auth / onboarding screens** — permanently DARK by design
  (`Screen bg="dark"` / `bg="mapDark"`, `DraggableSheet theme="dark"`,
  `Card forceDark`/`theme="dark"`, the `midnightEmber.map.*` token tree).
- **Standard screens** (earnings, wallet, trips, profile + all `/profile/*`,
  `/trip/*`, notifications, chat) — permanently LIGHT by design
  (`Screen bg="lightPrimary"` → `bg-[#F8FAFC]` with NO `dark:` sibling,
  `Card theme="light"`, the `midnightEmber.screen.*` light token tree).

Almost every hardcoded color / bare class in the app is therefore an
*intentional* lock that is internally consistent with the locked-mode
surface it sits on (e.g. white text on a permanently-dark map sheet, or
`midnightEmber.screen.text.primary` dark text on a permanently-light
earnings screen). Those are all KEEP. Genuine findings only arise where
an element's lock direction **mismatches** the surface it sits on.

## Findings

A markdown table of every genuine finding. Color usages that are
intentional locks consistent with their locked-mode surface are NOT
listed individually (there are hundreds — see Notes for the rule applied).

| File:line | Current code | Class | Verdict | Proposed fix |
|---|---|---|---|---|
| `apps/driver/src/components/ExcessDistanceSheet.tsx:111` | ``className={`flex-row items-center px-4 py-3 mb-2 rounded-2xl ${isSelected ? 'bg-orange-50 border-2 border-orange-500' : 'bg-neutral-50 border border-neutral-200'}`}`` | Class 1 | FIX | The reason rows render inside `TripCompleteView`'s always-dark `DraggableSheet theme="dark"`. `bg-neutral-50` (near-white) + `bg-orange-50` (near-white orange) + `border-neutral-200` are locked-LIGHT surfaces sitting on an always-DARK sheet — a cluster of light-gray cards floating on a dark surface, harsh mismatch. The header card just above them correctly uses `Card theme="dark"`. Fix: use `midnightEmber.map.bg.surface` / `midnightEmber.map.bg.elevated` for the row background and `midnightEmber.accent.glow` + `midnightEmber.accent[500]` for the selected state, matching the surrounding always-dark sheet (same pattern as `RiderRatingSheet` / `DeliveryPhotoSheet` which use `Card forceDark`). |
| `apps/driver/src/components/ExcessDistanceSheet.tsx:116,118` | `<Text variant="body" color="primary" ...>` (the reason label) — `color="primary"` resolves to `text-neutral-950 dark:text-neutral-50` | Class 1 (consequential) | REVIEW | Consequence of the row above. With the rows fixed to dark surfaces, the `color="primary"` labels need to read as light text on dark — switch to `style={{ color: midnightEmber.map.text.primary }}` so the label is light on the dark row. Only relevant once the row background is fixed; flagged so the fix is done as a pair. |
| `apps/driver/app/(tabs)/_layout.tsx:28-29` | `tabBarStyle: { ... backgroundColor: '#141418', borderTopColor: 'rgba(255,255,255,0.06)', ... }` (+ web `backgroundColor: 'rgba(20,20,24,0.92)'` line 35) | Class 2 | REVIEW | The bottom tab bar is permanently DARK (`#141418`, white-on-dark hairline border). It is the persistent nav chrome for the Earnings / Wallet / Trips / Profile tabs — all of which are permanently-LIGHT screens (`Screen bg="lightPrimary"`). A fixed-dark tab bar sitting under fixed-light content screens is a jarring fixed mismatch. Could be a deliberate "Uber-style dark tab bar" choice — needs a design call. If intended to match the screens, derive the bar background from `midnightEmber.screen.bg.surface` + `screen.line.default`. |
| `apps/driver/app/+not-found.tsx:8` | `<View className="flex-1 items-center justify-center bg-neutral-950">` | Class 1 | REVIEW | 404 route has no `Screen` wrapper; `bg-neutral-950` is a bare class with no `dark:` sibling, so the screen is locked near-black with `<Text color="inverse">` (white) on top. Internally consistent and readable, but it ignores light mode entirely while every other non-map screen in the app is light — visually inconsistent. Proper pattern: `bg-white dark:bg-neutral-950` and `<Text color="primary">` instead of `color="inverse"`. Low priority (rarely-seen route). |
| `apps/driver/app/profile/help.tsx:237,247` | `<TextInput className="border border-neutral-200 rounded-lg p-3 ... text-neutral-900" .../>` | Class 1 | REVIEW | The two ticket-creation `TextInput`s use a bare `text-neutral-900` (dark text, no `dark:` sibling) with **no `bg-` class**, so the input background is whatever the surrounding `<BottomSheet>` (`packages/ui`, out of scope) provides. Unlike the dispute/lost-item inputs — which lock both surface and text together with `text-neutral-900 bg-white` — these only lock the text. If `BottomSheet` ever renders a dark background, `text-neutral-900` becomes dark-on-dark and the typed text disappears. Safe fix regardless: pair it — `text-neutral-900 dark:text-neutral-100` (or read `midnightEmber.screen.text.primary` via `placeholderTextColor`/`style`). |

## Hotspot files

- `apps/driver/src/components/ExcessDistanceSheet.tsx` — the only file with a true **FIX**: light-locked reason rows on an always-dark sheet (2 related lines).
- No other file has more than one finding. The driver app is, overall, very disciplined: the `midnightEmber` token system (see `packages/theme/src/midnight-ember.ts`) was rolled out across the trip flow (PR-A/B/C), earnings, onboarding and home, eliminating inline hex literals in those areas.

## Notes

### Systemic pattern (the rule applied to triage every candidate)

The grep surfaced ~217 hex literals + ~62 bare `text-*`/`bg-*` classes
across ~45 files. The overwhelming majority are **intentional, consistent
locks** and were triaged KEEP:

1. **Always-dark surfaces** — `apps/driver/app/(tabs)/index.tsx` (home
   map), `(auth)/login.tsx`, `(auth)/verify-otp.tsx`, all `onboarding/*`,
   all `wallet/*` sub-screens, `chat/[rideId].tsx`, and the trip-flow
   components (`DriverTripView`, `IncomingRideCard`, `TripCompleteView`,
   `RouteInfoCard`, `TripStepper`, `TripActionToolbar`, `WaitTimer`,
   `TripBadgesRow`, `LiveDistanceHint`, `GpsConsentBanner`,
   `DeliveryDetailsCard`, `RiderPreferencesChips`, `NavigationOverlay`,
   `HomeBottomSheet`, `AddressSearchBar`, `RideMapView`,
   `DeliveryPhotoSheet`, `RiderRatingSheet`) all use `Screen bg="dark"` /
   `DraggableSheet theme="dark"` / `Card forceDark` and `midnightEmber.map.*`
   (or matching hex). White / light text on these is correct by design.
   The audit brief explicitly calls map/nav screens "intentionally always
   dark" — KEEP.

2. **Always-light surfaces** — `(tabs)/earnings.tsx`, `(tabs)/wallet.tsx`,
   `(tabs)/trips.tsx`, `(tabs)/profile.tsx`, every `profile/*` screen,
   `notifications/index.tsx`, all `trip/*` non-map screens, and their
   components (all `earnings/*`, `settings/*`, `profile/ReviewTagsBreakdown`,
   `EarningsBarChart`, `HourlyHeatmap`, `EarningsByZoneChart`) use
   `Screen bg="lightPrimary"` (locked `bg-[#F8FAFC]`), `Card theme="light"`,
   and `midnightEmber.screen.*` (the light token tree) or `colors.neutral.*`.
   Dark text on these light screens is correct by design — KEEP.

3. **Semantic / brand colors** — status colors (green/amber/red:
   `#22C55E`, `#F59E0B`, `#EF4444` and `midnightEmber.state.*`), brand
   orange (`#FF4D00` / `colors.brand.orange` / `midnightEmber.accent.*`),
   per-vehicle-type accent colors (`#F97316`/`#3B82F6`/`#22C55E`/`#A855F7`
   in `vehicle-info.tsx` & `edit-vehicle.tsx`), map-marker colors
   (`MAP_COLORS.*`, `white` pin borders), surge-zone colors, demand-hotspot
   `hsl()` intensity colors, and white-on-orange button text. Theme-
   independent by intent — KEEP.

4. **Alpha-suffix concatenations** — many `#[0-9a-fA-F]{3,8}` grep hits are
   `` `${midnightEmber.state.info}1F` `` style tint expressions, not
   standalone literals. Not bugs.

5. **Correctly-paired `dark:` classes** — `FleetMembersList.tsx` and
   `FleetRequestForm.tsx` use `bg-white dark:bg-neutral-800`,
   `bg-primary-50 dark:bg-primary-900/20`,
   `border-neutral-100 dark:border-neutral-800` etc. The grep flagged the
   bare `bg-white` token, but each has a `dark:` sibling — this is the
   CORRECT pattern, not a Class 1 bug. (Note: these two components render
   inside `corporate.tsx`, a locked-light screen, so their `dark:` variants
   would never actually fire — harmless, but see the architectural note
   below.)

### Architectural observation (broader than this audit's scope)

The driver app drives NativeWind's `dark:` variant from the OS/manual
toggle (`apps/driver/app/_layout.tsx` calls `setColorScheme(resolvedScheme)`),
yet builds every screen with a **fixed** `Screen bg` variant
(`lightPrimary` / `dark` / `mapDark` — none of which have a `dark:`
counterpart in `packages/ui/src/Screen.tsx`). The shared `<Text>`, `<Card>`,
`<MenuRow>` components DO honor `dark:`. The app papers over this by
passing `Card theme="light"` / `theme="dark"` / `forceDark` everywhere and
overriding `<Text>` colors with explicit `style={{ color: midnightEmber.* }}`.
The result: a manual dark-mode toggle in `profile/settings.tsx` exists, but
toggling it has essentially no effect on the locked-mode screens — the
`dark:` variant is never meaningfully exercised. This is a deliberate
design (see `packages/theme/src/midnight-ember.ts` header comment), but it
means the few places that *don't* explicitly lock both surface and text
(e.g. `help.tsx` `TextInput`s, `+not-found.tsx`) are latent bugs if the
shared `dark:`-aware components ever flip underneath them. Worth a
follow-up decision: either remove the dead manual toggle, or commit to
real theme-flipping with paired `dark:` classes throughout.

### Intentionally-always-dark screens identified

`(tabs)/index.tsx` (home map), all of `onboarding/*`, `(auth)/login.tsx`,
`(auth)/verify-otp.tsx`, all `wallet/*`, and the entire trip-flow component
tree rendered inside `DraggableSheet theme="dark"`. These were carefully
excluded from FIX verdicts — they are dark by design, not by bug.
