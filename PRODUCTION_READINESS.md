# PRODUCTION_READINESS.md — TriciGo

> Todo lo que falta para pasar **`apps/client`** y **`apps/driver`** a producción en App Store y Google Play.
> Última actualización: 2026-05-06 (post-auditoría completa).
> Owner: Eduardo (edua56621636@gmail.com).

---

## Resumen ejecutivo

| Área | Estado | Bloqueante |
|---|---|---|
| Código fuente | ✅ Listo (P0/P1 críticos arreglados) | No |
| Privacy Manifest iOS | ✅ Listo (xcprivacy + plugin) | No |
| Store metadata público | ✅ Listo (sin Cuba/Havana) | No |
| Migraciones DB | ✅ Aplicadas a prod (00263 inclusive) | No |
| Stripe risk arquitectónico | ⚠️ Mitigado en código, **falta merchant entity fuera de Cuba** | **SÍ** |
| Apple Developer Program | ⏳ Pendiente | **SÍ** |
| Google Play Console | ⏳ Pendiente | **SÍ** |
| Cuenta Stripe (LLC fuera de Cuba) | ⏳ Pendiente | **SÍ** |
| Screenshots reales | ⏳ Pendiente | **SÍ** |
| Demo accounts para reviewers | ⏳ Pendiente | **SÍ** |
| Background location video | ⏳ Pendiente | **SÍ** (driver) |

**Tiempo total estimado para reach submission-ready**: 12-20 horas de trabajo manual + tiempos de espera (verificación de cuentas, envíos de docs).

---

## 0. Pre-requisitos legales y de cuentas

> Estos son los bloqueantes existenciales. Sin esto resuelto, el resto del checklist es teoría.

### 0.1 Entidad legal fuera de Cuba (CRÍTICO para Stripe)

Stripe prohíbe explícitamente operar con personas/servicios "linked directly OR INDIRECTLY with Cuba". El merchant que firma el Stripe account NO puede ser una entidad cubana ni operada desde Cuba. Opciones:

| Opción | Costo aprox | Tiempo | Notas |
|---|---|---|---|
| **Stripe Atlas (Delaware C-Corp)** | $500 USD setup + $100/año | 2-3 semanas | Recomendado para fundadores. Incluye EIN, banking |
| **Estonia e-Residency** | €100-€350 | 1-2 meses | Buena UE. Requiere viajar para banco |
| **México SA de CV** | $1,500-$3,000 USD | 2-4 semanas | Si tenés contactos legales en MX |
| **España SL** | €2,000-€5,000 | 4-6 semanas | Buena UE, IVA incluido |
| **Argentina SA** | $1,000-$2,500 USD | 4-8 semanas | Si ya tenés residencia |

**Acción**: elegir jurisdicción y constituir antes de cualquier submission. Sin esto Stripe se cierra dentro de 30-90 días post-launch.

**Bloqueado por**: decisión legal externa.

### 0.2 Apple Developer Program

- **Costo**: $99 USD/año (organization, requiere D-U-N-S Number — gratis en dnb.com, ~14 días)
- **URL**: https://developer.apple.com/programs/enroll/
- **Tipo**: Organization (preferido sobre Individual — apps de transporte enviadas desde cuenta individual son más sospechosas para reviewers)
- **D-U-N-S**: requerir AHORA en https://developer.apple.com/enroll/duns-lookup/
- **Verificación**: Apple llama por teléfono al número del D-U-N-S. Tener ese número operativo en horario LATAM-US.

**Outputs necesarios** (para llenar después en `eas.json`):
- Apple ID (email)
- Team ID (ej: `ABCDE12345`)
- App Store Connect App ID (ej: `1234567890`) — se obtiene al crear la app

### 0.3 Google Play Console

- **Costo**: $25 USD pago único (organization)
- **URL**: https://play.google.com/console/signup
- **Tipo**: Organization (requiere D-U-N-S Number también)
- **Cuenta nueva post-13-nov-2023**: requiere closed test con **mínimo 12 testers durante 14 días** antes de poder publicar a Production. **Empezar este test cuanto antes** para ahorrar 14 días al final.

**Outputs necesarios**:
- Service Account JSON (para `eas submit`) — descargar después de crear el service account en Google Cloud Console linked al Play Console.

