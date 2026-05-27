# TriciGo — Bloqueantes Pendientes

> Actualizado: 22 marzo 2026
> Estado general: 9.2/10 — Todo el código está listo. Solo faltan credenciales externas.

---

## 1. SMS OTP via Twilio

**Qué bloquea:** Los usuarios no pueden registrarse ni iniciar sesión por teléfono (solo Google OAuth funciona).

**Qué necesitas:**
- Cuenta Twilio verificada con documentos brasileños (CPF/protocolo de residencia)
- Número Twilio con capacidad de enviar SMS a Cuba (+53)

**Qué vamos a hacer cuando tengas la cuenta:**
1. Obtener de Twilio Dashboard:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER` (el número desde el que se envían SMS)
2. Guardar en Supabase `platform_config`:
   ```sql
   UPDATE platform_config SET value = '"ACxxxxxxxxxx"' WHERE key = 'twilio_account_sid';
   UPDATE platform_config SET value = '"your_auth_token"' WHERE key = 'twilio_auth_token';
   UPDATE platform_config SET value = '"+1XXXXXXXXXX"' WHERE key = 'twilio_phone_number';
   ```
3. Actualizar `supabase/functions/send-sms-otp/index.ts` para usar Twilio API:
   ```
   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
   Body: { To: phone, From: twilioNumber, Body: "Tu código TriciGo: {code}" }
   Auth: Basic base64(SID:Token)
   ```
4. Deploy de la Edge Function
5. Test: enviar OTP a tu número real

**Tiempo estimado de implementación:** 30 minutos

---

## 2. EAS Builds (iOS + Android)

**Qué bloquea:** No se pueden instalar las apps en dispositivos reales.

### iOS — Necesitas:

**Qué necesitas:**
- Cuenta Apple Developer ($99/año) — https://developer.apple.com/programs/
- De tu cuenta, obtener:
  - `appleTeamId` (formato: "XXXXXXXXXX", 10 caracteres)
  - `ascAppId` (App Store Connect App ID, número)

**Dónde ponerlos:**
- `apps/client/eas.json` línea 43-44
- `apps/driver/eas.json` línea 43-44
```json
"submit": {
  "production": {
    "ios": {
      "appleId": "edua56621636@gmail.com",
      "ascAppId": "TU_APP_ID_AQUI",
      "appleTeamId": "TU_TEAM_ID_AQUI"
    }
  }
}
```

### Android — Necesitas:

**Qué necesitas:**
- Cuenta Google Play Console ($25 una vez) — https://play.google.com/console
- Crear una Service Account en Google Cloud Console
- Descargar el JSON key file
- Guardar como `apps/client/google-service-account.json` y `apps/driver/google-service-account.json`

**Qué vamos a hacer:**
1. Llenar los IDs en eas.json
2. Ejecutar: `cd apps/client && eas build --profile preview --platform all`
3. Ejecutar: `cd apps/driver && eas build --profile preview --platform all`
4. Instalar en dispositivos reales
5. Smoke test completo

**Tiempo estimado:** 1-2 horas (builds tardan ~15 min cada uno)

---

## 3. App Store Submission

**Qué bloquea:** Los usuarios no pueden descargar la app desde las tiendas.

**Depende de:** Bloqueante #2 (EAS Builds) resuelto primero.

**Qué necesitas preparar:**
- Screenshots profesionales de la app (5-6 por plataforma)
- Descripción de la app en español (e inglés para App Store internacional)
- Política de privacidad pública (ya existe en tricigo.com/privacy)
- Términos de servicio (ya existe en tricigo.com/terms)
- Icono de la app en alta resolución (ya existe)

**Qué vamos a hacer:**
1. `eas submit --platform ios` (client + driver)
2. `eas submit --platform android` (client + driver)
3. Completar formularios de revisión de Apple/Google
4. Esperar aprobación (Apple: 1-3 días, Google: horas-1 día)

**Tiempo estimado:** 2-3 horas + tiempo de revisión de las tiendas

---

## 4. Load Testing en Producción

**Qué bloquea:** No tenemos baseline de performance para escalar.

**Depende de:** Tener al menos algunos viajes reales en el sistema.

**Qué vamos a hacer:**
1. Ejecutar k6 script existente (`k6/load-test.js`) contra producción
2. Documentar P95 latency por endpoint
3. Si P95 > 500ms: optimizar queries, agregar indexes
4. Configurar connection pooling si necesario (Supabase ya usa Supavisor)

**Tiempo estimado:** 1 hora

---

## 5. NETOPIA Support — clarificaciones de la integración v2.x

> **Añadido:** 2026-05-24 — durante el flow productivo de NETOPIA en sandbox descubrimos 2 comportamientos no documentados (o ambiguos) que requieren respuesta oficial del soporte.

**Qué bloquea:** Lanzar pagos productivos con confianza completa en la integración. **No es bloqueante crítico** (ambos issues tienen mitigación temporal), pero las respuestas habilitan mejoras puntuales:

1. **Two-IPN race condition** — NETOPIA observó enviar 2 IPNs para la misma transacción (`status=12, "Invalid CVV"` interim → `status=3, paid` final, ~20s de diferencia). Detectado el 2026-05-23 con intent `d3fc744f` ($20 driver_quota → wallet jamás acreditada pre-fix porque el atomic claim del webhook no aceptaba transición `failed → paid`). **Fix shipped** en PR #158 (commit `42de9da`, EF `process-netopia-webhook` v5 deployada) — ahora el webhook tolera la recuperación con verificación de `ntpID` matching. Pero queremos confirmar si es behavior documentado y si hay un endpoint REST `verify-auth` para reconfirmar status canónico.
2. **Email cardholder en rumano** — enviamos `config.language: 'es'` y la página hosted respeta el field, pero el email de confirmación al cardholder llega en rumano. Spec dice `config.language` controla "language you want notifications to be displayed in" (wording ambiguo). No hay field documentado `customer.language` / `billing.language`.

**Qué necesitas:**
- Tiempo para mandar el ticket vía chat o form de soporte NETOPIA (https://netopia-payments.com — luni-vineri 9-18 hora Rumania)
- Las credenciales del POS sandbox/live para que NETOPIA ubique las transacciones referenciadas (ntpID `2812872` para el caso del two-IPN)

**Qué vamos a hacer cuando tengas la respuesta:**
1. **Si NETOPIA confirma el endpoint REST `verify-auth`**: implementar Fix 4 del plan (cross-check defensivo en `process-netopia-webhook` antes de marcar un intent como `failed`, llamando la API de NETOPIA para confirmar status canónico).
2. **Si NETOPIA confirma protocolo para email language**: ajustar config en POS dashboard o agregar field nuevo (`customer.language`, `billing.language`, etc.) a la request del EF `create-netopia-payment-intent`.
3. **Si NETOPIA confirma que el two-IPN es behavior interim documentado**: agregar nota a CLAUDE.md y mantener el fix actual sin cambios.

**Texto del ticket (copy-paste-ready):** ver `~/.claude/plans/rol-eres-un-auditor-immutable-platypus.md` sección **A.3 (FINAL)** — incluye versión en rumano + inglés con cronología completa, payloads de IPN, y 6 preguntas técnicas concretas.

**Estado actual:** ticket NO enviado todavía. Lo mandás cuando puedas; mientras tanto, el código en master tolera los 2 issues sin perder transacciones.

**Tiempo estimado:** 15 min de envío + horario de soporte (luni-vineri 9-18 hora Rumania) para respuesta.

---

## 6. NETOPIA — switch sandbox → live (cuando estés listo para tráfico real)

> **Añadido:** 2026-05-27. El código ya soporta live (el EF `create-netopia-payment-intent` rutea según `platform_config.netopia_environment`). Faltan credenciales, configuración y smoke test antes de switchear.

**Qué bloquea:** Sin esto, las recargas reales de los usuarios NO se procesan — NETOPIA sandbox no debita tarjetas reales. Esto es lo último que se ejecuta antes de abrir tráfico productivo.

### Pre-requisitos externos (hard requirements de NETOPIA, no de TriciGo)

- [ ] **KYC completo en NETOPIA Romania** — documentos de identidad + comprobante de domicilio + selfie de verificación
- [ ] **Contrato comercial firmado** — define fees, settlement terms, currencies habilitadas, payout schedule
- [ ] **Bank account verificada para settlements** — NETOPIA hace deposits ahí. **Debe ser bank account fuera de Cuba** (NETOPIA no opera con entidades cubanas — mismo problema que Stripe)
- [ ] **Currency USD habilitada en el POS dashboard** — por default solo RON. Sin esto el flow USD falla
- [ ] **API key live generada** — NETOPIA admin → Profile → Security → "Generate API key". **Guardar fuera del repo** (Supabase Secrets only)
- [ ] **POS signature live obtenida** — NETOPIA admin → POS settings → "Semnătură" (formato `XXXX-XXXX-XXXX-XXXX-XXXX`)

### Qué necesitas

- Las credentials del bullet anterior
- 30 min para smoke testing con TU tarjeta real (monto mínimo configurado, típicamente $20 USD)
- Aprobación tuya explícita para hacer el switch

### Plan de ejecución (orden estricto — no saltarse pasos)

**Paso 1 — Pre-flight check (read-only, no cambia nada)**
- Confirmar que el EF en prod tiene branching sandbox/live:
  ```
  mcp get-edge-function create-netopia-payment-intent
  ```
  Buscar la función `netopiaApiBase(env)` que rutea entre `secure.sandbox.netopia-payments.com` y `secure.netopia-payments.com`.

**Paso 2 — Setear credentials live SIN activar live todavía**

En Supabase Dashboard → Edge Functions → Secrets:
```
NETOPIA_LIVE_API_KEY = <api key del NETOPIA dashboard>
```

En Supabase Dashboard → SQL Editor (con auth explícita del user porque toca platform_config en prod):
```sql
UPDATE platform_config
SET value = '"<live POS signature>"', updated_at = NOW()
WHERE key = 'netopia_live_signature';
```

**⚠️ NO TOCAR `netopia_environment` todavía** — debe seguir en `'sandbox'`.

**Paso 3 — Sandbox health check (sanity — confirma que el setup nuevo no rompió nada)**

Hacer una recarga sandbox de $20 USD con tarjeta `9900 0000 0000 5159`, CVV `123`, exp `12/30`:
- [ ] NETOPIA confirma success
- [ ] IPN webhook llega (`process-netopia-webhook` log)
- [ ] Wallet acreditada en DB
- **Si falla → STOP**, algo se rompió con los cambios. No continuar.

**Paso 4 — Activar live** (el switch atómico)

```sql
UPDATE platform_config
SET value = '"live"', updated_at = NOW()
WHERE key = 'netopia_environment';
```

A partir de este UPDATE, el próximo intent va a NETOPIA live (URL `secure.netopia-payments.com`).

**Paso 5 — Smoke test con TU tarjeta real, monto mínimo ($20 USD si es el min)**

Hacer una recarga real desde TU usuario admin (todavía NO abrir a usuarios reales):
- [ ] NETOPIA hosted page carga URL `secure.netopia-payments.com` (NO `sandbox`)
- [ ] Pagás con tarjeta real (probablemente requiere 3DS/OTP del banco emisor)
- [ ] NETOPIA confirma success en pantalla
- [ ] IPN webhook llega (`process-netopia-webhook` log con `mapNetopiaStatus(3) → 'paid'`)
- [ ] `payment_intents` table tiene row con `status='completed'` y `payment_provider='netopia'`
- [ ] `ledger_transactions` tiene row de credit (idempotency_key `stripe_recharge_<intent>`)
- [ ] Wallet (`customer_cash` o `tricicoin`) subió el monto esperado
- [ ] Estado de cuenta de TU tarjeta muestra el cargo real (puede tardar 1-3 días hábiles en aparecer)
- [ ] Email de NETOPIA llega al cardholder (probablemente en rumano — issue conocido sección 5)

**Paso 6 — Apertura gradual a usuarios reales**

Si todo el paso 5 está ✓:
- Empezar con grupo cerrado de 5-10 beta testers (no anunciar públicamente)
- Monitorear logs de `process-netopia-webhook` + DB `payment_intents` por 24-48hs
- Buscar: discrepancias, two-IPN inesperados, ntpID mismatches, errores de credit RPC

Si todo OK a las 48hs → abrir tráfico general.

### Rollback (en cualquier momento si algo se rompe)

```sql
UPDATE platform_config
SET value = '"sandbox"', updated_at = NOW()
WHERE key = 'netopia_environment';
```

El switch back es inmediato — el próximo intent vuelve a sandbox. **Las transacciones live ya procesadas NO se revierten automáticamente** — requieren refund manual via NETOPIA POS dashboard si hace falta.

### Riesgos conocidos en live (no son blockers pero los considero)

- **Email cardholder en rumano** — issue abierto NETOPIA ticket (sección 5). Probablemente se repite en live. UX issue, no funcional.
- **Two-IPN race condition** — observado en sandbox (intent `d3fc744f`). El fix de PR #158 (EF v5) lo mitiga automáticamente con `failed→paid` recovery + ntpID matching. No requiere acción.
- **3DS challenge real** — algunos bancos requieren OTP via SMS o app del banco. Asegurarse que TU tarjeta lo soporte para el smoke test.
- **Tarjetas no cubanas** — NETOPIA está en Rumania. Los cardholders cubanos pueden no tener tarjetas Visa/MC internacionales (acceso limitado en Cuba a USD cards). Esto **NO es un problema de la integración** — es contexto de mercado.

### Tiempo estimado

- Paso 1-2: 15 min (setear credentials)
- Paso 3: 5 min (sandbox sanity)
- Paso 4: 1 min (switch activate)
- Paso 5: 10 min (smoke test real)
- Paso 6: 24-48hs (monitoreo + apertura gradual)

**Total para abrir tráfico real: ~30 min + 48hs de baking**

---

## Orden de resolución recomendado

```
1. Twilio (lunes con docs brasileños) ← PRIMERO
   ↓
