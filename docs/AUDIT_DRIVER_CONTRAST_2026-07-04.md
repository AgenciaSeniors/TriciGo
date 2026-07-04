# Driver App — Color-Contrast & Visibility Audit (2026-07-04)

## Why

A driver reported that on the onboarding phone-code verification step the **"Cambiar número"** (change number) button was **invisible** due to color contrast, and that the same class of error appeared elsewhere in the driver app. This audit maps the root cause, fixes the visibility bugs, and records the canonical rule so the class doesn't reappear.

**Scope of this pass (chosen with the user):** invisible buttons **+** clearly-faint text/icons. **Not** in scope: raising shared theme tokens (placeholder / secondary / tertiary) — that ripples into `packages/ui` and the passenger app and needs a broader test/rebuild. See _Deferred_ below.

## Root cause (verified)

`packages/ui/src/Button.tsx` exposes a `forceDark` prop. The `ghost` variant **without** `forceDark` uses `text-neutral-900 dark:text-neutral-100`:

- `text-neutral-900` = `#171717` (near-black) — applied when NativeWind's color scheme is **light**
- `dark:text-neutral-100` = `#F0F0F0` (light) — applied only when the scheme is **dark**

The driver app is `darkMode: 'class'` (`apps/driver/tailwind.config.js`) and sets the scheme with `setColorScheme(resolvedScheme)` in `apps/driver/app/_layout.tsx:128`. **Crucially, the driver app hard-pins NativeWind to `light` by default** — `createThemeStore('light')` (`apps/driver/src/stores/theme.store.ts:15`), with the explicit comment _"Driver app uses forced dark backgrounds (Screen bg='dark') with light NativeWind so that color='inverse' gives white text on dark bg."_ A driver only leaves light-NativeWind by manually enabling dark mode in settings (rare).

**Consequence:** Tailwind `dark:` variants essentially **never fire**, and `useColorScheme()`/`isDark` returns `light`/`false` by default. **But many modals, sheets and screens paint a _fixed_ dark surface** (`Screen bg="dark"` → `#0d0d1a`, `bg="mapDark"` → `#0a0a0f`, inline `midnightEmber.map.bg.*` like `#11172A`, `Card theme="dark"`/`forceDark` → `#1a1a2e`). On those, any foreground whose color resolves **dark** in light-NativeWind is invisible/low-contrast. This is the **default experience for every driver**, not a mode-conditional edge case.