### 0.4 Cuenta Stripe (linked al merchant entity)

- **URL**: https://dashboard.stripe.com/register
- **Activar**: Stripe Atlas si elegís esa ruta — incluye account preconfigurada
- **Modo**: empezar en Test mode, activar Live mode solo cuando todo lo demás esté listo
- **Configuración crítica**: ver `apps/client/store-metadata/aso-keywords-private.md` sección "Stripe — Business profile". Resumen:
  - Business name: `TriciGo`
  - Industry: `Transportation services`
  - Product description: NO mencionar Cuba/Havana
  - Statement descriptor: `TRICIGO RIDES` (max 22 chars)

**Outputs necesarios**:
- `stripe_publishable_key` (live)
- `stripe_secret_key` (live)
- Webhook signing secret

### 0.5 Dominios y DNS

- `tricigo.com` (web principal — ya en uso)
- `tricigo.app` (referenciado en privacy URL — verificar que apunte al mismo deploy o redirect)
- DNS records:
  - A/CNAME → Vercel deploy de `apps/web`
  - `apple-app-site-association` accesible en `https://tricigo.com/.well-known/apple-app-site-association` para Universal Links
  - `assetlinks.json` accesible en `https://tricigo.com/.well-known/assetlinks.json` para Android App Links

### 0.6 Supabase production tier

- Plan: **Pro** ($25/mes) — necesario para más conexiones, backup diario, longer log retention
- Verificar que la URL `https://lqaufszburqvlslpcuac.supabase.co` está en plan Pro
- Database backup automático activado
- Point-in-time recovery activado

---

## 1. App Store Connect (iOS) — configuración manual

> Despues de tener Apple Developer Program activo. Hacer ambas apps (TriciGo + TriciGo Driver) en paralelo.

### 1.1 Crear apps en App Store Connect

1. https://appstoreconnect.apple.com → My Apps → "+"
2. **App 1 — TriciGo (cliente)**
   - Platform: iOS
   - Name: `TriciGo`
   - Primary language: Spanish (Latin America) — `es-419`
   - Bundle ID: `app.tricigo.client` (registrarlo antes en Certificates, Identifiers & Profiles)
   - SKU: `TRICIGO-CLIENT-001` (interno, no visible al usuario)
   - User Access: Full Access
3. **App 2 — TriciGo Driver**
   - Same flow, Bundle ID: `app.tricigo.driver`
   - Name: `TriciGo Driver`

### 1.2 Llenar credenciales en eas.json

**Archivo**: `apps/client/eas.json` y `apps/driver/eas.json`

Cambiar:
```json
"submit": {
  "production": {
    "ios": {
      "appleId": "edua56621636@gmail.com",
      "ascAppId": "FILL_ME",       // ← reemplazar con el App ID de App Store Connect
      "appleTeamId": "FILL_ME"     // ← reemplazar con el Team ID de Apple Developer
    }
  }
}
```

Para encontrar `ascAppId`:
- App Store Connect → My Apps → TriciGo → App Information → "Apple ID" (numérico, ej: `1234567890`)

Para encontrar `appleTeamId`:
- https://developer.apple.com/account → Membership Details → Team ID (alfanumérico, ej: `ABCDE12345`)

**Tiempo**: 15 min después de tener Apple Developer activo.

### 1.3 Configurar capabilities

En Apple Developer Portal → Certificates, Identifiers & Profiles → Identifiers → seleccionar cada Bundle ID → Capabilities:

**Client** (`app.tricigo.client`):
- ✅ Push Notifications
- ✅ Background Modes (los flags se inyectan automáticamente desde `app.json`)
- ✅ Sign in with Apple
- ✅ Associated Domains: `applinks:tricigo.com`
- ✅ App Attest (recomendado para anti-fraud)

**Driver** (`app.tricigo.driver`):
- ✅ Push Notifications
- ✅ Background Modes
- ✅ Sign in with Apple
- ✅ Associated Domains: `applinks:tricigo.com`
- ✅ App Attest

**Tiempo**: 30 min.

### 1.4 App Privacy section

App Store Connect → My Apps → TriciGo → App Information → App Privacy:

