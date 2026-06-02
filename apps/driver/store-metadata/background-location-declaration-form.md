# Background Location Declaration Form — TriciGo Conductor (Google Play)

> Draft pre-rellenado para pegar en **Play Console → App content → Sensitive app permissions → Location permissions → Background location**. Required for every AAB submission that requests `ACCESS_BACKGROUND_LOCATION` (declared in `apps/driver/app.json` Android permissions).
>
> Without this declaration approved, Google Play blocks the production rollout regardless of the build's technical quality. Approval typically takes 24-72h after a complete submission.

---

## 1. Policy compliance

> "Do you confirm your app complies with Google Play's Location permissions policy?"

**Yes.** TriciGo Conductor requests `ACCESS_BACKGROUND_LOCATION` only for the driver's active-trip tracking use case, with prominent in-app disclosure shown before the system prompt, foreground permission requested first, and background usage scoped to the period the driver is online and assigned to an active ride.

---

## 2. App / feature purpose

> "Describe the feature for which your app uses background location."

**Live trip tracking for assigned ride passengers.**

TriciGo Conductor is the driver-side app of the TriciGo ride-hailing platform (Cuba). When a driver accepts a ride request and is en route to the passenger pickup point (or driving with the passenger to their destination), the passenger's app shows the driver's marker moving in real time on the map. This feature is essential to:

1. **Passenger safety:** passengers see their assigned driver approaching and can confirm vehicle/identity match before getting in.
2. **ETA accuracy:** the app recomputes ETA in real time as the driver moves, reducing pickup mismatches.
3. **Trip integrity:** if a driver deviates from the route, both the passenger and TriciGo support can detect it. Used in dispute resolution.

Without background location access, the marker stops updating the moment the driver minimizes the TriciGo Conductor app to take a phone call, check WhatsApp, switch to a navigation app, or turn the screen off — which is the realistic usage pattern of a Cuban professional driver.

---

## 3. Why foreground-only (when-in-use) is not enough

We considered using only `ACCESS_FINE_LOCATION` with foreground permission, which would avoid this declaration entirely. We rejected that approach because:

- Drivers in Cuba routinely answer phone calls, switch apps for navigation (Google Maps / Maps.me), respond to passenger WhatsApp messages, and operate the app with the screen off (battery saving while waiting at lights or in queues).
- Every such app switch would freeze the passenger's view of the driver marker, eroding the trust that ride-hailing requires.
- Equivalent ride-hailing apps approved by Google Play (Uber Driver, Lyft Driver, DiDi Driver, Cabify Driver) all use background location for the same reason.

---

## 4. Prominent disclosure

> "Provide a screenshot of the prominent disclosure shown inside the app."

The prominent disclosure is an `Alert.alert` that appears the FIRST time the driver has an active ride and the OS reports background permission as not-yet-granted. Source: `apps/driver/src/hooks/useDriverLocation.ts` (BUG-Store-Readiness-Driver / W8 fix). Text:

> **Compartir ubicación durante el viaje**
>
> TriciGo Conductor necesita acceso a tu ubicación en segundo plano (opción "Siempre" / "Always") mientras tenés un viaje activo, para que el pasajero pueda verte llegar en tiempo real aunque la app esté minimizada o la pantalla apagada. Sin este permiso, el pasajero pierde tu posición cuando salís de la app.
>
> [Más tarde] [Permitir]

The "Permitir" CTA triggers `Location.requestBackgroundPermissionsAsync()`, which surfaces Android's standard background-location prompt. The system prompt is shown only after the user explicitly taps "Permitir" in the disclosure.

**Screenshot to attach:** capture of the Alert in the Android dev client. Recommended camera frame: full screen, no notification bar redactions needed. Save to `apps/driver/store-metadata/screenshots/06-bg-location-disclosure.png` before submission.

The disclosure satisfies all four Google requirements:

| Requirement | Where in the disclosure |
|---|---|
| Appears before the system prompt | The Alert is shown synchronously; the system prompt only fires after the user taps "Permitir". |
| Uses the word "ubicación" (location) | Title ("Compartir ubicación durante el viaje") + body. |
| Uses "background" / "siempre" (always) | Body: "en segundo plano (opción 'Siempre' / 'Always')". |
| Names the specific feature | Body: "mientras tenés un viaje activo … el pasajero pueda verte llegar en tiempo real". |
| Explicit "Allow" CTA | "Permitir" button. |

---

## 5. Video walkthrough

> "Upload a ≤30 second video demonstrating the prominent disclosure, the system prompt, and the feature in action."

**Storyboard (target length: 25-28 seconds):**

