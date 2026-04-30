# D7 Networks SMS — Setup para OTP en Cuba

## Por qué D7

Twilio / Vonage / MessageBird bloquean Cuba (sanciones OFAC). D7 Networks (Dubai)
es uno de los pocos gateways que rutea SMS a `+53` con buena entregabilidad.
Lo usamos como ruta principal de OTP para Cuba; si D7 falla, la edge function
hace fallback automático a WhatsApp via Meta Cloud API.

## Setup paso a paso

### 1. Cuenta D7 Networks

1. Ir a https://d7networks.com/ → "Sign up"
2. Completar registro con un **email empresarial** (no Gmail/Outlook personal).
   - Si no tenés dominio propio: levantá `auth@tudominio.com` con
     **Cloudflare Email Routing** (free) o **Zoho Mail** (free tier).
3. Verificá el email + esperá aprobación manual (suele ser <24h).
4. Una vez aprobada la cuenta:
   - Dashboard → **API Tokens** → "Generate token" → copiá el bearer token.
   - Dashboard → **Sender IDs** → registrá `TriciGo` (o el alfanumérico que quieras).
     Cuba puede tardar 1-3 días en aprobar el sender ID. Mientras tanto, el SMS
     sale con un sender numérico genérico — igual entrega.

### 2. Configurar secrets en Supabase

```bash
# Via Supabase CLI
supabase secrets set D7_API_TOKEN='eyJ...your-bearer-token...'
supabase secrets set D7_SENDER_ID='TriciGo'

# O via dashboard:
# Project Settings → Edge Functions → Secrets
```

**Variables que lee `send-sms-otp`:**

| Variable | Default | Notas |
|---|---|---|
| `D7_API_TOKEN` | (vacío) | Si está vacío, salta a Meta WhatsApp |
| `D7_SENDER_ID` | `TriciGo` | Alfanumérico, max 11 chars |
| `META_WHATSAPP_ACCESS_TOKEN` | (vacío) | Fallback si D7 falla o no está configurado |
| `META_WHATSAPP_PHONE_NUMBER_ID` | (vacío) | Junto con el token de arriba |

Si **ambos** están vacíos y el número es `+53`, la función devuelve 503 "SMS service not configured".

### 3. Deploy de la edge function

```bash
supabase functions deploy send-sms-otp
```

(La función `verify-otp` no se modifica — ya valida desde la tabla `otp_codes`
via el RPC atómico `verify_cuba_otp`. Funciona igual con D7 o Meta.)

### 4. Test end-to-end

```bash
# Pedir OTP (debería llegar SMS al +53)
curl -X POST 'https://tu-proyecto.supabase.co/functions/v1/send-sms-otp' \
  -H 'apikey: YOUR_ANON_KEY' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+5355551234"}'

# Respuesta esperada:
# {"success":true,"message":"Verification sent via SMS","provider":"d7"}
```

Si `provider` es `meta` significa que D7 falló y entró el fallback.
Logs de D7 (request_id, errors) aparecen en Supabase → Edge Functions → Logs.

## Costos

D7 cobra por SMS entregado. Pricing Cuba típico: ~$0.05–0.08 por SMS (verificá
el rate exacto en su dashboard). Cargás crédito prepaid; cuando se acaba, el
fallback a Meta WhatsApp toma el relevo automáticamente.

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| `403` de D7 | Cuenta no aprobada todavía / token revocado |
| `400` "Invalid recipient" | El número no está en E.164 (`+53XXXXXXXXX`) |
| `200` pero el SMS no llega | Sender ID sin aprobar para Cuba — pedí cambio temporal a sender numérico |
| Edge function devuelve 502 con `provider: meta` | D7 falló, fallback OK |
| Edge function devuelve 502 sin fallback | Configurá `META_WHATSAPP_*` para tener red de seguridad |

## Migración de Meta a D7 sin downtime

1. Configurá los secrets de D7 (`D7_API_TOKEN`).
2. Deploy: `supabase functions deploy send-sms-otp`.
3. Próximas peticiones de OTP a `+53` van a D7. Si D7 cae, fallback a Meta automático.
4. Cuando confirmes que D7 funciona estable >7 días, podés borrar los secrets de Meta:
   `supabase secrets unset META_WHATSAPP_ACCESS_TOKEN META_WHATSAPP_PHONE_NUMBER_ID`.
