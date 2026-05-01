# iOS App Store Compliance — TriciGo Client + Driver

**Last updated:** 2026-04-30
**Status:** P0 issues fixed. P1/P2 tracked below.

This document tracks compliance with Apple App Store Review Guidelines and Human Interface Guidelines. Refer to it before any App Store submission.

## Summary of changes (Phase 4)

### Fixed in this pass

- ✅ **P0 — Missing privacy strings** added to `apps/client/app.json` and `apps/driver/app.json`:
  - `NSPhotoLibraryUsageDescription` (avatar + driver doc upload)
  - `NSCameraUsageDescription` (avatar + driver doc scan)
  - `NSContactsUsageDescription` (client only — trusted contacts feature)
  - `NSUserTrackingUsageDescription` (analytics — kept for future ATT integration)
- ✅ **P1 — Vague location strings** rewritten with specific use cases (when, why, what changes if denied).
- ✅ **P1 — Background location justification** (driver) — `NSLocationAlwaysAndWhenInUseUsageDescription` now explains the active-trip tracking + passenger visibility requirement.

### Verified compliant (no change needed)

- ✅ `EXPO_PUBLIC_DEMO_MODE` strict comparison (`=== 'true'`) in `apps/client/src/config/demo.ts:12` — accidentally setting to `'1'` / `'yes'` doesn't activate demo. CI workflow only sets it for `-demo-apk` tags.
- ✅ PostHog `autocapture={false}` in `apps/client/src/providers/app-providers.tsx:102` — privacy-friendly default.
- ✅ Sentry `sendDefaultPii: false` in `apps/client/src/lib/sentry.ts` — no PII captured.
- ✅ All `Alert.alert(...)` calls use `t('...', { defaultValue })` i18n pattern. No hardcoded English strings.
- ✅ Touch targets: SOS button 56pt, MenuRow ≥44pt, dial picker pad ≥44pt — spot checks pass.

## Remaining items (DO before App Store submission)

### P1 — Required before submission

1. **App Tracking Transparency (ATT) prompt for analytics**
   - **Action**: install `expo-tracking-transparency`, prompt at app startup BEFORE PostHog initializes, gate PostHog `apiKey` on consent.
   - **Risk if skipped**: automatic rejection if Apple's reviewer detects IDFA fingerprinting via PostHog without ATT prompt.
   - **Estimated work**: 30 min.

2. **"Continue as guest" / browse-without-login on welcome screen**
   - **Issue**: `apps/client/app/(auth)/login.tsx` requires phone OTP before showing any app content.
   - **Apple's stance** (Guideline 5.1.1 v): "If your app doesn't include significant account-based features, let people use it without a login."
   - **Options**:
     - (a) Allow browsing the home (map, services, promos, blog) without login. Login required only at "Pedir viaje".
     - (b) Add a "Saltar" (Skip) link on welcome that goes to a limited-feature mode.
   - **Estimated work**: 2-4h.

3. **Demo banner removal in production builds**
   - **Status**: workflow already gates `EXPO_PUBLIC_DEMO_MODE=true` to `-demo-apk` tags only. Production tags `client-v*-apk` (no `-demo-apk`) build without demo banner.
   - **Action**: verify by inspecting a production build before App Store submission. Take screenshots; demo banner MUST NOT appear.
   - **Estimated work**: 5 min verification.

4. **NSCalendarsUsageDescription removal** (if present)
   - **Status**: not currently in either app.json. ✓ No action needed.

### P2 — Polish (nice-to-have)

5. **Dynamic Type support audit**
   - Custom font sizes (`fontSize: 14` etc) don't scale with iOS Dynamic Type. Use `PixelRatio.getFontScale()` or migrate to `Text` variants which can be made scalable.
   - **Estimated work**: 4-6h.

6. **VoiceOver / accessibility labels audit**
   - Spot-check passes (icon-only buttons have `accessibilityLabel`). Full audit recommended.
   - **Estimated work**: 2-3h.

7. **Safe area handling on map screens**
   - `ConfirmLocationScreen` and `RideMapView` should explicitly handle Dynamic Island / notch insets for floating buttons.
   - **Estimated work**: 1-2h.

8. **Modal presentation styles**
   - iOS prefers `pageSheet` for secondary modals. Currently using `Modal` with `animationType="slide"` (full-screen). Consider migrating to `BottomSheet` for recharge / transfer / dial picker.
   - **Estimated work**: 3-4h.

9. **Proper App Privacy nutrition labels**
   - Before submission, fill out "App Privacy" in App Store Connect:
     - Data collected: name, phone, location, payment info (Stripe), analytics (PostHog).
     - Data linked to user: yes (account-bound).
     - Tracking: only if PostHog uses IDFA — see item #1.
   - **Estimated work**: 30 min.

10. **In-app review prompt**
    - Implement `expo-store-review` prompt after first 3 successful rides. Apple HIG recommends this.
    - **Estimated work**: 1h.

## Pre-submission checklist

Before sending to App Store Review:

- [ ] All P1 items above resolved
- [ ] Production build (no demo banner, no debug logs)
- [ ] App icon: 1024×1024 PNG without transparency
- [ ] Launch screen tested on multiple device sizes
- [ ] Dark mode tested on iPhone 15 Pro / iPhone 15 Pro Max simulator
- [ ] Dynamic Type tested at largest accessibility size
- [ ] VoiceOver tested for: login, home, ride flow
- [ ] All localized strings present (es / en at minimum)
- [ ] App Store Connect "App Privacy" filled out
- [ ] Review notes mention: ride-hailing service in Cuba, demo coords for Apple reviewer if needed
- [ ] Test account credentials provided in review notes
- [ ] Privacy policy URL live at `tricigo.com/privacy`
- [ ] Terms of service URL live at `tricigo.com/terms`

## References

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [App Tracking Transparency](https://developer.apple.com/documentation/apptrackingtransparency)
