# TriciGo — Production Readiness Checklist

**Última actualización:** 2026-04-25
**Estado:** post-auditoría 14-tier (80+ bugs cerrados). Pendiente trabajo de cuentas, billing y deploys antes de poder llamar al producto "production-ready".

Este documento es la lista cerrada de lo que **vos** (no código) tenés que hacer antes de lanzar a producción real con usuarios reales pagando con dinero real.

Estructura:
1. Pendientes técnicos del sprint de auditoría (acción manual)
2. Servicios externos: cuentas business, paid tiers, API keys
3. App stores (Apple, Google)
4. Domain + DNS + email
5. Legal/Negocio
6. Pre-launch checklist consolidado
7. Costos mensuales estimados

---

## 1. Pendientes técnicos del sprint de auditoría

Estos requieren acción tuya/admin, no código. Ya están todos preparados a nivel código.

### 🔴 Antes de aceptar tráfico real

- [ ] **BUG-196 P1 — MFA en admins**. Cada uno de los 4 admin/super_admin debe enrolar MFA en Supabase auth (TOTP via Google Authenticator/1Password/Authy). Luego yo aplico migración `00220_is_admin_require_aal2.sql` (ya escrita en repo, no aplicada).
  - Verificación: `SELECT u.email, mf.factor_type, mf.status FROM users u LEFT JOIN auth.mfa_factors mf ON mf.user_id=u.id AND mf.status='verified' WHERE u.role IN ('admin','super_admin');` — todas las filas deben tener factor verified.
  - Rollback documentado en la migración.

- [ ] **BUG-202 P3 — verificar `assetlinks.json` hosteado**. Después de redeploy de `apps/web`:
  - `curl -i https://tricigo.com/.well-known/assetlinks.json` → 200 + `Content-Type: application/json`
  - `curl -i https://tricigo.com/.well-known/apple-app-site-association` → 200 + `Content-Type: application/json`
  - Si devuelve 404, revisar que el hosting (Vercel/Cloudflare/etc) sirva archivos en `apps/web/public/.well-known/`.

- [ ] **APK rebuild** con nuevos `intentFilters`. EAS:
  ```bash
  cd apps/driver && eas build --platform android --profile production
  cd apps/client && eas build --platform android --profile production
  ```
  Necesario para que los `intentFilters: autoVerify` lleguen al manifest del APK. Sin rebuild, el assetlinks.json sirve pero las apps no se enteran.

- [ ] **Rebuild iOS** también, mismo motivo (Universal Links via `apple-app-site-association`).

### 🟡 Hygiene

- [ ] **BUG-203 P3 — verificar tier de backup Supabase**. Dashboard → Settings → General → Database. Free tier solo 7 días retention; production debería tener PITR (Point-in-Time Recovery) que viene con Pro tier.

- [ ] **(Opcional) Purgar JWT viejo del git history**. El JWT leakeado ya no autentica (BUG-199 cerrado), pero git history lo conserva. Si te molesta:
  ```bash
  # En un clone fresco
  git filter-repo --replace-text <(echo 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSI***==>REDACTED')
  git push --force origin master
  ```
  Aviso: requiere force-push, todos los devs deben re-clonar. Bajo valor (token ya inválido).

---

## 2. Servicios externos — lo que tenés que pagar / contratar

Cada servicio incluye: tier free actual, qué precisás en producción, business email setup, instrucciones de upgrade.

### 2.1 Supabase — backend principal

**Estado actual:** Free tier (visible "FREE" en el dashboard).

**Lo que necesitás en producción:**
| Tier | Precio | Qué incluye | Suficiente para TriciGo? |
|---|---|---|---|
| Free | $0 | 500 MB DB, 1 GB file storage, 50K MAU, 7-day backups | NO — sin PITR, MAU bajo, riesgo de pausa por inactividad |
| **Pro** ⭐ | **$25/mes** | 8 GB DB, 100 GB storage, 100K MAU, **PITR**, custom SMTP, no auto-pause | **Sí, el ideal para arrancar producción** |
| Team | $599/mes | SLA, SOC2, audit logs avanzados | Solo cuando escales mucho |