1. **Privacy Policy URL**: `https://tricigo.com/privacy`
2. **Data Types**: marcar exactamente lo declarado en `apps/client/PrivacyInfo.xcprivacy`. Reference: `apps/client/store-metadata/data-safety.md` (es la misma data, solo el formato cambia).
3. Para driver: usar `apps/driver/PrivacyInfo.xcprivacy` + `apps/driver/store-metadata/data-safety.md`.

**Tiempo**: 30 min por app.

### 1.5 Pricing & Availability

1. **Price**: Free
2. **Availability**: marcar todos los países donde querés distribuir
   - Recomendado: España, México, Argentina, Colombia, Chile, Perú, Ecuador, Uruguay, Venezuela, USA, Brasil
   - Cuba: si aparece en la lista (depende de OFAC en tu cuenta), marcarla. Si no aparece, dejá sin tocar — usuarios cubanos pueden cambiar región del Apple ID temporalmente
3. **Pre-orders**: Off

### 1.6 Localizable info — pegar listings

Por cada language tab (en-US, es-MX):

**Client en-US**: contenido de `apps/client/store-metadata/en/listing.md`:
- Subtitle: `Urban transport, fast and safe` (max 30 chars)
- Description: el cuerpo del .md
- Keywords (privado, max 100 chars): `taxi,transport,ride,pedicab,mobility,driver,trip,urban,rideshare,commute`
- Promotional text: `Pedí tu viaje en bicitaxi, moto o auto. Precio claro, conductor verificado, seguimiento en tiempo real.`
- Support URL: `https://tricigo.com/support`
- Marketing URL: `https://tricigo.com`

**Client es-MX**: contenido de `apps/client/store-metadata/es/listing.md`:
- Subtitle: `Bicitaxis y viajes urbanos`
- Description: el cuerpo del .md
- **Keywords (PRIVADO)**: `habana,cuba,bicitaxi,taxi habana,transporte,viaje,ride,triciclo,movilidad,chofer` ← acá Cuba/Habana SÍ es seguro porque NO se publica en HTML público
- Promotional text: ver `aso-keywords-private.md`

**Driver**: idem con `apps/driver/store-metadata/{en,es}/listing.md`. Keywords privados driver: `conductor,bicitaxista,habana,cuba,driver,taxi,ganancias,viajes,empleo,trabajo`.

### 1.7 App Review Information

Por cada app:

1. **Demo account credentials**: ver sección 5 abajo (crear los reviewer accounts)
2. **Notes**: pegar el contenido completo de `apps/{client,driver}/store-metadata/app-store-review-notes.md`
3. **Contact information**: edua56621636@gmail.com

**Tiempo**: 15 min por app.

### 1.8 Age Rating

Cuestionario en App Store Connect. Para TriciGo, todas las respuestas son "None":
- No violence, no profanity, no gambling, no medical info, etc.
- Resultado esperado: **4+** (todos los públicos)

### 1.9 Trader Status (DSA — UE)

App Store Connect → My Apps → TriciGo → App Information → Trader Status:

- Si vas a distribuir en UE: **YES, declarar como Trader** y completar:
  - Business name (legal entity de 0.1)
  - Address (de la entidad fuera de Cuba)
  - Email comercial
  - Phone
- Sin esto la app NO aparece en stores europeos desde 2024 (DSA art. 30/31).

**Tiempo**: 30 min, requiere datos de la entity legal.

---

## 2. Google Play Console (Android) — configuración manual

### 2.1 Crear apps en Play Console

1. https://play.google.com/console → Create app
2. **App 1 — TriciGo (cliente)**
   - Default language: Spanish (Latin America) — `es-419`
   - App type: App
   - Free
   - Declarations: aceptar Developer Program Policies + US Export laws
3. **App 2 — TriciGo Driver**
   - Same flow

### 2.2 Service account para EAS Submit

1. https://console.cloud.google.com → crear proyecto
2. Activar Google Play Android Developer API
3. IAM → Service Accounts → crear nuevo
4. Generar key JSON → descargar a tu máquina como `google-service-account.json`
5. Play Console → Setup → API access → link al service account → otorgar Release manager + Edit store listing
6. Mover el JSON a un lugar seguro (NO commitearlo)
7. **Primera submission DEBE ser manual** vía drag-and-drop del .aab. Después de que Google la procesa, las siguientes pueden ser via `eas submit -p android`.

