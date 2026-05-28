# Launch — External Accounts Setup Guide

> **Estado**: Active — TriciGo está ~95% listo en código. Solo bloquean cuentas externas con KYC + pago.
> **Audiencia**: Founder Eduardo. Steps para crear cada cuenta + qué devolver al equipo dev para que se wireee.
> **Última actualización**: 2026-05-28 — supersedes `docs/BLOQUEANTES.md` (que tenía Twilio/Stripe outdated).

---

## Resumen ejecutivo

| Servicio | Costo | KYC requerido | Tiempo aprobación | Bloqueante de |
|---|---|---|---|---|
| **Apple Developer** | $99/año | D-U-N-S (org) o ID personal | 24-72 hs (org), instant (individual) | iOS TestFlight + App Store |
| **Google Play Console** | $25 one-time | ID + dirección + tarjeta | Instant (cuenta), 1-3 días (developer status) | Android Release AAB |
| **D7 Networks** | ~$5-10/mes uso real | Business email + KYC ligero | Instant signup, 1-3 días sender ID | OTP signup/login Cuba |
| **Resend** | $20/mes (50k emails) | Solo dominio verification | Instant | Email auth + receipts profesional |
| **Supabase Pro** | $25/mes | Solo tarjeta | Instant | Backups daily + PITR |
| **Google Places API** | ~$5/mes | Ya cuenta creada — solo key | N/A | Search Google (no bloqueante crítico) |

**Total one-time**: $124 (Apple + Google Play)
**Total mensual fijo**: ~$70 (Supabase + Resend + D7 + Places + VPS)

---

## A.1 — Apple Developer Program ($99/año)

