# Native checklist: store build vs OTA

Both apps use `runtimeVersion: { policy: "appVersion" }`: an OTA reaches every installed binary of
the same `expo.version`.

- [ ] **Store build or OTA.** A change to native code, config plugins, `app.json` native fields,
  permissions or a dependency with native code needs a version bump and a store build. A JS-only
  change can go by OTA. The PR states which, and why.
- [ ] **A native change without a version bump is a P0**: an OTA would send JS that calls native
  code the installed apps do not have.
- [ ] **OTAs go out through the workflow.** `eas update` from a local machine does not read the
  `env` of `eas.json`, so it ships empty `EXPO_PUBLIC_*` values (Supabase URL, Mapbox token) to every
  phone; `eas-update.yml` sets them and checks the bundle. (header of `.github/workflows/eas-update.yml`)
- [ ] **Startup order.** Nothing renders `useTranslation` or reads stores before their init; a crash
  at startup cannot be fixed by OTA for users who cannot open the app. (CLAUDE.md: "Un
  `useTranslation` que se renderiza antes de `initI18n` tira la app")
- [ ] **Android permissions** (overlay, background location, notifications) degrade gracefully when
  denied, and Xiaomi/Redmi/POCO extra permissions are considered.
- [ ] **Low-end phones and bad networks:** heavy lists, maps and images are measured on a modest
  Android; requests have timeouts; offline paths work.
- [ ] **Layout on device.** `Pressable` style functions and NativeWind class order behave as
  expected on a real phone, not only in a test. (CLAUDE.md: "Una función-estilo de `Pressable`";
  "Un `Card` no se tiñe por `className`")
- [ ] **Deep links** keep working: the intent filter `pathPrefix` matches an internal route.
  (CLAUDE.md: "Universal links + Expo Router")