**Tiempo**: 1-2 horas (incluye espera de propagación).

### 2.3 Store listing

Por cada app, en cada language tab (en-US, es-419):

- Pegar contenido de `apps/{client,driver}/store-metadata/{en,es}/listing.md`
- Short description: 80 chars max
- Full description: 4000 chars max
- Screenshots: ver sección 4 abajo
- Feature graphic 1024×500 px JPG/PNG sin alpha — **falta crear**
- App icon 512×512 PNG con alpha — usar `apps/{app}/assets/icon.png` redimensionado

### 2.4 Data Safety form

Play Console → Policy and programs → App content → Data safety:

Llenar exactamente con el contenido de `apps/{client,driver}/store-metadata/data-safety.md`. El draft está organizado por categoría exactamente como Google lo pide.

**Tiempo**: 1 hora por app (es tedioso pero el draft tiene todas las respuestas).

### 2.5 Background Location declaration (SOLO driver app)

Play Console → Policy and programs → App content → Permission declarations → "Use of restricted permissions":

1. Marcar `ACCESS_BACKGROUND_LOCATION`
2. Use case: **"Driver location for ride matching and tracking"**
3. Compliance: marcar "Yes, this app meets the Location permissions policy"
4. **Video upload**: subir el video de demo (~30s) — **falta grabar** (sección 4.4)
5. Prominent disclosure description: "TriciGo Driver muestra una pantalla explicativa antes de pedir el permiso del SO, con las palabras 'ubicación' y 'segundo plano' visibles. Solo se solicita después de que el conductor toggle 'Conectarme'."
6. Privacy policy URL: `https://tricigo.com/privacy`

**Tiempo**: 1 hora (sin contar grabación del video).

### 2.6 Content rating

Cuestionario IARC. Todas las respuestas "No" para TriciGo. Target audience: 18+ (importante — evita policy de Families).

### 2.7 Geographic targeting

Pricing & Distribution → Countries:
- Marcar manualmente: México, Argentina, España, Colombia, Chile, Perú, Venezuela, Ecuador, Uruguay, Brasil, USA
- Cuba: si aparece (depende de OFAC), marcarla.

### 2.8 Closed testing track (REQUISITO para cuentas nuevas post-2023)

**ESTO ES CRÍTICO Y BLOQUEA POR 14 DÍAS.** Si tu Google Play Console fue creada después del 13 nov 2023 como Personal, necesitás:

1. Crear closed testing track con AAB
2. Reclutar **mínimo 12 testers** (familia, amigos, contactos)
3. Mantener el test activo por **14 días continuos**
4. Después podés solicitar promoción a Production

**Si tu cuenta es Organization (recomendado), este requisito está exento.**

**Empezar ASAP** si vas con Personal. El test puede correr en paralelo con el resto del trabajo.

---

## 3. Backend — preparación de producción

### 3.1 Verificar migraciones aplicadas

```bash
# Listar migraciones en prod
gh workflow run ... # o usar Supabase MCP / dashboard
```

Migraciones críticas que deben estar aplicadas:
- `00257_driver_preferences`
- `00258_driver_personal_peak_hours`
- `00259_driver_recurring_shifts`
- `00260_driver_performance_trend`
- `00261_driver_work_sessions`
- `00262_find_best_drivers_respect_preferences`
- `00263_fix_driver_work_session_trigger_rls` ← aplicada via MCP en sesión 2026-05-06

**Verificar en Supabase Dashboard** → Database → Migrations.

### 3.2 Stripe production keys

En `platform_config` table, después de tener la cuenta Stripe live:

```sql
UPDATE platform_config SET value = '"pk_live_...REAL_KEY..."' WHERE key = 'stripe_publishable_key';
UPDATE platform_config SET value = '"sk_live_...REAL_KEY..."' WHERE key = 'stripe_secret_key';
UPDATE platform_config SET value = 'true' WHERE key = 'stripe_enabled';
```

⚠️ NO hardcodear secret keys en código. Solo en platform_config (Supabase RLS protege).