### Pre-requisitos
- Apple ID dedicado para empresa (NO uses tu personal). Ejemplo: `dev@tricigo.com` o cuenta dedicada.
- Si te enrolas como **Organization** (recomendado): necesitás **D-U-N-S Number** (gratis, se obtiene en https://www.dnb.com/duns-number/get-a-duns.html — toma 1-5 días hábiles).
- Si te enrolas como **Individual** (más rápido pero menos profesional): solo ID + tarjeta.

### Steps

1. **Crear Apple ID dedicado**
   - Ir a https://appleid.apple.com/account
   - Crear con email empresarial. Activar 2FA con número telefónico empresarial.

2. **Enrollar en Developer Program**
   - Ir a https://developer.apple.com/programs/enroll/
   - Login con Apple ID dedicado.
   - Seleccionar **Organization** (preferido) o **Individual**.
   - Si Organization: ingresar D-U-N-S Number, dirección legal empresa.
   - Aceptar Apple Developer Program License Agreement.
   - Pagar **$99 USD/año** con tarjeta.
   - Esperar email de approval. Para Individual es instantáneo. Para Organization toma 24-72 horas (Apple verifica empresa).

3. **Obtener Team ID**
   - Una vez aprobado: https://developer.apple.com/account/#/membership
   - Copia el campo **Team ID** (formato `XXXXXXXXXX`, 10 caracteres alfanuméricos).

4. **Crear apps en App Store Connect**
   - Ir a https://appstoreconnect.apple.com/apps
   - Click "+ App" — crear **DOS apps separadas**:

   **App 1: TriciGo Cliente**
   - Platform: iOS
   - Name: `TriciGo Cliente`
   - Primary Language: Spanish (Latin America)
   - Bundle ID: `app.tricigo.client` (debe existir; si no, crearlo primero en Certificates, IDs & Profiles)
   - SKU: `tricigo-client-001`
   - User Access: Full Access

   **App 2: TriciGo Conductor**
   - Igual pero Name: `TriciGo Conductor`, Bundle ID: `app.tricigo.driver`, SKU: `tricigo-driver-001`

5. **Obtener ASC App ID de cada app**
   - Después de crear cada app, ir a App Information → la URL del navegador contiene el ID:
     `https://appstoreconnect.apple.com/apps/1234567890/appstore/info`
   - Copia el número (`1234567890`) — ese es el **ASC App ID**.

### Lo que devolver al equipo dev

Pasame este YAML cuando esté listo:

```yaml
apple:
  team_id: "XXXXXXXXXX"
  developer_email: "dev@tricigo.com"  # para reset access en futuro
  asc_app_id_client: "1234567890"
  asc_app_id_driver: "1234567891"
```

Yo wireo en `apps/{client,driver}/eas.json`.

---

## A.2 — Google Play Console ($25 one-time)

### Steps

1. **Crear cuenta Google Workspace dedicada** (mismo enfoque que Apple).
2. **Registrarse como Developer**
   - Ir a https://play.google.com/console/signup
   - $25 one-time payment (tarjeta).
   - KYC: ID + selfie + dirección postal verificable.
3. **Crear ambas apps en Play Console**

   **App 1: TriciGo Cliente**
   - Create app → Default language: Spanish (Latin America)
   - App name: `TriciGo Cliente`
   - Free / paid: Free (con in-app purchases si TriciCoin se monetiza)
   - Declarations: leer y aceptar todas
   - Package name: `app.tricigo.client` (debe coincidir con `apps/client/app.json`)

   **App 2: TriciGo Conductor** — igual con `app.tricigo.driver`.

4. **Crear Service Account para cada app** (para uploads automáticos desde EAS)
   - Para cada app: Setup → API access → Link Google Cloud project (crear nuevo "tricigo-play-uploads")
   - Crear Service Account: nombre `eas-play-uploader-{client|driver}`
   - Permission: "Service Account User" en Play Console
   - En Google Cloud Console: IAM → Service Accounts → la SA recién creada → Keys → Add Key → JSON
   - Descargar `client-google-service-account.json` y `driver-google-service-account.json`

5. **Subir como GitHub Secret**
   - Codificar base64 cada archivo:
     ```bash
     base64 -i client-google-service-account.json > client-sa-b64.txt
     base64 -i driver-google-service-account.json > driver-sa-b64.txt
     ```
   - En https://github.com/AgenciaSeniors/TriciGo/settings/secrets/actions agregar:
     - `GOOGLE_PLAY_SA_CLIENT_JSON_B64` ← contenido de `client-sa-b64.txt`
     - `GOOGLE_PLAY_SA_DRIVER_JSON_B64` ← contenido de `driver-sa-b64.txt`

### Lo que devolver al equipo dev

```yaml
google_play:
  developer_email: "dev@tricigo.com"
  github_secrets_added: true  # confirmar
  service_account_email_client: "eas-play-uploader-client@tricigo-play-uploads.iam.gserviceaccount.com"
  service_account_email_driver: "eas-play-uploader-driver@tricigo-play-uploads.iam.gserviceaccount.com"
```

Yo wireo en `eas.json` con `serviceAccountKeyPath` que apunte a donde EAS extrae el secret durante build.

---

## A.3 — D7 Networks (SMS OTP para Cuba)

> **Nota**: TriciGo cambió de Twilio a **D7 Networks** porque Twilio no cubría +53 (Cuba) confiablemente. D7 sí soporta Cuba con buena entrega.

### Steps

1. **Signup**
   - https://www.d7networks.com/signup
   - Business email (`admin@tricigo.com`).
   - Verificar email.

2. **Pagar saldo prepaid mínimo**
   - Dashboard → Add credits → $20 mínimo recomendado para arrancar.
   - ~250-400 SMS a Cuba según país de envío.
   - Pago via tarjeta o crypto.

3. **Solicitar Sender ID alphanumeric**
   - Dashboard → Sender IDs → Request New
   - **Sender ID**: `TRICIGO` (max 11 caracteres alphanumeric)
   - País de destino: Cuba (+53)
   - Use case: "OTP for mobile app login"
   - Aprobación: 1-3 días hábiles. Cuba acepta alphanumeric senders.

4. **Obtener API Token**
   - Dashboard → API Keys → Generate New Key
   - Copy token (formato JWT-like long string).
   - **Guardar inmediatamente** — no se puede recuperar después.

### Lo que devolver al equipo dev

```yaml
d7_networks:
  api_token: "eyJ0eXAi..."  # el JWT/token completo
  sender_id: "TRICIGO"
  initial_credits_usd: 20
```

Yo seteo en Supabase EF secrets:
```bash
supabase secrets set D7_API_TOKEN=xxx --project-ref lqaufszburqvlslpcuac
supabase secrets set D7_SENDER_ID=TRICIGO --project-ref lqaufszburqvlslpcuac
```

Y verifico que `supabase/functions/send-sms-otp/index.ts` los usa correctamente.

### Validación post-setup

Enviá SMS de prueba a tu propio número cubano:
```bash
curl -X POST https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms-otp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -d '{"phone":"+53XXXXXXXX","code":"123456"}'
```

Debe llegar SMS en 30-60 segundos con "TRICIGO" como sender.

---

## A.4 — Google Places API Key

> **Estado**: Cuenta Google Cloud ya creada en sesión previa (2026-05-26). Solo falta wirear el secret.

### Steps

1. **Recuperar API key existente**
   - Ir a https://console.cloud.google.com/apis/credentials
   - Selecciona proyecto "TriciGo Backend - Places API"
   - Buscá API key llamada "search-places-google-ef" (o similar)
   - Click "SHOW KEY" → copia.

2. **Verificar restrictions**
   - Application restrictions: None (es server-side, no app)
   - API restrictions: solo `Places API (New)` + `Geocoding API` habilitados
   - Daily quota: 1000 requests/día (cap blando, billing protection)

3. **Setear secret en Supabase EF**

### Lo que devolver

```yaml
google_places:
  api_key: "AIzaSy..."
```

Yo seteo:
```bash
supabase secrets set GOOGLE_PLACES_API_KEY=xxx --project-ref lqaufszburqvlslpcuac
```

### Validación

Probar búsqueda:
```bash
curl -X POST https://lqaufszburqvlslpcuac.supabase.co/functions/v1/search-places-google \
  -H "Authorization: Bearer <ANON_KEY>" \
  -d '{"query":"hotel boutique malecon","proximity":{"latitude":23.13,"longitude":-82.36}}'
```

Debe retornar resultados Google reales (no fallback Mapbox).

---

## A.5 — Supabase Pro upgrade ($25/mes)

### Steps

1. **Ir a billing**: https://supabase.com/dashboard/project/lqaufszburqvlslpcuac/settings/billing
2. **Verificar plan actual**: si dice "Free", click "Change Plan" → seleccionar **Pro** ($25/mes).
3. **Confirmar features Pro**:
   - ✅ Daily automated backups (7 días retention)
   - ✅ Point-in-Time Recovery (PITR)
   - ✅ Mayor compute (4 GB RAM, 2 vCPU)
   - ✅ Mayor storage (8 GB DB + 100 GB transfer)
   - ✅ Email support (response 24-48h)
4. **Verificar tarjeta + billing email** correctos.
5. **Confirmar backup primero** se ejecuta al día siguiente (validar 24h después en Dashboard → Database → Backups).

### Lo que devolver

```yaml
supabase_pro: confirmed_active
backup_first_run_verified: <fecha YYYY-MM-DD>
```

---

## A.6 — Resend (Email provider profesional)

### Steps

1. **Crear cuenta**: https://resend.com/signup
2. **Verificar dominio `tricigo.com`**:
   - Dashboard → Domains → Add Domain → `tricigo.com`
   - Agregar 3 records DNS (copy-paste desde Resend):
     - `_dmarc` TXT
     - `resend._domainkey` TXT
     - `send` MX
   - Wait DNS propagation (~5-30 min).
   - Click "Verify" en Resend dashboard → debe marcar ✅ los 3 records.
3. **Obtener API key**
   - Settings → API Keys → Create API Key
   - Permission: `Sending Access` para `tricigo.com`.
   - Copy key (formato `re_XXXXXXXX`).

### Lo que devolver

```yaml
resend:
  api_key: "re_XXXXXXXX"
  domain_verified: true
  sender_default: "no-reply@tricigo.com"
```

Yo configuro Supabase Auth para usar SMTP custom apuntando a Resend:
- Dashboard → Authentication → Settings → SMTP Settings
- Host: `smtp.resend.com`, Port: `587`, Username: `resend`, Password: `<API_KEY>`
- Sender: `no-reply@tricigo.com`

---

## A.7 — DNS access (registrador del dominio)

### Pre-requisito para Rama D (web + email)

- Confirmar dónde está registrado `tricigo.com` (GoDaddy, Namecheap, Hostinger, otro).
- Obtener acceso al panel DNS — necesario para:
  - **Resend** records (A.6)
  - **VPS web** A record + `www.tricigo.com` CNAME
  - **Apple Universal Links** verification (`.well-known/apple-app-site-association`)
  - **Google Asset Links** (`.well-known/assetlinks.json`)
  - (Opcional) Supabase custom auth domain

### Lo que devolver

```yaml
dns:
  registrar: "Namecheap"  # o el que sea
  access_confirmed: true
  current_vps_ip: "XXX.XXX.XXX.XXX"  # IP del servidor VPS donde corre apps/web
```

---

## Resumen del output completo

Cuando tengas todo listo, devolveme ESTE bloque YAML completo:

```yaml
# TriciGo — External Accounts Configuration (READY FOR LAUNCH)

apple:
  team_id: "XXXXXXXXXX"
  developer_email: "dev@tricigo.com"
  asc_app_id_client: "1234567890"
  asc_app_id_driver: "1234567891"

google_play:
  developer_email: "dev@tricigo.com"
  github_secrets_added: true
  service_account_email_client: "eas-play-uploader-client@..."
  service_account_email_driver: "eas-play-uploader-driver@..."

d7_networks:
  api_token: "eyJ0eXAi..."
  sender_id: "TRICIGO"
  initial_credits_usd: 20

google_places:
  api_key: "AIzaSy..."

supabase_pro: confirmed_active
backup_first_run_verified: "2026-05-29"

resend:
  api_key: "re_XXXXXXXX"
  domain_verified: true
  sender_default: "no-reply@tricigo.com"

dns:
  registrar: "Namecheap"
  access_confirmed: true
  current_vps_ip: "XXX.XXX.XXX.XXX"
```

---

## Mientras tanto, ¿qué hago yo?

Ramas que no dependen de tus cuentas externas y voy ejecutando en paralelo:

- **Rama C — Backend prod hardening**: data retention policy, DR runbook, monitoring queries, alertas Sentry.
- **Rama D parts**: email templates verify, web SEO meta tags, status page setup (lo que no requiere DNS).

Cuando me entregues el YAML output, ejecuto **Rama B (mobile stores config + assets)** que es el último wire que une todo para submit a stores.

---

## Referencia histórica

- `docs/BLOQUEANTES.md` (22 marzo 2026) — **superseded**: menciona Twilio + Stripe (ya migrados a D7 + NETOPIA respectivamente).
- `docs/D7_SMS_SETUP.md` — referencia técnica del Edge Function que ya está integrado.
- `docs/SETUP_GOOGLE_PLACES.md` — referencia técnica de cómo se usa la API en el EF.
- `docs/RELEASE_CHECKLIST.md` (18 abr 2026) — APK builds (Fase A/B/C).
- `docs/STORE_SUBMISSION_CHECKLIST.md` — P0/P1 items para store submission.
- `docs/IOS_APPSTORE_COMPLIANCE.md` — Apple-specific compliance (ATT, IDFA, etc.).
- `docs/SECURITY_REMEDIATION.md` — audit post-remediation status.

---

## Tiempos esperados end-to-end

| Día | Tu actividad | Mi actividad paralela |
|---|---|---|
| Día 1 | A.1 (Apple D-U-N-S + enroll), A.2 (Google Play signup), A.3 (D7 signup + saldo + sender ID request) | Rama C completa, Rama D parts sin DNS |
| Día 2-3 | Esperar approvals Apple + Google + D7 sender ID. A.5 Supabase Pro inmediato. A.6 Resend signup + DNS records. | Continúa Rama C, empezar email migration Rama D |
| Día 3-5 | Recibir approvals. Crear apps en App Store Connect + Play Console. Obtener Team ID, ASC App IDs, service accounts JSON. Generar API keys. | Continúa Rama D |
| Día 5 | Entregar YAML output completo. | Empezar Rama B con valores recibidos |
| Día 5-7 | A.7 DNS access para Rama D items finales | Wireo eas.json, screenshots, production builds |
| Día 7-10 | Testing on TestFlight + Internal Track | Bug fixes |
| Día 10-14 | Submit Apps a review | Resolver review feedback |
| Día 14-21 | Live 🚀 | — |
