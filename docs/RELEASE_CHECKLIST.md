# Release Checklist — driver + client apps

> Última actualización: 2026-04-18
> Versión objetivo: 1.0.0

Checklist reproducible paso a paso para ir de código en `master` a apps en TestFlight + Play Internal Testing (y más tarde a App Store + Play Store públicos).

---

## Fase A — Pre-build (se puede hacer HOY, sin cuentas)

- [x] `apps/driver/package.json` y `apps/client/package.json` → `version: 1.0.0`
- [x] `apps/driver/eas.json` y `apps/client/eas.json` con envs reales (Supabase, Mapbox, Sentry, PostHog)
- [x] `SENTRY_ORG` + `SENTRY_PROJECT` en eas.json para que Sentry suba sourcemaps durante build
- [x] Smoke `expo export --platform android` → ambas apps compilan sin errores bloqueantes
- [ ] `SENTRY_AUTH_TOKEN` en EAS secrets (token secreto, NO commitear):
  ```bash
  cd apps/driver
  eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token> --type string --force
  cd ../client
  eas secret:create --scope project --name SENTRY_AUTH_TOKEN --value <token> --type string --force
  ```
- [x] Stripe graceful fallback verificado (sin crash si falta la key)

## Fase B — Internal Android APK (HOY, gratis)

### Opción 1 (Recomendada mientras EAS esté sin cuota): GitHub Actions

Workflow: `.github/workflows/android-apk.yml`. Corre en runners de GitHub (JDK 17 + Android SDK preinstalados). Gratis bajo el free tier de GH Actions.

```bash
# Driver
git tag driver-v1.0.0-apk
git push origin driver-v1.0.0-apk

# Client
git tag client-v1.0.0-apk
git push origin client-v1.0.0-apk
```

Después de ~15-20 min, el APK queda disponible en Actions → run → Artifacts. También se puede disparar manualmente desde la UI de Actions con "Run workflow" + seleccionar `driver` o `client`.

**Limitación:** debug-signed. Sirve para sideload en Android real, NO para submit a Play Store.

### Opción 2: EAS cloud (requiere cuota disponible o upgrade)

```bash
# Driver
cd apps/driver
eas build --profile preview --platform android --non-interactive

# Client
cd ../client
eas build --profile preview --platform android --non-interactive
```

- [ ] Driver APK URL: `___________________________`
- [ ] Client APK URL: `___________________________`
- [ ] Ambos APKs instalados en Android real (propio + 1-2 testers)
- [ ] Smoke test driver: login Google OAuth → mapa Mapbox carga → accept ride → end ride
- [ ] Smoke test client: login Google OAuth → mapa Mapbox carga → request ride → pago cash → rate
- [ ] Sentry recibe al menos 1 evento (ver dashboard sentry.io/agencia-senores/tricigo-mobile)
- [ ] PostHog recibe al menos 1 evento

**Alternativa CI:** tagear `git tag driver-v1.0.0 && git push --tags` — dispara GitHub Action `eas-build.yml` (requiere `EXPO_TOKEN` secret en el repo).

## Fase B.5 — Firebase Cloud Messaging (para push notifications en APKs standalone)

Los APKs de GitHub Actions bypasean EAS → Expo no puede usar su proyecto Firebase interno, hay que configurar uno propio. **Gratis** (Firebase Spark plan cubre todo el uso de FCM).