### 3.3 Cron jobs y edge functions

Verificar que están deployed y activos:
- `create-stripe-payment-intent` (con IP filter ya implementado)
- `process-stripe-webhook`
- `broadcast-emergency`
- `send-sms-otp`
- otros que usemos

```bash
# Lista
supabase functions list  # o via MCP
```

### 3.4 Configurar webhooks Stripe

Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://lqaufszburqvlslpcuac.supabase.co/functions/v1/process-stripe-webhook`
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
- Signing secret: copiar al `platform_config.stripe_webhook_secret`

---

## 4. Assets — generar antes de submit

### 4.1 App icons

**iOS** (`apps/{client,driver}/assets/icon.png`):
- ✅ Existe pero verificar:
  - 1024×1024 px exacto
  - Sin canal alpha (transparencia)
  - PNG 24-bit
  - No rounded corners (Apple los aplica)

Comando para verificar:
```bash
sips -g all assets/icon.png
# Debe decir: pixelWidth: 1024, pixelHeight: 1024, hasAlpha: no
```

Si tiene alpha:
```bash
# Conversión con ImageMagick
magick assets/icon.png -background white -alpha remove -alpha off assets/icon.png
```

### 4.2 Screenshots App Store

**Tamaños obligatorios**:
- iPhone 6.9" (iPhone 16 Pro Max): **1320×2868 px** (porque Apple escala desde acá a 6.7", 6.5", 6.1", 5.5")
- iPad 13" (si supportsTablet): 2064×2752 px (NO necesario porque tenemos `supportsTablet: false`)

**Screenshots Google Play**:
- Phone: 1080×2400 px (Pixel 7 ratio)

**Cantidad**: 5-8 screenshots por device, en orden:
1. Login / pantalla de bienvenida
2. Home con mapa
3. Selección de destino / búsqueda
4. Confirmación de viaje con precio
5. Seguimiento en mapa
6. Wallet / Earnings (driver)
7. Profile

**Cómo generar**:
```bash
# iOS Simulator (Mac)
# 1. Abrir iOS Simulator con iPhone 16 Pro Max
# 2. Cargar la app
# 3. Cmd+S para screenshot — se guarda en Desktop a 1320×2868
```

```bash
# Android Studio Emulator
# 1. Abrir AVD Pixel 7 API 35
# 2. Botón Camera en sidebar → Screenshot
# 3. Se guarda a 1080×2400
```

**Guardar en**:
- `apps/client/store-metadata/screenshots/ios/` (5 archivos)
- `apps/client/store-metadata/screenshots/android/` (5 archivos)
- Idem driver

### 4.3 Feature graphic Google Play (1024×500)

- Banner horizontal que aparece arriba en Play Store
- Sugerencia: logo + screenshot mock + tagline genérico
- Guardar como `apps/{app}/store-metadata/feature-graphic.png`
- **Falta diseñar/crear** (~1 h con Canva o Figma)

### 4.4 Background location demo video (SOLO driver)

Requisito de Google Play Background Location declaration:
- Duración: ~30 segundos máx
- Formato: MP4 H.264, 1080p
- Plataforma: Android (NO iOS)
- Contenido obligatorio en orden:
  1. Pantalla del driver app antes de pedir permisos
  2. Toggle "Conectarme" → aparece prominent disclosure custom (modal con palabras "ubicación" y "segundo plano")
  3. User acepta → aparece system permission alert
  4. User selecciona "Permitir siempre"
  5. Demostrar que la feature funciona en background (driver acepta un viaje, app va a background, pasajero ve actualizar la posición en otra pantalla)

**Cómo grabar**:
```bash
# Android Studio Emulator
# Ejecutar la app en emulator Pixel 7
# Iniciar grabación: View → Tool Windows → Logcat → screen record button
# O usar adb:
adb shell screenrecord /sdcard/demo.mp4
# (CTRL+C para parar)
adb pull /sdcard/demo.mp4 ~/Desktop/background-location-demo.mp4
```

Subir a Play Console → Permission declaration → "Use of restricted permissions" → upload video.

**Guardar también en repo**: `apps/driver/store-metadata/background-location-demo.mp4` (gitignored si pesa >50MB).

---

## 5. Demo accounts para reviewers