**Pasos:**
1. Settings → Billing → Upgrade to Pro
2. Pago con tarjeta de crédito a nombre de TriciGo (o de tu LLC)
3. Confirmar PITR habilitado post-upgrade

**Email business para soporte/billing:**
- Crear `billing@tricigo.com` (o equivalente) y usar para la cuenta. Evitá emails personales.

---

### 2.2 Resend — emails transaccionales

**Estado actual:** Tier Free (3000 emails/mes), `RESEND_API_KEY` configurada en EFs.

**Lo que necesitás en producción:**
| Tier | Precio | Qué incluye |
|---|---|---|
| Free | $0 | 3,000 emails/mes, 100 emails/día, marca Resend en footer |
| **Pro** ⭐ | **$20/mes** | 50,000 emails/mes, sin marca, 7 dominios verificados |
| Business | $90/mes | 100K emails/mes, 5 IPs dedicadas, prioritario |

**Pasos críticos:**
1. **Verificar el dominio `tricigo.com`** en Resend dashboard. Esto requiere agregar DNS records:
   - **MX** records (si querés recibir email también)
   - **SPF**: `v=spf1 include:_spf.resend.com ~all` (TXT en root)
   - **DKIM**: 3 CNAME records (resend te los da)
   - **DMARC**: `v=DMARC1; p=quarantine; rua=mailto:dmarc@tricigo.com` (TXT en `_dmarc.tricigo.com`)
2. **Sender address**: ya configurado como `noreply@tricigo.com` en el código.
3. **Usar email business** para la cuenta Resend (no personal).
4. **Actualizar API key**: si necesitás rotar, regenerar en Resend → actualizar env var en EFs:
   - Supabase Dashboard → Edge Functions → Secrets → `RESEND_API_KEY`

---

### 2.3 SMS / OTP — esto es complejo en Cuba

TriciGo necesita SMS para:
- OTP de login (Cuba + resto del mundo)
- Notificaciones a pasajeros (ride accepted, driver arriving)
- Alertas SOS a contactos de confianza
- Marketing campaigns (`send-bulk-sms`)

**Cuba es difícil porque Twilio no tiene cobertura buena.** El código tiene 4 providers configurados:

#### A. Twilio — resto del mundo + Cuba secundario

