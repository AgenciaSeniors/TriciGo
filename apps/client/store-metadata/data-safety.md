# Google Play Data Safety Form — TriciGo (Pasajero)

> Pegar/seleccionar las respuestas de este draft en Play Console → Policy and programs → App content → Data safety → Manage. Debe coincidir EXACTAMENTE con la Privacy Policy en `tricigo.com/privacy` y con el `PrivacyInfo.xcprivacy` de iOS para evitar bloqueo automático.

---

## 1. Data collection and security overview

### Does your app collect or share any of the required user data types?
**Yes**

### Is all of the user data collected by your app encrypted in transit?
**Yes** (HTTPS / TLS 1.2+ everywhere — Supabase, Stripe, Mapbox)

### Do you provide a way for users to request that their data be deleted?
**Yes** (Settings → Eliminar cuenta + URL público en `tricigo.com/account/delete`)

---

## 2. Data types collected (per category)

### Location

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Approximate location | ✅ Yes | ❌ No (Mapbox is "service provider", not "shared") | ✅ Optional (user can deny) | App functionality |
| Precise location | ✅ Yes | ❌ No | ✅ Optional | App functionality, Analytics |

### Personal info

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Name | ✅ Yes | ❌ No | ❌ Required | Account management, App functionality |
| Email address | ✅ Yes | ❌ No | ✅ Optional (login is phone-based) | Account management |
| User IDs | ✅ Yes | ❌ No | ❌ Required | Account management, App functionality |
| Address | ❌ No | — | — | — |
| Phone number | ✅ Yes | ❌ No | ❌ Required | Account management, App functionality |
| Race and ethnicity | ❌ No | — | — | — |
| Political or religious beliefs | ❌ No | — | — | — |
| Sexual orientation | ❌ No | — | — | — |
| Other personal info | ❌ No | — | — | — |

### Financial info

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| User payment info | ✅ Yes (via Stripe — never touches our server) | ❌ No (Stripe is processor, not "shared") | ✅ Optional | App functionality, Purchases |
| Purchase history | ✅ Yes | ❌ No | ❌ Required | App functionality |
| Credit score | ❌ No | — | — | — |
| Other financial info | ❌ No | — | — | — |

### Photos and videos

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Photos | ✅ Yes (avatar only) | ❌ No | ✅ Optional | App functionality (profile picture) |
| Videos | ❌ No | — | — | — |

### App activity

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| App interactions | ✅ Yes (PostHog events, no auto-tracking) | ❌ No | ❌ Required | Analytics, App functionality |
| In-app search history | ✅ Yes (recent destinations, local cache only) | ❌ No | ❌ Required | App functionality |
| Other actions | ❌ No | — | — | — |

### App info and performance

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Crash logs | ✅ Yes (Sentry) | ❌ No | ❌ Required | App functionality, Analytics |
| Diagnostics | ✅ Yes (Sentry) | ❌ No | ❌ Required | App functionality, Analytics |
| Other app performance data | ❌ No | — | — | — |

### Device or other IDs

| Type | Collected | Shared | Optional | Purposes |
|---|---|---|---|---|
| Device or other IDs | ✅ Yes (FCM token for push, device fingerprint) | ❌ No | ❌ Required | App functionality, Fraud prevention, Security |

---

## 3. Categories NOT collected (declare explicitly so reviewers see the answer)

- Health and fitness data
- Messages (we have in-app chat — but messages are part of "App interactions" category, not standalone)
- Audio files
- Files and docs
- Calendar
- Contacts (we do NOT read OS contact book — trusted contacts are manual entry)
- Web browsing history

---

## 4. Security practices

- All data encrypted in transit (HTTPS / TLS 1.2+)
- Supabase Row Level Security (RLS) on all tables
- Tokens stored in iOS Keychain / Android EncryptedSharedPreferences via `expo-secure-store`
- Two-factor authentication via SMS OTP
- User can delete account in-app and via public URL
- Data retention: account data deleted within 30 days of account deletion request

---

## 5. Third-party SDKs and what they collect

| SDK | What it collects | Sent to | Privacy Manifest |
|---|---|---|---|
| Stripe React Native | Payment info (tokenized, PCI-DSS L1) | Stripe servers | ✅ Bundled (>= 0.37.x) |
| Mapbox | Approximate device location for map rendering, anonymized telemetry | Mapbox servers (telemetry disabled in our config: `setTelemetryEnabled(false)`) | ✅ Bundled (>= 10.1.x) |
| Sentry React Native | Crash logs, performance data | Sentry servers | ✅ Bundled (>= 5.20.x) |
| Supabase JS Client | Database queries, auth tokens | Supabase servers (our backend) | N/A (TS-only) |
| PostHog React Native | Custom events (autocapture is disabled) | PostHog servers (EU region) | ✅ Bundled (recent versions) |
| Expo Notifications + FCM | Push token, message delivery receipts | FCM (Google) | ✅ Bundled in Expo modules |

---

## 6. Drift prevention

When changing data collection, update **all three** in lockstep:

1. `apps/client/PrivacyInfo.xcprivacy` (iOS Privacy Manifest)
2. This file (Google Play Data Safety form)
3. `apps/web/src/app/privacy/page.tsx` (public Privacy Policy)