### 5.1 Crear cuentas en Supabase

```sql
-- Reviewer rider account
INSERT INTO auth.users (id, email, phone, ...) VALUES
  (gen_random_uuid(), 'reviewer-rider@tricigo.app', '+14155550100', ...);

-- Pre-fundar wallet con $50 USD = ~26000 CUP
INSERT INTO wallet_accounts (user_id, balance_cup, balance_usd, ...) VALUES
  ((SELECT id FROM users WHERE email='reviewer-rider@tricigo.app'), 26000, 50, ...);

-- Una ride completada para historial
INSERT INTO rides (customer_id, status, ...) VALUES
  ((SELECT id FROM users WHERE email='reviewer-rider@tricigo.app'), 'completed', ...);

-- Reviewer driver account
INSERT INTO auth.users (id, email, phone, ...) VALUES
  (gen_random_uuid(), 'reviewer-driver@tricigo.app', '+14155550101', ...);

-- Driver profile aprobado
INSERT INTO driver_profiles (user_id, status, ...) VALUES
  ((SELECT id FROM users WHERE email='reviewer-driver@tricigo.app'), 'approved', ...);
```

### 5.2 Override OTP para reviewer phones

En el edge function de SMS OTP, agregar bypass:
```typescript
// Solo para los 2 reviewer phones
const REVIEWER_PHONES = ['+14155550100', '+14155550101'];
if (REVIEWER_PHONES.includes(phone)) {
  // Aceptar OTP "000000" sin enviar SMS real
  return { otp: '000000', skip_send: true };
}
```

### 5.3 Documentar credentials en review notes

Las credenciales ya están en plantilla en:
- `apps/client/store-metadata/app-store-review-notes.md`
- `apps/driver/store-metadata/app-store-review-notes.md`

Solo reemplazar `<fill in before submit>` con la password real (si decidís usar email/password en lugar de OTP).

**Tiempo total sección 5**: 2 horas.

---

## 6. CI/CD y builds

### 6.1 Disparar primer production build

Después de tener todo lo anterior:

```bash
cd apps/client
eas build --platform all --profile production

cd apps/driver
eas build --platform all --profile production
```

**Tiempo cada build**: 15-30 min en EAS.

### 6.2 Submit a stores

```bash
# iOS (después de tener Apple credentials en eas.json)
cd apps/client
eas submit --platform ios --latest

cd apps/driver
eas submit --platform ios --latest

# Android (después del primer manual upload, los siguientes via CLI)
cd apps/client
eas submit --platform android --latest

cd apps/driver
eas submit --platform android --latest
```

### 6.3 Tiempos esperados de review

- **App Store**: 24-48 h (mediana). 90% se aprueba en <24 h. Picos de delay en septiembre (iPhone launch) y diciembre.
- **Google Play primera vez**: 3-7 días. Cuenta nueva post-2023 puede tomar más.
- **App Store Connect Beta App Review** (TestFlight external): 24-48 h primera vez, después suele ser instant.

---

## 7. Marketing pre-launch (opcional)

### 7.1 Landing page

`tricigo.com` ya tiene la landing limpia (sin Cuba/Havana en HTML público, ver auditoría 2026-05-06). Verificar:
- Privacy policy en `tricigo.com/privacy`
- Terms en `tricigo.com/terms`
- Support en `tricigo.com/support` (si lo tenés, sino crear)

### 7.2 Social media accounts

NO mencionar Cuba/Havana en los public-facing handles ni descripciones. Razón: Stripe scrapers crawlean Twitter/X profile, Instagram bio, LinkedIn company page.

### 7.3 Press kit

Generar PDF/zip con:
- App logo en varios tamaños
- Screenshots
- Descripción genérica (no Cuba)
- Press contact email

---

## 8. Post-launch monitoring

### 8.1 Sentry alerts

Configurar alertas para:
- Crash rate > 1%
- Error rate > 5%
- ANR rate > 0.5% (Android)

### 8.2 Stripe Radar y Disputes

Activar Stripe Radar (anti-fraud automatic). Configurar alerts para:
- Disputes / chargebacks
- Suspicious activity
- Refund rate > 5%

### 8.3 Posthog Analytics