- Ghost button text = `text-neutral-900` (#171717) → on `#11172A` ≈ **1.03:1 → invisible**. `forceDark` → `text-white` → ≈ **18:1 → visible**. The twin screen `verify-otp.tsx:192` already used `forceDark`; the onboarding OTP modal had omitted it — the reported bug.
- `<Text>` color prop resolves the same way: `primary`=`#0a0a0a`, `secondary`=`#525252`, `muted`=`#737373` are all **dark** in light-NativeWind → invisible/low-contrast on fixed-dark surfaces. Correct convention on dark: `color="inverse"` (white) for titles, `midnightEmber.map.text.secondary` (#B7C4CF) for secondary text.

**Verification of the fix (multi-agent deep audit, 37 agents):** confirmed `fixResolvesReportedBug: true` by exact color trace, and all 6 initial changes regression-checked in **both** states (default light + manually-toggled dark) → `regresses: false`.

## Canonical rule

> **A `ghost`/`outline` `<Button>` rendered on a _fixed_ dark surface (via inline style / `midnightEmber` token / `Screen bg="dark"`) MUST pass `forceDark`.**
>
> Do **NOT** add `forceDark` when the surface is **theme-driven** (`bg={isDark ? 'dark' : 'white'}`, `bg-white dark:bg-neutral-900`, etc.). There the surface and the button text move together with the scheme, so they already stay consistent — forcing white text would make it invisible on the light surface. When such a surface needs correct pressed-state polish on dark, use `forceDark={isDark}` (conditional), not bare `forceDark`.

`ghost` text is near-black in light scheme → it is the variant that goes **invisible**. `outline` text is orange (`text-primary-500`) → always visible; only its pressed-tint differs, a much lower-severity concern.

## Findings & status

### Fix A — ghost buttons on fixed dark surfaces missing `forceDark` (FIXED)

| File | Line | Button | Surface | Status |
|---|---|---|---|---|
| `apps/driver/app/onboarding/personal-info.tsx` | 843 | **Cambiar número** ← reported | modal `#11172A` (fixed) | ✅ added `forceDark` |
| `apps/driver/app/onboarding/personal-info.tsx` | 835 | Reenviar código | modal `#11172A` (fixed) | ✅ added `forceDark` |
| `apps/driver/app/wallet/recharge.tsx` | 416 | Hacer otra recarga | `Screen bg="dark"` (fixed) | ✅ added `forceDark` |

### Fix B — faint text/icons below threshold (FIXED)

WCAG target: text ≥4.5:1, non-text UI glyph ≥3:1. Ratios computed against the real surface.

| File | Element | Before → After | Ratio (approx) | Status |
|---|---|---|---|---|
| `apps/driver/src/components/chat/ChatBubble.tsx` | other-message timestamp (dark) | `rgba(255,255,255,0.35)` → `0.6` on `#1c1c24` | 2.97 → ~6.5 | ✅ |
| `apps/driver/src/components/chat/ChatBubble.tsx` | own-message timestamp | `rgba(255,255,255,0.6)` → `0.85` on `#FF4D00` | 2.07 → ~2.7 (bright-bubble limit) | ✅ |
| `apps/driver/src/components/chat/ChatBubble.tsx` | unread check (single) | `rgba(255,255,255,0.4)` → `0.8` on `#FF4D00` | 1.38 → ~3.4 | ✅ |
| `apps/driver/src/components/chat/ChatBubble.tsx` | read check (double) | `#60A5FA` → `#BFDBFE` on `#FF4D00` | 1.4 → ~2.5 (kept blue semantic, lighter) | ✅ |
| `apps/driver/src/components/LanguageSwitcher.tsx` | dropdown chevron | `rgba(255,255,255,0.4)` size 10 → `0.7` size 12 on `#1a1a2e` | ~3.4 → ~5 | ✅ |
| `apps/driver/app/(tabs)/profile.tsx` | menu-row chevron (light mode) | `palette.ink.subtle` (`#A9B4BC`) → `palette.ink.secondary` (`#6B7F8F`) on cream `#FFFBF5` | 1.94 → ~4.1 | ✅ per-usage color, no token change |

Notes: the orange own-bubble is a bright surface — a legible 11px timestamp there tops out around ~2.7:1 without going pure-white/heavy; the bump from 2.07 is a real improvement and matches common chat-bubble practice. `Button`'s global disabled `opacity-50` (`Button.tsx:87`) is left untouched (dimming a disabled control is the correct affordance, and the value is shared across apps).

### Verified false positives (NO change — flagged by the sweep, but actually compliant)

| File | Element | Why it's fine |
|---|---|---|
| `apps/driver/app/onboarding/personal-info.tsx:55` | form label `color="inverse"` + `opacity-70` | white@70% over a near-black screen ≈ **#B5B5B5 → ~9:1**. Passes. |
| `apps/driver/app/(auth)/verify-otp.tsx:157` | OTP subtitle `color="inverse"` + `opacity-60` | white@60% over dark ≈ **~7:1**. Passes. |
| `apps/driver/src/components/NotificationPermissionSheet.tsx:174` | "Ahora no" ghost button | sheet is `bg-white dark:bg-neutral-900` (**theme-driven**) → surface + text track the scheme together; adding `forceDark` would break light mode. Correct as-is. |

Lesson: opacity-reduced **white** text over a **dark screen** stays high-contrast (white dominates the blend). The visibility failures cluster where the base is a **mid-tone surface** (chat bubbles `#1c1c24` / orange `#FF4D00`) or where a **near-black** color sits on a **fixed dark** surface (ghost buttons). Always compute against the real surface before changing.

### Round 2 — deep audit: `<Text>` (dark) on fixed-dark surfaces (FIXED)

The deep audit (5-lens sweep + adversarial verification, 37 agents) found the same root cause spread far
beyond buttons: **`<Text color="secondary"|"primary"|"muted">` on fixed-dark surfaces** renders a dark gray
in light-NativeWind → invisible/low-contrast. **30 candidates → 30 CONFIRMED, 0 false positives** (the adversarial
pass correctly excluded `color="tertiary"` = #A3A3A3 ≈ 5.6:1, which passes). Applying the canonical fix and its
in-file siblings produced **45 edits across 10 files**, all type-checked green.

Canonical fix applied per site (presentational only, driver-scoped, no shared-token changes):
- title / `color="primary"` on dark → `color="inverse"` (white)
- `color="secondary"`/`"muted"` on dark → `style={{ color: midnightEmber.map.text.secondary }}` (#B7C4CF, ~9:1, keeps hierarchy)
- `color="tertiary"`, `color="inverse"`, `color="accent"`, and text on light/theme-driven surfaces → left untouched

| File | Edits | Worst before | Notes |
|---|---|---|---|
| `apps/driver/src/components/ExcessDistanceSheet.tsx` | 2 | h3 title #0a0a0a on #1a1a2e = **1.18:1** | author had fixed the reason labels but forgot the title/summary |
| `apps/driver/src/components/DeliveryPhotoSheet.tsx` | 4 | secondary #525252 on #1a1a2e ≈ 2.2:1 | delivery recipient info / OTP hints |
| `apps/driver/app/onboarding/personal-info.tsx` | 5 | #525252 on #11172A ≈ 1.5:1 | form hints (incl. the OTP-modal subtitle @797); dropped stale `opacity-50/60` |
| `apps/driver/app/onboarding/review.tsx` | 8 | #525252 on #1a1a2e ≈ 2.2:1 | summary labels + phone/email/vehicle values |
| `apps/driver/app/onboarding/documents.tsx` | 3 | #525252 ≈ 2.1:1 | doc hints + "optional" badge |
| `apps/driver/app/onboarding/vehicle-info.tsx` | 3 | #525252 ≈ 2.2:1 | cargo dimension/category captions |
| `apps/driver/app/onboarding/pending.tsx` | 1 | #525252 on #11172A ≈ 1.6:1 | referral-pending hint |
| `apps/driver/app/wallet/recharge.tsx` | 6 | #525252 ≈ 2.1:1 | fee breakdown + notices (money the driver must read) |
| `apps/driver/app/refer/[code].tsx` | 3 | #525252 on #0d0d1a ≈ 2.5:1 | referral landing + loading label |
| `apps/driver/app/(auth)/login.tsx` | ~25 | #525252 on #0d0d1a ≈ 2.5:1 | phone subtitle + the entire in-app Terms/Privacy legal modal (every paragraph) |

**Verified false positives** (correctly NOT changed): `color="tertiary"` texts (≈5.6:1), any `color="inverse"` sibling,
`color="accent"` (orange links), and text on theme-driven/light surfaces.

### Deferred (out of scope — future pass)

- `packages/ui/src/Input.tsx` dark placeholder `#737373` on `#141418` (~2.5:1) — shared token, affects passenger app.
- `packages/ui/src/Text.tsx` `tertiary` (`#8a8a8a`) / `secondary` on dark — shared, broad ripple.
- `outline` buttons' pressed-tint on dark screens (`active:bg-primary-50` flashes light). `outline` text is always visible so no invisibility bug; use `forceDark={isDark}` on those buttons if/when polishing pressed states. Sites: `trips.tsx:609`, `pricing.tsx:283`, `gift.tsx:238/329`, `documents.tsx:268`, `trusted-contacts.tsx:182` (all theme-driven `bg={isDark?'dark':'white'}`); `lost-item/[id].tsx:205` is on a fixed **light** surface (leave). `referral.tsx:194` sits by a `variant="light"` input (inner light card) — verify surface before touching.

## Verification

- `pnpm check-types` (turbo, 4 apps) — green (changes are props/style values, low type risk).
- Contrast reasoning documented per element above.
- Closing grep: no `ghost` `<Button>` on a fixed dark surface remains without `forceDark`.
- Visual: mobile changes → require a **dev-client / APK rebuild** to see on device. Fast repro of the original bug: set the driver app to **light mode** (so NativeWind `dark:` turns off), open the onboarding OTP modal → before: buttons invisible; after: white and legible.