**Estado:** keys en Edge Function env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGE_SERVICE_SID`, `TWILIO_VERIFY_SERVICE_SID`).

**Necesitás:**
- Cuenta Twilio business verificada
- Twilio Verify para OTP (precio variable, ~$0.05/verify)
- Twilio Programmable SMS para notificaciones (~$0.05/SMS)
- Comprar un número de teléfono (~$1/mes)

**Email business para Twilio:** sí, requerido para business account.

#### B. Meta WhatsApp Cloud API — primario para Cuba 🇨🇺

**Estado:** keys configuradas (`META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`). Activo en `send-sms-otp` para `+53` numbers.

**Necesitás:**
- Cuenta Meta Business verificada
- Aplicar Tricigo Business Account (KYC: documentos LLC, prueba de identidad)
- Verificar dominio `tricigo.com` en Meta Business
- Solicitar acceso a templates pre-aprobados (`otp_code` ya en uso)
- Tier Free: 1000 conversations/mes
- Después: $0.005-0.040 por mensaje según país

**Atención:** Cuba está bajo sanciones US, Meta puede tener restricciones. Verificá con Meta business support antes de scale-up.

#### C. Infobip — alternativa Cuba

**Estado:** key set en `platform_config.infobip_api_key` (71 chars). No veo uso activo en el código actual.

**Si lo querés activar para Cuba:** Infobip soporta SMS Cuba via roaming. Cuenta business + KYC. ~$0.05-0.10/SMS Cuba.

#### D. SMSPM — segunda alternativa

**Estado:** token set en `platform_config.smspm_token`. Tampoco usado activamente.

**SMSPM** es un agregador SMS que cubre Cuba via partners locales. Más barato para volumen alto en Cuba. Setup: cuenta business, prepago.

#### E. D7 Networks — la opción que mencionaste

**Estado:** **NO está configurado en código.** Si querés usarlo:
- Crear cuenta business en D7 Networks
- D7 cubre Cuba con bypass mediante operadores locales
- Pricing: ~$0.045/SMS Cuba en volumen
- Necesitarás agregar al código un nuevo path en `send-sms-otp/index.ts` y `send-sms/index.ts` similar al patrón de Meta/Twilio

**Mi recomendación:** Empezá con Meta WhatsApp para Cuba (ya integrado, free tier generoso) + Twilio para resto del mundo. Si la cobertura WhatsApp falla en Cuba, agregar D7 como fallback.

---

### 2.4 Stripe — pagos

**Estado:** keys placeholder en `platform_config.stripe_*`. Stripe deshabilitado por default (`stripe_enabled=false`).

**Necesitás:**
- Cuenta Stripe **business verificada** con KYC completo:
  - Documentos LLC/empresa
  - Cuenta bancaria business para payouts
  - DNI/Pasaporte del director
  - Comprobante de domicilio business
- País de la cuenta: depende de dónde esté legalmente registrada TriciGo (Cuba no tiene Stripe; podría ser España, Argentina, USA dependiendo de tu LLC)
- Activar webhooks: Dashboard → Developers → Webhooks → Add endpoint
  - URL: `https://lqaufszburqvlslpcuac.supabase.co/functions/v1/process-stripe-webhook`
  - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`
  - Copiar webhook secret → `platform_config.stripe_webhook_secret`

**Pricing:**
- 2.9% + $0.30 por charge exitoso
- 3.9% + $0.30 para tarjetas internacionales
- $0.25 por chargeback
- Sin fee mensual fijo

**Activación final:**
- Una vez verificado: `UPDATE platform_config SET value='true' WHERE key='stripe_enabled';`
- Reemplazar `stripe_secret_key` y `stripe_publishable_key` con keys de production (no test).

---

### 2.5 Mapbox — mapas

**Estado:** `EXPO_PUBLIC_MAPBOX_TOKEN`, `NEXT_PUBLIC_MAPBOX_TOKEN` en env. Probablemente token público existente.

**Pricing:**
- Free: 50,000 map loads/mes + 100,000 directions API calls/mes + 100,000 geocoding/mes
- Después: pay-as-you-go (~$0.50/1K loads)

**TriciGo va a saltar el free tier rápido** con conductores activos. Estimado: 200 drivers × 100 loads/día × 30 días = 600K/mes → ~$275/mes en map loads.

**Optimizaciones para reducir costo:**
- Usar tile caching agresivo
- Considerar Mapbox vs OpenStreetMap (gratis pero peor calidad)
- Mapbox tiene plan negociado para startups

**Email business:** sí, recomendado para billing.

---

### 2.6 OpenWeatherMap — surge por clima

**Estado:** `openweather_api_key` en `platform_config` (34 chars). Cron `sync-weather` cada 15 min.

**Pricing:**
- Free: 1,000 calls/día
- Cron actual: 1 call/15 min × 24 hrs = 96 calls/día → **bien dentro del free tier**

Sin acción necesaria salvo monitorear que el key no expire.

---

### 2.7 ElToque — tasa de cambio CUP/USD

**Estado:** `eltoque_api_token` en `platform_config` (297 chars — token JWT-like). Cron `sync-exchange-rate` cada hora. Fallback a scraping si la API falla.

**Pricing:** ElToque tiene API con tier paid. Tu token actual probablemente es de su API gratuita o un partner deal.

**Acción:** Verificá con ElToque que tu token sigue activo y cuál es el rate limit. Si hay tier paid, considerá pagarlo para garantizar disponibilidad (la tasa USD/CUP es crítica para todos los pricing del producto).

---

### 2.8 Sentry — error monitoring

**Estado:** `SENTRY_DSN` y `SENTRY_AUTH_TOKEN` configurados. Org=`tricigo`, project=`tricigo-web`, `tricigo-driver`, `tricigo-client`.

**Pricing:**
- Developer: $0 — 5,000 errors/mes, 1 user
- **Team**: $26/mes — 50K errors, alerts, integrations ⭐
- Business: $80/mes

**Recomendación:** Team tier. 50K errors/mes te alcanza para producción real con 10K+ usuarios. Alerts a Slack/email cuando hay error rate spike.

**Email business:** sí.

---

### 2.9 PostHog — analytics + feature flags

**Estado:** `EXPO_PUBLIC_POSTHOG_API_KEY` configurado.

**Pricing:**
- Free: 1M events/mes, 5K session recordings/mes
- Después: ~$0.00031/event

Para TriciGo en early production (1K-10K usuarios), free tier alcanza. Eventualmente pasarás a paid.

---

## 3. App stores

### 3.1 Apple Developer Program

- **Costo:** $99/año
- **Necesario para:** publicar en App Store + TestFlight + Universal Links (apple-app-site-association)
- **Setup:**
  - Inscribirse como individual o organization (organization recomendado para business)
  - Verificación DUNS Number (puede tardar 2-4 semanas)
  - Bundle IDs ya reservados: `app.tricigo.client`, `app.tricigo.driver`
  - Generar App Store Connect listings (descripciones, screenshots, video preview)

### 3.2 Google Play Console

- **Costo:** $25 one-time
- **Necesario para:** publicar en Google Play + verified deeplinks (assetlinks.json)
- **Setup:**
  - Inscribirse como organization (DUNS también recomendado)
  - Package names ya reservados: `app.tricigo.client`, `app.tricigo.driver`
  - SHA-256 fingerprints ya en assetlinks.json (`46:C4:...DB:88` para client, `95:8D:...B1:7D` para driver)
  - Crear Internal/Closed Testing tracks antes de Production
  - Privacy Policy URL (apuntar a `https://tricigo.com/privacy`)