Verificar que eventos clave loguean:
- `ride_created`, `ride_accepted`, `ride_completed`, `ride_canceled`
- `wallet_recharge_initiated`, `wallet_recharge_succeeded`
- `driver_went_online`, `driver_went_offline`

### 8.4 Plan rollout gradual

**iOS**: Phased Release (default Apple) — 1%/2%/5%/10%/20%/50%/100% en 7 días
**Android**: Staged Rollout manual — 1% → 5% → 20% → 50% → 100%, monitorear crash rate entre cada salto. Pausar si > 1%.

---

## 9. Lista canónica de comandos útiles

```bash
# Verificar typecheck
cd apps/client && pnpm check-types
cd apps/driver && pnpm check-types

# Lint
cd apps/client && pnpm lint
cd apps/driver && pnpm lint

# Tests
pnpm test

# Build local APK (debug standalone, no Metro)
gh workflow run android-apk.yml --ref master -f app=client
gh workflow run android-apk.yml --ref master -f app=driver

# Build EAS production
cd apps/client && eas build --platform all --profile production
cd apps/driver && eas build --platform all --profile production

# Submit to stores
eas submit --platform ios --latest
eas submit --platform android --latest

# Validar app.json sintaxis
node -e "JSON.parse(require('fs').readFileSync('apps/client/app.json'))"
node -e "JSON.parse(require('fs').readFileSync('apps/driver/app.json'))"

# Ver migraciones pendientes
# (via Supabase MCP o dashboard)
```

---

## 10. Checklist final pre-submission (en orden)

Marcá esto como TODOs en tu task tracker:

### Fase 0 — Bloqueantes legales (SEMANA 1-3)
- [ ] Constituir entity legal fuera de Cuba (Stripe Atlas / Estonia / España)
- [ ] D-U-N-S Number (gratis, ~14 días)
- [ ] Apple Developer Program ($99/año, organization)
- [ ] Google Play Console ($25 one-time, organization)
- [ ] Stripe account live mode (linked a la entity legal)

### Fase 1 — Backend & infrastructure (PARALELO con Fase 0)
- [ ] Supabase Pro plan
- [ ] Stripe webhooks configurados
- [ ] Stripe production keys en `platform_config`
- [ ] Verificar migraciones 00257-00263 aplicadas
- [ ] Crear `reviewer-rider@tricigo.app` y `reviewer-driver@tricigo.app` en Supabase con datos demo
- [ ] OTP bypass para los 2 phones reviewer

### Fase 2 — Apple Developer setup (DESPUÉS de Fase 0)
- [ ] Crear ambos Bundle IDs en Certificates, Identifiers & Profiles
- [ ] Activar capabilities (Push, Background Modes, Sign in Apple, Associated Domains, App Attest) — ambos
- [ ] Apple Team ID + ascAppId → llenar en `apps/{client,driver}/eas.json`
- [ ] App Store Connect: crear ambas apps
- [ ] App Privacy section (matchear con `PrivacyInfo.xcprivacy`)
- [ ] Pricing & Availability (territories)
- [ ] Localizable info (en-US + es-MX) — pegar de `store-metadata/*/listing.md`
- [ ] Keywords field privado — pegar de `aso-keywords-private.md` (incluye Cuba/Habana)
- [ ] Trader status DSA (si distribuís en UE)
- [ ] App Review Information con demo credentials + reviewer notes

### Fase 3 — Google Play Console setup (DESPUÉS de Fase 0)
- [ ] Crear ambas apps en Play Console
- [ ] Service account + JSON para EAS Submit
- [ ] Store listings (en-US + es-419)
- [ ] Data Safety form (usar drafts en `data-safety.md`)
- [ ] Background Location declaration form (driver) + video demo
- [ ] Content rating IARC
- [ ] Geographic targeting
- [ ] **Closed testing track con 12 testers × 14 días** (si Personal account)

### Fase 4 — Assets (PARALELO con Fase 2-3)
- [ ] App icon 1024×1024 sin alpha verificado
- [ ] Screenshots iPhone 6.9" — 5 por app
- [ ] Screenshots Pixel 7 — 5 por app
- [ ] Feature graphic 1024×500 (Play Store)
- [ ] Background location video ~30s (driver, Android)

