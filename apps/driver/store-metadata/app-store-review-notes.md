# App Store Review Notes — TriciGo Conductor

> Pegar en App Store Connect → My Apps → TriciGo Driver → App Information → App Review Information → Notes.

---

## Demo credentials

```
Login type: SMS OTP (phone number)
Phone: +1 415 555 0101
OTP code: 000000  (test override active in DEV/Apple Review accounts)

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

This driver-facing app uses **background location updates** (`UIBackgroundModes:
location`) **only when the driver is on an active ride**. The flow:

1. Driver toggles "Conectarme" (go online) → foreground location is requested
   first via `requestForegroundPermissionsAsync()`.
2. When a ride is accepted, the app prompts for background permission
   ("Always") via `requestBackgroundPermissionsAsync()`. The reason is
   shown explicitly in `NSLocationAlwaysAndWhenInUseUsageDescription`.
3. The driver can see and confirm the prompt — Apple's standard system
   alert.
4. Background location is used to stream the driver's position to the
   passenger so the passenger sees the cab approaching in real time.
5. When the ride completes, background location stops automatically.

We do **not** use geofencing, do **not** track location when the driver
is offline, and do **not** sell or share location data with third
parties. All location streaming is end-to-end with the rider's device
during a single active trip.

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

### No payments inside this app

The driver app does **not** process payments. Drivers receive earnings
into an internal wallet (CUP balance, displayed in
"Mis ganancias"). The cashout / redemption flow was removed in
migration `00273_remove_driver_cashout.sql` to keep the wallet
closed-loop (earnings can only be spent inside the platform — the
target was to eliminate the OFAC-sensitive transfer surface).

There is no Stripe SDK, NETOPIA SDK, or any other payment processor
SDK bundled in this binary. The driver wallet is purely a display of
ledger entries written server-side by the ride completion RPC; the
driver app never initiates a payment.

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