### 3.3 EAS (Expo Application Services)

- **Estado:** projectIds existen (`bb3c1a52-...` client, `4f32a103-...` driver)
- **Tier Free:** 30 builds/mes
- **Production:** $99/mes — builds ilimitados + priority queue
- **Cuándo upgradear:** cuando tengas iteración alta de releases (semanal o más rápido)

---

## 4. Domain + DNS + Email

### 4.1 Dominio `tricigo.com`

- [ ] Verificar registro vigente y renovado por mínimo 5 años (~$15-20/año)
- [ ] Activar **registrar lock** (anti-hijacking)
- [ ] Activar **2FA** en cuenta del registrar (GoDaddy, Namecheap, Cloudflare, etc.)

### 4.2 DNS records

```
A     tricigo.com        → IP del hosting web (Vercel/Netlify/Cloudflare)
A     www.tricigo.com    → mismo IP
CNAME admin.tricigo.com  → host del admin Next.js
CNAME blog.tricigo.com   → opcional

# Email (Resend)
TXT   tricigo.com        → "v=spf1 include:_spf.resend.com ~all"
CNAME resend._domainkey.tricigo.com → resend DKIM target (Resend te lo da)
TXT   _dmarc.tricigo.com → "v=DMARC1; p=quarantine; rua=mailto:dmarc@tricigo.com"

# Verificación Meta Business / Apple / Google
TXT   tricigo.com        → "google-site-verification=..."
TXT   tricigo.com        → "facebook-domain-verification=..."
TXT   tricigo.com        → "apple-developer-domain-association=..."
```

### 4.3 Email infrastructure

Necesitás al menos estas direcciones:
- `noreply@tricigo.com` — sender de Resend (ya configurado en código)
- `soporte@tricigo.com` — soporte usuarios (ya en schema.org del web)
- `billing@tricigo.com` — facturación, cuentas en third-party services
- `seguridad@tricigo.com` — abuse / security reports
- `dmarc@tricigo.com` — recibir reports DMARC

**Setup mínimo:** Google Workspace ($6/usuario/mes) o Zoho Mail (free tier 5 usuarios).

---

## 5. Legal / Negocio

Estas son cosas que dependen de **dónde estés legalmente registrada TriciGo**. No te puedo dar respuestas finales — depende de tu jurisdicción. Pero el checklist genérico:

- [ ] **LLC / S.A. / equivalente** registrada
  - Cuba directamente: complicado por sanciones US sobre fintech/payments
  - España, Argentina, USA (Delaware), Estonia (e-Residency): opciones comunes para startups con operación en Cuba
- [ ] **Cuenta bancaria business** (necesaria para Stripe payouts)
- [ ] **DUNS Number** (gratis vía D&B, tarda 2 semanas; necesario para Apple Developer organization + Google Play organization + algunos otros B2B)
- [ ] **Términos y Condiciones revisados por abogado** (los que tenés en `cms_content.terms` son draft)
- [ ] **Política de Privacidad revisada** (idem; debe cubrir GDPR si usuarios en EU, CCPA si en California)
- [ ] **Tax setup** según jurisdicción
- [ ] **Insurance** — cobertura para conductores (responsabilidad civil), platform liability
- [ ] **Acuerdos con conductores** — independent contractor agreements

---

## 6. Pre-launch checklist consolidado

### Infraestructura técnica
- [ ] Supabase Pro tier activo + PITR habilitado
- [ ] Test data limpia (✅ ya hecho — 0 test rides)
- [ ] Wallet ledger invariant 0 mismatches (✅)
- [ ] Test suite green 401/401 (✅)
- [ ] Migración 00220 (is_admin AAL2) aplicada post-MFA enroll
- [ ] `assetlinks.json` + `apple-app-site-association` retornan 200 + JSON correctos
- [ ] APKs nuevos (driver + client) construidos y testeados
- [ ] iOS builds en TestFlight
- [ ] Sentry recibiendo errors (test triggering manual)
- [ ] PostHog recibiendo events
- [ ] Backup restore probado (NO solo verificado que existe; restored a un staging y probado)

### Cuentas business + KYC
- [ ] Resend account verificada + DNS records propagados
- [ ] Twilio business verificado + número comprado
- [ ] Meta WhatsApp Business verificado + dominio verificado
- [ ] (Si aplica) D7 / Infobip / SMSPM business verificado para Cuba
- [ ] Stripe business verificado + bank account + webhook configurado
- [ ] Mapbox business + billing address
- [ ] Apple Developer Program inscripto (DUNS)
- [ ] Google Play Console inscripto
- [ ] EAS project linked correctamente

### Domain / DNS / Email
- [ ] tricigo.com renovado por 5+ años, registrar lock activo
- [ ] DNS records SPF/DKIM/DMARC configurados
- [ ] Apple, Google, Meta, Resend domain verifications activas
- [ ] Email business configurado (Google Workspace / Zoho)
- [ ] DMARC reports llegan a `dmarc@tricigo.com`

### Legal / Negocio
- [ ] LLC / S.A. registrada y activa
- [ ] Cuenta bancaria business operativa
- [ ] DUNS number obtenido
- [ ] Términos y Privacidad revisados por abogado
- [ ] Tax setup correcto
- [ ] Insurance contratada
- [ ] Driver agreements firmados

### Operacional
- [ ] Runbook escrito: ¿quién recibe alerts? ¿quién aprueba refunds? ¿quién hace deploys?
- [ ] Status page configurada (BetterStack, statuspage.io — ~$30/mes)
- [ ] Slack/Discord channel para alerts (Sentry → Slack integration)
- [ ] Escalation policy: qué pasa si caídas > 5 min, > 1 hr
- [ ] Comunicación a usuarios: cómo notificás incidentes
- [ ] On-call rotation (si tenés equipo)

### Marketing / Launch
- [ ] App Store + Play Store listings completos (descripción, screenshots, video)
- [ ] Privacy Policy URL pública
- [ ] Soporte: cómo recibís reportes de bugs/queries (intercom / freshdesk / email)
- [ ] FAQ inicial publicado en `tricigo.com/help`
- [ ] Onboarding flow para nuevos drivers (KYC, vehicle photos, selfie, training)
- [ ] Política de cancelación + refunds documentada y visible para customers

---

## 7. Costos mensuales estimados (USD)

