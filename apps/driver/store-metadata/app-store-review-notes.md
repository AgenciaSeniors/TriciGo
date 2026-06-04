# App Store Review Notes — TriciGo Conductor

> Pegar en App Store Connect → My Apps → TriciGo Driver → App Information → App Review Information → Notes.

---

## Demo credentials

```
Login type: SMS OTP (phone number)
Phone: +5355550101
OTP code: 000000
(Demo number — no real SMS is sent. Enter the fixed code above directly.)

Alternative:
Email: reviewer-driver@tricigo.com
Password: <fill in before submit>
```

The reviewer account is pre-onboarded as a driver: documents already
"approved", one example completed ride in earnings history, currently
"offline" so the reviewer can test the online toggle, recurring shifts,
and the trip simulation.

---

## Notes for Reviewer

### Background location — required for ride tracking

This driver-facing app uses **real background location updates**
(`UIBackgroundModes: location` on iOS; Android `FOREGROUND_SERVICE` +
`FOREGROUND_SERVICE_LOCATION` permissions via `expo-task-manager`)
**only when the driver is on an active ride**. The full flow:

1. Driver toggles "Conectarme" (go online) → foreground location is
   requested first via `requestForegroundPermissionsAsync()`.
2. When a ride is accepted, the app shows the **prominent disclosure**
   (Alert, full Spanish text, contains "ubicación" + "segundo plano /
   Siempre" + names the feature + explicit "Permitir" CTA) BEFORE the
   system prompt. Source: `apps/driver/src/hooks/useDriverLocation.ts`
   (search "Compartir ubicación durante el viaje").
3. If the driver taps "Permitir", the OS background permission prompt
   fires. Apple's standard system alert.
4. Once granted, the app starts a **TaskManager background task**
   (`apps/driver/src/services/locationBackgroundTask.ts`,
   `LOCATION_TASK = 'tricigo-driver-location-bg'`) via
   `Location.startLocationUpdatesAsync` with:
     - `foregroundService.notificationTitle = 'TriciGo Conductor'`
       (Android persistent notification, required by Android 8+ for
       any background location use).
     - `showsBackgroundLocationIndicator = true` (iOS blue location
       bar in the status bar, required by Apple HIG for
       UIBackgroundModes=location).
5. The task body uploads each location batch to the
   `ride_location_events` table via
   `locationService.recordRideLocation`. Offline batches fall back to
   the `locationBuffer` and flush when connectivity returns.
6. When the ride completes (or the driver goes offline), the React
   hook's cleanup calls `stopBgLocationTracking` which calls
   `Location.stopLocationUpdatesAsync(LOCATION_TASK)` and clears the
   persisted context. The Android foreground service notification
   disappears immediately.

We do **not** use geofencing, do **not** track location when the
driver is offline or has no active ride, and do **not** sell or share
location data with third parties. All location streaming is end-to-end
with the rider's device during a single active trip.

The previous implementation only used `watchPositionAsync`, which on
Android stops invoking its callback the moment the app backgrounds —
which broke the passenger-visibility promise. The TaskManager rewrite
(FD1 in `docs/STORE_READINESS_DRIVER.md`) fixed this.

### Account deletion

Settings → Eliminar cuenta. Calls the shared `delete-account` Supabase
Edge Function (authenticated with the driver's JWT — user_id is derived
server-side) which performs an **immediate, irreversible hard-delete**:

1. `anonymize_user_references(user_id)` Postgres function re-points
   every non-CASCADE foreign key (rides, ratings, referrals, etc.)
   from the driver to a well-known anonymous user (UUID
   `00000000-…-099`, role `customer`, `is_active=false`). This
   preserves the financial / AML audit trail without violating FK
   constraints during the auth.users delete.
2. Best-effort cleanup of storage:
   - The driver's avatar from the `avatars` bucket.
   - **All KYC documents** (carné de identidad, licencia de
     conducir, foto del vehículo, selfie de verificación) from the
     `driver-documents/{user_id}/` bucket. Recursive list +
     remove — every subfolder per document type is cleaned.
3. `auth.admin.deleteUser(user_id)` deletes the `auth.users` row,
   CASCADEs to `public.users` and the CASCADE-flagged children:
   `wallet_accounts`, `trusted_contacts`, `notifications`,
   `recurring_rides`, **`driver_profiles`**. The phone and email
   are freed immediately.

There is **no grace period** — deletion is immediate. The same edge
function is used by the rider app (PR #160); this PR wires it into
the driver app and adds the `driver-documents` cleanup step.

Public URL for users who have already uninstalled the app:
`https://tricigo.com/account/delete` (the same page covers both
client and driver — support verifies the role manually if asked).

### App Tracking Transparency (ATT)

TriciGo Conductor does **not** implement an ATT prompt (no
`AppTrackingTransparency` framework, no `NSUserTrackingUsageDescription`
in `Info.plist`) because the app does **not** track the driver across
other companies' apps or websites:

- No advertising SDK (AdMob, Meta Ads, AppsFlyer, etc.) is integrated.
  No third-party SDK reads or shares the IDFA.
- Sentry runs with `sendDefaultPii: false` and the `beforeSend` hook
  strips authorization headers and PII before transmission.
- Location data is used exclusively for in-app trip dispatch /
  passenger visibility / earnings reporting — never shared with
  advertising or analytics third parties (Mapbox telemetry is
  explicitly disabled via `setTelemetryEnabled(false)`).
- `apps/driver/PrivacyInfo.xcprivacy` declares `NSPrivacyTracking
  = false` and an empty `NSPrivacyTrackingDomains`, matching the
  runtime behavior.

Per Apple's ATT policy, the prompt is required only when an app
tracks; since we don't, surfacing the prompt would be misleading.

### Sign in with Apple

Available alongside Google and SMS. Implemented via Supabase OAuth.

### Wallet quota recharge — Guideline 3.1.1 defense

The driver app has an internal TriciCoin wallet that (a) pays the
platform's per-ride commission ("quota") and (b) displays earnings
("Mis ganancias"). Drivers **recharge** that balance through **NETOPIA
Payments** (a Romanian processor) opened in a hosted checkout page via
`WebBrowser.openAuthSessionAsync` — intentionally **not** StoreKit / IAP,
and **no native payment SDK is bundled** in this binary (NETOPIA is a
hosted web page, not an SDK; there is no Stripe SDK either). We believe
this falls outside Apple's IAP requirement:

1. **Funds a real-world business operating cost, not digital content.**
   The quota is the commission a driver pays to operate as an independent
   transportation provider on the platform (analogous to a marketplace
   seller fee). It unlocks no digital content, app feature, premium tier,
   or virtual good.
2. **Closed-loop, no cash-out.** The balance can only be spent inside the
   platform (commission + optionally gifting to another active user — see
   "Regalo" below). The cash-out / redemption flow was removed in
   `00273_remove_driver_cashout.sql`; there is no withdraw-to-bank/card path.
3. **Reference apps:** Uber, Lyft, and DoorDash driver apps use third-party
   processors for real-world balances without StoreKit.

To test recharge: the NETOPIA POS is in sandbox; the published test card
(`9900 0000 0000 5159` exp `01/26` cvc `123`) succeeds without a real
charge. The hosted page returns to the app via
`https://tricigo.com/app/driver/wallet`.

### Regalo (peer-to-peer gift) — Guideline 3.1.5

A driver can optionally send part of their TriciCoin balance to another
**active TriciGo user** as a "Regalo" (gift), looked up by share-code/QR
or phone number (`send_gift` RPC, atomic double-entry). We believe this
fits Guideline 3.1.5(b):

1. **Completely optional** — no ride, feature, or content is gated behind it.
2. **100% goes to the receiver** — TriciGo takes no cut on the transfer.
3. **Not tied to digital content/services** — the gifted balance is
   redeemable only for **physical transportation** (real-world rides), so
   the "gift tied to digital goods must use IAP" carve-out does not apply.
4. **Closed-loop, no cash-out** — the recipient must be an existing active
   TriciGo user; the gift cannot be sent to a bank/card/external account
   and cannot be withdrawn to cash.
5. **Abuse controls** — recipient lookup is server-side rate-limited
   (anti-enumeration); frozen wallets cannot send; admins can reverse a gift.

### Data collection — see Privacy Manifest

`PrivacyInfo.xcprivacy` bundled at root of .app. Driver-specific data:
photos of vehicle docs, identity verification photos, physical address
for service area assignment.

### Known reviewer notes

- The "Verificación pendiente" state appears for drivers whose docs are
  still under admin review. The reviewer demo account starts as
  "approved" so this state is skipped.
- The "Solo en línea durante un viaje" toggle limits background tracking
  to active rides only.

---

## Contact

- App support email: conductores@tricigo.com
- Developer contact: edua56621636@gmail.com (technical)