2. EAS Builds (cuando tengas Apple Developer + Google Play Console)
   ↓
3. Smoke Test E2E (después de builds instalados)
   ↓
4. App Store Submission (después de smoke test exitoso)
   ↓
5. Load Testing (después de primeros usuarios reales)
   ↓
6. NETOPIA switch sandbox → live (sección 6 — ÚLTIMO antes de tráfico real)

═══════════════════════════════════════════════════════════════
PARALELO (independiente del orden de arriba):
═══════════════════════════════════════════════════════════════

• NETOPIA Support ticket (sección 5) — podés mandarlo en cualquier
  momento; la respuesta llega cuando llegue. No bloquea los items 1-6.
```

---

## Checklist rápido — Qué traerme

- [ ] Twilio Account SID
- [ ] Twilio Auth Token
- [ ] Twilio Phone Number
- [ ] Apple Team ID
- [ ] App Store Connect App ID (client)
- [ ] App Store Connect App ID (driver)
- [ ] Google Play service account JSON
- [ ] Confirmar: Apple Developer Program activo
- [ ] Confirmar: Google Play Console activo
- [ ] Confirmar: ticket NETOPIA enviado (texto en plan A.3, sección 5 arriba)
- [ ] Respuesta de NETOPIA support (cuando llegue) — copy/paste la respuesta acá o reenviame el email

**Para el switch a live (sección 6):**
- [ ] NETOPIA_LIVE_API_KEY (valor exacto del NETOPIA dashboard → Profile → Security)
- [ ] NETOPIA Live POS signature (`XXXX-XXXX-XXXX-XXXX-XXXX` del POS settings → "Semnătură")
- [ ] Confirmar: KYC + contrato + bank account NETOPIA validados
- [ ] Confirmar: USD habilitada en POS dashboard NETOPIA
- [ ] TU tarjeta real disponible para el smoke test de $20 USD (saldo + 3DS habilitado)