### Recurrente fijo
| Item | Tier | Costo/mes |
|---|---|---|
| Supabase | Pro | $25 |
| Resend | Pro | $20 |
| Sentry | Team | $26 |
| Vercel/Netlify (apps/web) | Pro (si aplica) | $20 |
| Google Workspace (5 usuarios) | Business Starter | $30 |
| Status page (BetterStack) | Starter | $30 |
| EAS | Production (cuando arranque release cycle) | $99 |
| Twilio number | base | $1 |
| **Subtotal fijo** | | **~$250/mes** |

### Variable / por uso
| Item | Estimado a 1K usuarios activos |
|---|---|
| Twilio SMS / Verify | ~$50/mes (1000 OTPs + notifs) |
| Meta WhatsApp (post-1000 free) | ~$30/mes |
| Mapbox | ~$100-200/mes (depende drivers activos) |
| Stripe fees | 3% del GMV procesado por wallet |
| OpenWeatherMap | $0 (free tier alcanza) |
| ElToque | depende del tier de su API |
| **Subtotal variable** | **~$200-400/mes (early stage)** |

### One-time / anual
| Item | Costo |
|---|---|
| Apple Developer | $99/año |
| Google Play | $25 one-time |
| Domain renewal | $15-20/año |
| Insurance | depende ($500-5000/año) |
| Lawyer review (T&C, privacy) | $300-2000 one-time |
| LLC registration | depende jurisdicción ($100-1500) |

### Total estimado para arrancar production
- **Mes 1**: ~$1,500 (incluye one-time setups)
- **Mes 2+**: ~$500-700/mes para 1K usuarios activos
- **Escala 10K usuarios**: ~$2,000-3,000/mes

---

## 8. Próximos 7 días — orden recomendado

1. **Día 1**: enrolar MFA en los 4 admins (1 hora total). Avisarme para aplicar migración 00220.
2. **Día 1**: Supabase Pro upgrade. Verificar PITR.
3. **Día 2**: redeploy `apps/web` post-fix de `next.config.ts`. Verificar `curl /.well-known/assetlinks.json` retorna 200.
4. **Día 2-3**: APK rebuild driver + client con `eas build`. Testear en device físico.
5. **Día 3-5**: domain + DNS records (SPF/DKIM/DMARC para Resend, verifications para Apple/Google/Meta).
6. **Día 5-7**: Stripe business verification + Meta WhatsApp Business verification (estos tardan días en aprobar).

Después: legal/LLC en paralelo (semanas), insurance, agreements, etc.

---

## Apéndice: env vars / config keys / secrets actuales

### Edge Function env vars (Supabase Dashboard → Edge Functions → Secrets)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (auto)
- `ALLOWED_ORIGINS` (CSV de dominios permitidos)
- `RESEND_API_KEY`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGE_SERVICE_SID`, `TWILIO_VERIFY_SERVICE_SID`
- `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`
- `TROPIPAY_WEBHOOK_SECRET` (deprecated, puede borrarse)
- `SELFIE_VERIFICATION_ENABLED` (false por ahora; activar cuando integres face comparison real)
- `CRON_SECRET` (interno)

### platform_config (DB) — admin / settings / platform-config
- `business_notification_email` — email a notificar de movements importantes
- `eltoque_api_token`, `openweather_api_key`
- `infobip_api_key`, `smspm_token` — SMS Cuba alternatives (no activos)
- `stripe_*` — toda la suite Stripe (8 keys)
- `tropipay_*` — DEPRECATED, se puede limpiar

### Mobile + web env (`.env`)
- `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_MAPBOX_TOKEN`
- `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_API_KEY`
- `EXPO_PUBLIC_DEMO_MODE`, `EXPO_PUBLIC_DEMO_CITY` (debe ser `false` / null en producción)
- `NEXT_PUBLIC_*` para apps/web/admin
- `SENTRY_AUTH_TOKEN` (server-side, source maps upload)

⚠️ **Antes de producción**: verificar que `EXPO_PUBLIC_DEMO_MODE` esté en `false` para builds de production (el banner "MODO DEMO · SÃO PAULO · NO PRODUCCIÓN" no debe aparecer).
