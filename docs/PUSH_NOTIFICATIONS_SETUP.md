# Push Notifications Setup

Status as of 2026-06-04.

## Architecture

We use **Expo Push Notifications** which abstracts FCM (Android) and APNs (iOS) behind a single token format.

- Frontend: `Notifications.getExpoPushTokenAsync()` returns `ExponentPushToken[xxx]`
- Token stored in DB table `user_devices` (key: user_id, device_id)
- Backend posts to `https://exp.host/--/api/v2/push/send` — Expo relays to FCM or APNs based on token type

Same code path for both platforms. Vos solo tenés que aprovisionar las **credentials** una vez por plataforma.

## ✅ Android (FCM) — DONE (resolved 2026-06-04)

Android push needs **two halves, both from the same Firebase project**
(`tricigo-39b92`). With only the first half, the app still mints a valid
`ExponentPushToken` and the whole backend pipeline runs — but Expo cannot
deliver: every push fails with `InvalidCredentials` ("Unable to retrieve the
FCM server key"), silently. Nothing reaches the device with the app closed.

1. **APK half — `google-services.json` baked into the build.** Lets the device
   register with FCM. Provisioned via GitHub secrets `CLIENT_GOOGLE_SERVICES_JSON`
   / `DRIVER_GOOGLE_SERVICES_JSON` (set 2026-05-01). The dev-client workflows
   write them at build time; without the secret they write a placeholder
   ("push won't work in this build").
2. **Expo half — FCM V1 service account key uploaded to Expo.** Lets Expo's
   servers authenticate to FCM when sending. **This was the missing piece** —
   the original version of this doc only covered half 1. Uploaded 2026-06-04.

### How the Expo half was provisioned (repeat if the cred is ever lost/rotated)

1. Firebase Console → project **`tricigo-39b92`** (owner `edua56621636@gmail.com`)
   → ⚙ Project settings → **Service accounts** → **Generate new private key**
   → downloads a JSON (keep it secret — it grants FCM send + Admin SDK access).
2. Upload that JSON to **both** Expo projects (same file works for both):
   - https://expo.dev/accounts/edua2005/projects/tricigo-client/credentials
   - https://expo.dev/accounts/edua2005/projects/tricigo-driver/credentials

   → Android → **FCM V1 service account key** → Add. (CLI alt:
   `eas credentials -p android` in each app dir.)
3. **No rebuild required** — the credential lives server-side at Expo, and the
   installed APKs already carry the matching `google-services.json` (push
   receipts came back `ok`, not `MismatchSenderId`). A rebuild is only needed if
   `google-services.json` itself changes (different Firebase project).

### Verify

```bash
curl -s -X POST https://exp.host/--/api/v2/push/send \
  -H 'Content-Type: application/json' \
  -d '{"to":"ExponentPushToken[...]","title":"t","body":"b","priority":"high","channelId":"rides"}'
# Expect ticket: {"data":{"status":"ok","id":"<ticket-id>"}}   (NOT InvalidCredentials)
# Then POST the id to .../push/getReceipts → status "ok" = delivered to FCM.
```

## 🚨 iOS (APNs) — REMINDER FOR LATER

**This is pending. Do NOT skip when launching to iOS.**

### Pre-requisites

- **Apple Developer Account** — $99 USD/year — https://developer.apple.com/programs/
  - Personal: instant approval
  - Business: requires D-U-N-S Number (5 days)

### Configuration already done

- `apps/client/app.json`: `UIBackgroundModes: ["remote-notification"]` ✅
- `apps/driver/app.json`: `UIBackgroundModes: ["location", "remote-notification"]` ✅
- Bundle IDs: `app.tricigo.client`, `app.tricigo.driver`

### Steps when Apple Dev Account is active

1. Register App IDs in Apple Developer portal:
   - https://developer.apple.com/account/resources/identifiers/list
   - Identifier: `app.tricigo.client` with **Push Notifications** capability ENABLED
   - Identifier: `app.tricigo.driver` with **Push Notifications** capability ENABLED

2. Generate APNs Auth Key (one key serves both apps):
   - https://developer.apple.com/account/resources/authkeys/list
   - **Keys** → **+** → check "Apple Push Notifications service (APNs)"
   - Continue → Register → Download `.p8` file (CAN ONLY BE DOWNLOADED ONCE — store securely)
   - Note down:
     - **Key ID** (10 chars)
     - **Team ID** (10 chars, in Account → Membership)

3. Upload to Expo Credentials:
   ```bash
   cd apps/client && eas credentials
   # Wizard: iOS → Push Notifications → Add APNs Key → upload .p8 + Key ID + Team ID
   cd apps/driver && eas credentials
   # Same key can be reused
   ```

4. Build iOS app:
   ```bash
   eas build --platform ios --profile production
   ```

5. Test: TestFlight install, background app, trigger event, push should appear

### Future-proof checklist

- [ ] Apple Developer Account paid + active
- [ ] D-U-N-S Number obtained (if business)
- [ ] App IDs registered with Push capability
- [ ] APNs `.p8` Auth Key downloaded and stored securely (e.g., 1Password, encrypted vault)
- [ ] Key ID + Team ID documented
- [ ] Uploaded to Expo via `eas credentials`
- [ ] iOS build tested via TestFlight
- [ ] Push delivered to device with app in background

### Why APNs is different from FCM

- No JSON file shipped with the app bundle (unlike Android's `google-services.json`)
- Auth happens server-side: Expo signs each push with your `.p8` key
- One `.p8` key works for ALL your iOS apps under the same Team ID
- Keys are revocable (lose .p8 → revoke → generate new one)

### Common pitfalls to avoid

1. **APNs sandbox vs production** — Expo handles this automatically based on build type, but if you see "DeviceNotRegistered" errors, check that your build type matches your push environment.
2. **Background notification permission** — must be requested at runtime (`Notifications.requestPermissionsAsync()`), already done in `useNotifications.ts`.
3. **iOS notification sounds** — need to be bundled in the app (`*.wav` or `*.aiff` files in resources), not URLs.

## Backend push code path (no changes needed)

```ts
// packages/api/src/services/push.service.ts (or wherever)
import fetch from 'node-fetch';

await fetch('https://exp.host/--/api/v2/push/send', {
  method: 'POST',
  headers: {
    'Accept': 'application/json',
    'Accept-encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: 'ExponentPushToken[xxxxx]',  // from user_devices table
    title: '¡Conductor asignado!',
    body: 'Tu conductor llega en 5 min',
    data: { rideId: 'abc-123' },
    sound: 'default',
    priority: 'high',
  }),
});
```

Same code for Android and iOS. Expo handles the routing.

## Tracking

- Bug reference: BUG-FCM-001 (Android) — **RESOLVED 2026-06-04** (FCM V1 service
  account key uploaded to both Expo projects); BUG-APNS-001 (iOS — still pending)
- Owner: Eduardo
- Last updated: 2026-06-04
