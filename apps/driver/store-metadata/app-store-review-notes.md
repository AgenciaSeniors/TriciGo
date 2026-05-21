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

Settings → Eliminar cuenta. Same cascade-delete pattern as the rider
app, plus the driver's documents are removed from storage.

### Sign in with Apple

Available alongside Google and SMS. Implemented via Supabase OAuth.

### No payments inside this app

The driver app does **not** process payments. Drivers receive earnings
into an internal wallet (CUP balance) which they can transfer or
redeem off-platform. There is no Stripe integration in this binary.

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
