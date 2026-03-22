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