| Time | Scene | Notes |
|---|---|---|
| 0:00 - 0:05 | Driver app home, driver toggles online with a brand-new install / freshly-granted foreground-only permissions. | Use a test device that has NEVER had background permission granted for `app.tricigo.driver` (or revoke it via Settings → Apps → TriciGo Conductor → Permissions → Location → "Allow only while using the app" before recording). |
| 0:05 - 0:09 | A test ride from another device (or simulated via admin tool) is dispatched. Driver taps "Aceptar". | Use a pre-canned test ride with a hardcoded passenger from review credentials (`+5355550102` for example). |
| 0:09 - 0:14 | Prominent disclosure `Alert.alert` appears with the full Spanish text. Camera focuses on the alert; pause briefly so the reviewer can read. | This is the key proof — make sure text is fully visible. |
| 0:14 - 0:17 | Driver taps "Permitir". | |
| 0:17 - 0:22 | Android system prompt appears asking "Allow TriciGo Conductor to access this device's location?". On Android 11+ the flow may be two-step (while-using → always); on Android 13+ "Allow all the time" is a direct option. Tap whichever grants Always / Background. **Test the actual flow on your target Android version before recording.** | Most reliable: record on Android 13+. |
| 0:22 - 0:28 | App returns to the driver's home screen. Switch to a different app (open WhatsApp briefly), wait 3 seconds, then check the passenger's view (split-screen or second device) — the driver marker is still updating in real time. | This is the proof that the feature works as declared. Shoot from a second phone showing the passenger's screen with the driver marker moving. |

**Production notes:**

- Record in Spanish locale (system + app set to es).
- Use a real Android device (preferably Redmi 9A or equivalent Cuba-typical hardware) to keep the demo realistic.
- Screen recorder: built-in Android 11+ or `scrcpy` desktop.
- Trim with `ffmpeg -ss start -to end -c copy out.mp4`.
- Format: 1080p MP4 H.264, < 100 MB.
- Hosting: YouTube **unlisted** (paste link into the Play Console form). Apple App Store doesn't need a video — only Google requires this.

---

## 6. Test account for reviewer

The Play Console reviewer needs to verify the disclosure flow themselves. Provide the same demo credentials documented in `apps/driver/store-metadata/app-store-review-notes.md`:

- Phone: `+5355550101`
- OTP code: `000000` (demo number — no real SMS sent)

The reviewer account is pre-onboarded as an approved driver, currently offline, with one example completed ride in earnings history. The first time the reviewer accepts a ride from the test dispatch tool, the prominent disclosure fires as documented in §4.

---

## 7. Background usage scope

> "When does your app use background location?"

- **Only while the driver is online AND assigned to an active ride.** Source: `apps/driver/src/hooks/useDriverLocation.ts` only requests `requestBackgroundPermissionsAsync` inside the `if (activeRideId)` branch.
- **Stopped automatically** when the ride completes (the effect dependency on `activeRideId` triggers cleanup).
- **Stopped manually** when the driver toggles offline (the `isOnline` flag in the effect dependency).
- **Not used** for ads, analytics, profile building, geofencing, behavioral targeting, advertising IDs, or any non-trip purpose. Validated in `apps/driver/PrivacyInfo.xcprivacy`: location is collected for `AppFunctionality` and `Analytics` purposes only, `NSPrivacyTracking = false`, no `NSPrivacyTrackingDomains`.

---

## 8. Privacy policy URL

`https://tricigo.com/privacy` — includes a dedicated section on driver-side location usage, retention, and the rider's complementary visibility.

---

## 9. Pre-submit checklist

- [ ] Record the 25-28s video per the storyboard in §5.
- [ ] Upload to YouTube unlisted; paste link into the Play Console form.
- [ ] Capture the disclosure screenshot and save as `apps/driver/store-metadata/screenshots/06-bg-location-disclosure.png`.
- [ ] Verify the demo phone `+5355550101` has OTP override active in the backend (`send-sms-otp` DEV bypass) before submission.
- [ ] Submit the form. Google email response typically arrives within 24-72h.
- [ ] If rejected, the email lists the specific issue. Most common reasons:
   - Video shows the system prompt **before** the disclosure (we explicitly avoid this — but record carefully).
   - Disclosure missing one of the required keywords (location / background / feature name).
   - Privacy policy URL does not specifically mention background location.
   - Disclosure shown only after the user navigates into Settings instead of in the main flow.

---

## 10. References

- [Google Play User Data Policy — Location](https://support.google.com/googleplay/android-developer/answer/9799150) — original policy.
- [Background Location best practices](https://developer.android.com/training/location/permissions) — Android dev docs.
- `apps/driver/src/hooks/useDriverLocation.ts` (search "BUG-Store-Readiness-Driver" / "W8") — implementation source of truth.
- `docs/STORE_READINESS_DRIVER.md` §2 (BD4) and §5 (W8) — audit references.