- [ ] **Firebase console** (https://console.firebase.google.com) — crear proyecto "TriciGo"
- [ ] Añadir Android app al proyecto:
  - [ ] Package: `app.tricigo.driver` — descargar `google-services.json`
  - [ ] Package: `app.tricigo.client` — descargar `google-services.json` (distinto del driver)
- [ ] **Opción A — Build local manual**: guardar cada JSON como `apps/driver/google-services.json` + `apps/client/google-services.json` (ya están gitignored)
- [ ] **Opción B — Build en GH Actions**: subir los JSONs como secrets del repo:
  - Settings → Secrets and variables → Actions → New repository secret
  - Name: `DRIVER_GOOGLE_SERVICES_JSON`, value: **todo el contenido** del archivo JSON (pegalo crudo)
  - Name: `CLIENT_GOOGLE_SERVICES_JSON`, value: ídem para client
  - El workflow decodifica en runtime antes del prebuild. Sin secrets → usa un placeholder que NO rompe el build pero deshabilita push.
- [ ] Retriggerear tag `driver-v1.x.x-apk` para probar con FCM real
- [ ] Verificar en el device: instalar app → login → abrir Expo dashboard → enviar push de prueba al token registrado → debería llegar

Sin este paso, las ofertas de viaje solo llegan cuando la app está abierta (realtime WebSocket). Con app cerrada, el driver no se entera.

## Fase C — Cuentas pagas (requiere decisión del usuario)

- [ ] **Apple Developer Program** ($99/año) — https://developer.apple.com/programs
  - [ ] Enrollment completo (24-48h)
  - [ ] Obtener `appleTeamId` (10 chars) de https://developer.apple.com/account → Membership
  - [ ] Crear 2 apps en App Store Connect (Client + Driver) → obtener 2 `ascAppId`
- [ ] **Google Play Console** ($25 una vez) — https://play.google.com/console
  - [ ] Enrollment completo (1-2h verification)
  - [ ] Crear 2 apps (tricigo-client, tricigo-driver)
  - [ ] Google Cloud Service Account con role "Service Account User" + linked to Play Console
  - [ ] Descargar 2 JSON key files
- [ ] Stripe (opcional, solo si se va a aceptar tarjeta desde mobile) — https://dashboard.stripe.com
  - [ ] Cuenta verificada
  - [ ] Publishable key `pk_live_*` agregar a eas.json `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- [ ] Twilio (opcional, para SMS OTP) — https://twilio.com
  - [ ] Cuenta con documentos
  - [ ] Número con envío a Cuba
  - [ ] Account SID + Auth Token + Phone Number → Supabase platform_config

## Fase D — Production builds (cuando tengas Fase C lista)

Reemplazar placeholders en `apps/driver/eas.json` y `apps/client/eas.json`:

```json
"submit": {
  "production": {
    "ios": {
      "appleId": "edua56621636@gmail.com",
      "ascAppId": "<ID numérico de ASC>",
      "appleTeamId": "<10 chars>"
    }
  }
}
```

Guardar JSONs:
- `apps/driver/google-service-account.json` (gitignored)
- `apps/client/google-service-account.json` (gitignored)

Builds production:
```bash
cd apps/driver
eas build --profile production --platform all --non-interactive

cd ../client
eas build --profile production --platform all --non-interactive
```

- [ ] Driver iOS IPA URL: `___________________________`
- [ ] Driver Android AAB URL: `___________________________`
- [ ] Client iOS IPA URL: `___________________________`
- [ ] Client Android AAB URL: `___________________________`

## Fase E — Submit

```bash
cd apps/driver
eas submit --profile production --platform all --non-interactive

cd ../client
eas submit --profile production --platform all --non-interactive
```

Después del submit:
- [ ] Driver TestFlight disponible (Apple ~15 min)
- [ ] Client TestFlight disponible
- [ ] Driver Play Internal Testing disponible
- [ ] Client Play Internal Testing disponible
- [ ] Instalar en device + smoke test completo
- [ ] Invitar testers externos (Apple: emails, Google: email list)

## Fase F — Public release

**App Store:**
- [ ] Completar listing en App Store Connect (usar datos de `docs/STORE_RELEASE.md`)
- [ ] Submit for Review (1-3 días Apple)
- [ ] Aprobado → Release manualmente o automáticamente

**Play Store:**
- [ ] Completar listing en Play Console
- [ ] Submit to Production track (horas-1 día Google)
- [ ] Aprobado → Release

---

## Troubleshooting común

### EAS build falla por pnpm / monorepo
El workflow root `.npmrc` tiene `node-linker=hoisted` — verificar que `apps/*/metro.config.js` tiene `watchFolders` apuntando a `../../node_modules` y paquetes workspace.

### Mapbox no carga en la app
Verificar que el token tiene allowlist para bundle IDs `app.tricigo.client` y `app.tricigo.driver` en el dashboard mapbox.com.

### Sentry no recibe eventos
`__DEV__` check en driver — solo reporta en prod builds. `EXPO_PUBLIC_SENTRY_DSN` debe estar en eas.json base env.

### "Module not found" en build EAS
Si pasa en CI pero no local: probable caché stale. `eas build --clear-cache --profile preview --platform android`.
