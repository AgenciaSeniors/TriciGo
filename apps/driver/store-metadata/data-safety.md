# Google Play Data Safety Form — TriciGo Conductor

> Pegar/seleccionar respuestas en Play Console → Policy and programs → App content → Data safety. Debe coincidir con la Privacy Policy y con `PrivacyInfo.xcprivacy`.

---

## 1. Overview

| Question | Answer |
|---|---|
| Does your app collect or share user data? | **Yes** |
| Encrypted in transit? | **Yes** (HTTPS / TLS 1.2+) |
| User can request deletion? | **Yes** (Settings → Eliminar cuenta in-app, or via public URL `https://tricigo.com/account/delete`). Immediate hard-delete: account, driver profile, KYC documents (carné, licencia, vehículo, selfie) and avatar are removed from storage; historical rides, ratings and financial transactions are anonymized (re-pointed to an anonymous user) and retained for AML audit. |

---

## 2. Data types collected

### Location

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Approximate location | ✅ Yes | ❌ No | ✅ Optional | App functionality |
| Precise location | ✅ Yes | ✅ Shared with active passenger only during a trip | ❌ Required when online | App functionality, Real-time tracking |

**Background location**: yes, but only during active trips. See "Background Location declaration form" (separate Play Console section, mandatory for ride-sharing).

### Personal info

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Name | ✅ Yes | ✅ Shown to passengers during trip | ❌ Required | Account management, App functionality, Trust & safety |
| Email address | ✅ Yes | ❌ No | ✅ Optional | Account management |
| User IDs | ✅ Yes | ❌ No | ❌ Required | Account management |
| Address | ✅ Yes (residence for service area) | ❌ No | ❌ Required for verification | App functionality, Account management |
| Phone number | ✅ Yes | ✅ Shown to passenger during trip | ❌ Required | Account management, Trust & safety |
| Identity number | ✅ Yes (national ID for KYC) | ❌ No | ❌ Required for verification | Compliance, Fraud prevention |

### Financial info

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| User payment info | ❌ No (driver does not pay; receives via internal wallet) | — | — | — |
| Purchase history | ❌ No | — | — | — |
| Other financial info | ✅ Yes (earnings ledger, internal wallet balance in CUP) | ❌ No | ❌ Required | App functionality |

### Photos and videos

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Photos | ✅ Yes (avatar + vehicle docs + identity verification photos) | ❌ No (admin-reviewed only) | ❌ Required for verification | Account management, Compliance |

### App activity

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| App interactions | ✅ Yes (PostHog events, autocapture off) | ❌ No | ❌ Required | Analytics, App functionality |
| In-app search history | ❌ No | — | — | — |

### App info and performance

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Crash logs | ✅ Yes (Sentry) | ❌ No | ❌ Required | App functionality |
| Diagnostics | ✅ Yes | ❌ No | ❌ Required | App functionality |

### Device or other IDs

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Device or other IDs | ✅ Yes (FCM token, device fingerprint for fraud prevention) | ❌ No | ❌ Required | Security, Fraud prevention |

---

## 3. Categories NOT collected

- Health and fitness data
- Messages (in-app chat data is part of "App interactions")
- Audio files
- Files and docs (unless attached to incident reports)
- Calendar
- Contacts
- Web browsing history

---

## 4. Background location declaration

**This app uses background location.** Required to disclose:

1. **Why**: stream the driver's position to the active passenger so they see the cab approaching in real time.
2. **When**: only when (a) the driver has toggled "online" in the driver app AND (b) a ride is in `accepted`/`driver_en_route`/`arrived_at_pickup`/`in_progress` status.
3. **What happens at trip end**: streaming stops, no data persisted at-rest beyond aggregated trip summary.
4. **Disclosure shown to driver**: prominent in-app modal before requesting Always permission, mentioning explicitly the words "ubicación" and "segundo plano". Plus the iOS/Android system permission alert with our `NSLocationAlwaysAndWhenInUseUsageDescription` text.
5. **Demo video** (separate Play Console upload): see `apps/driver/store-metadata/background-location-demo.mp4` (TODO — record before submission).

---

## 5. Drift prevention

When changing driver data collection, update:

1. `apps/driver/PrivacyInfo.xcprivacy`
2. This file
3. `apps/web/src/app/privacy/page.tsx` (public Privacy Policy)