### Fase 5 — Code freeze + builds (FINAL)
- [ ] Pull latest master
- [ ] `pnpm install` clean
- [ ] `pnpm check-types` verde en client y driver
- [ ] `pnpm lint` verde
- [ ] `pnpm test` verde
- [ ] `eas build --platform all --profile production` para client
- [ ] `eas build --platform all --profile production` para driver
- [ ] Smoke test los 4 binaries (iOS+Android × client+driver) en device real con la cuenta demo

### Fase 6 — Submit
- [ ] App Store: `eas submit --platform ios` para ambos
- [ ] Google Play: primera submission manual via consola, después `eas submit`
- [ ] Submit for review en App Store Connect (botón Submit)
- [ ] Promote to Production en Play Console (después del closed test si aplica)

### Fase 7 — Esperar y responder
- [ ] Apple review: 24-48 h. Tener inbox abierto para responder dudas del reviewer.
- [ ] Google review: 3-7 días primera vez.
- [ ] Si rechazo: leer el motivo con calma, ajustar (NO discutir), re-submit.

### Fase 8 — Post-launch (DESPUÉS de aprobación)
- [ ] Phased Release iOS activado (default)
- [ ] Staged Rollout Android manual 1% → 100%
- [ ] Monitor Sentry + Stripe + PostHog primeras 72 h
- [ ] Plan de hotfix vía OTA Updates si se detectan bugs (`eas update --branch production`)

---

## 11. Riesgos conocidos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Stripe cierra el account después de 30-90 días | Alta sin entity fuera de Cuba | Existencial | Resolver Fase 0.1 antes de live |
| Apple rechaza por Guideline 3.1.1 (wallet vs IAP) | Media | Re-submit | Reviewer notes + disclaimer in-app ya implementados |
| Google bloquea por background location form mal llenado | Media-alta | Re-submit | Video demo de calidad + prominent disclosure verificado |
| Google rechaza por mismatch Data Safety vs comportamiento | Media | Re-submit | Draft `data-safety.md` matchea exactamente con código |
| iOS review descubre crash en el demo flow | Media | Re-submit | Tests exhaustivos en simulator iPhone 16 Pro Max + iPad |
| Privacy Manifest API mismatch | Baja | Re-submit | `PrivacyInfo.xcprivacy` declara Required Reasons exactos |
| Trademark conflict de "TriciGo" | Baja-media | Re-naming | Buscar en USPTO/EUIPO antes de submit |
| OFAC/CACR investigation de drivers cubanos | Baja-media | Cierre Stripe + posibles multas | Disclaimer legal en onboarding driver + entity fuera de Cuba |

---

## 12. Documentos referenciados

| Archivo | Para qué sirve |
|---|---|
| `apps/client/store-metadata/en/listing.md` | Pegar en App Store Connect / Play Console — English |
| `apps/client/store-metadata/es/listing.md` | Pegar en App Store Connect / Play Console — Spanish |
| `apps/client/store-metadata/aso-keywords-private.md` | Keywords privados para campos NO publicados (Cuba/Habana OK acá) + Stripe business profile |
| `apps/client/store-metadata/app-store-review-notes.md` | Pegar en App Store Connect → App Review Information → Notes |
| `apps/client/store-metadata/data-safety.md` | Llenar Play Console → Data safety section |
| `apps/client/PrivacyInfo.xcprivacy` | Apple Privacy Manifest, se inyecta automáticamente al .app via plugin |
| `apps/client/plugins/with-privacy-manifest.js` | Config plugin que inyecta el manifest al pbxproj |
| `apps/driver/...` | Idem todos los anteriores para driver |
| `PRODUCTION_READINESS.md` | Este archivo |

---

## 13. Contacto y handoff

- **Developer**: edua56621636@gmail.com
- **App support**: soporte@tricigo.com
- **Driver support**: conductores@tricigo.com
- **Repo**: github.com/AgenciaSeniors/TriciGo
- **Branch para production**: `master`
- **Última auditoría**: 2026-05-06 (commit `05d52d6`)
- **Siguiente revisión recomendada**: 30 días post-launch

---

**Cuando completes una sección, tachá los TODOs en este archivo y commiteá el progreso.**
