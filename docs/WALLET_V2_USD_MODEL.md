# TriciCoin v2 — USD-pegged Wallet + Stripe in-app + Comprobantes legales

> **Status:** Plan de implementación. Pendiente aprobación.
> **Fecha:** 2026-04-30
> **Autor:** Eduardo + Claude
> **Reemplaza:** modelo TRC actual (1 TC ≈ 0.002 USD, unidad CUP-derivada)

---

## 1. Contexto y motivación

Hoy TriciCoin (TC) es una unidad ligada a CUP — el wallet guarda balance en `INTEGER` con currency `'TRC'`, y la conversión a USD para Stripe se hace al momento del pago. Eso tiene 3 problemas:

1. **Riesgo cambiario para la empresa** — si CUP devalúa entre la recarga y el gasto, TriciGo pierde valor real.
2. **Recargas confusas para el usuario** — el usuario paga en USD pero ve el saldo en una unidad arbitraria.
3. **Sin comprobante legal** — Stripe genera un receipt simple, pero no hay PDF cubano con tasa aplicada y datos del usuario, que es **obligatorio para auditorías financieras locales**.

### Modelo nuevo (confirmado con Eduardo)

```
1 TriciCoin ≡ 1 USD                         (paridad fija)
Recarga:   USD pagado en Stripe → mismo número de TC al wallet
Gasto:     viaje cuesta CUP → se descuentan TC equivalentes
           a la tasa USD/CUP del día (el-toque)
Riesgo:    el USUARIO absorbe la fluctuación (su TC mantiene poder USD)
Mínimo:    20 USD por recarga
Máximo:    sin tope explícito (input libre)
Fee:       sí, % o fijo (a definir, ver §3.2)
Métodos:   solo tarjeta CC/DC (sin Apple/Google Pay por ahora)
Idioma:    español únicamente
PDF:       email automático + descarga in-app
Storage:   Supabase Storage (auditoría 7 años)
Email:     usuario + soporte@gmail.com (admin notif)
```

---

## 2. Estado actual del código (relevamiento)

| Componente | Estado | Path |
|---|---|---|
| Wallet schema (`wallet_accounts` + `ledger_*`) | ✅ Sólido | `00001_initial_schema.sql` |
| Stripe edge function (create-payment-intent) | ✅ Funciona | `supabase/functions/create-stripe-payment-intent/` |
| Stripe webhook (process-stripe-webhook) | ✅ Funciona | `supabase/functions/process-stripe-webhook/` |
| Acreditar wallet post-pago RPC (`process_stripe_recharge`) | ✅ Funciona | `00110_stripe_integration.sql` |
| Tabla `exchange_rates` + sync el-toque | ✅ Funciona | `00017_exchange_rate_billing.sql`, `supabase/functions/sync-exchange-rate/` |
| `wallet_recharge_requests` (manual recharge flow) | ✅ Funciona | `00008_wallet_recharge_requests.sql` |
| Cliente: TopUp screen | ✅ Existe | `apps/client/app/(tabs)/wallet.tsx` |
| Resend (email transaccional) | ✅ Configurado | `supabase/functions/send-email/` |
| **Generación de PDFs** | ❌ NO existe | — |
| **Storage bucket `receipts`** | ❌ NO existe | — |
| **Email "recibí tu pago" template** | ❌ NO existe | — |
| **Admin notification email** | ❌ NO existe | — |

**Conclusión:** la infraestructura de pago in-app y Stripe ya está; lo que falta es el **layer legal** (PDF + emails + auditoría) y el **cambio de unidad** (TRC → USD-pegged).

---

## 3. Cambios al schema

### 3.1 Migración de unidad (1 TC = 1 USD)

```sql
-- 00XXX_wallet_v2_usd_pegged.sql

-- 1. Mark currency change in wallet_accounts. Keep column for backward-compat.
ALTER TABLE wallet_accounts
  ALTER COLUMN currency SET DEFAULT 'USD';
UPDATE wallet_accounts SET currency = 'USD' WHERE currency = 'TRC';

-- 2. Convert existing balances. Hoy `balance` es INTEGER en "centavos de TRC"
--    (donde 1 TRC ≈ 0.002 USD). El balance promedio en USD = balance/1000 (?).
--    NOTA: revisar la lógica exacta del rebase histórico (ver migration 00094).
--    Plan B: snapshot de balances actuales, conversión manual con tasa promedio
--    de los últimos 7 días, y reembolso en USD a quienes pierdan (ver §6).

-- 3. Renombrar columna semánticamente (opcional, breaking).
-- ALTER TABLE wallet_accounts RENAME COLUMN balance TO balance_usd_cents;
-- (Recomendado NO renombrar — usar VIEW para nuevos consumidores).
```

### 3.2 Comprobantes / receipts

```sql
CREATE TABLE wallet_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  payment_intent_id uuid NOT NULL REFERENCES payment_intents(id) UNIQUE,
  receipt_no    text NOT NULL UNIQUE,                -- 'TG-2026-000001'
  -- montos
  usd_charged   numeric(10,2) NOT NULL,              -- p.ej. 20.00
  fee_usd       numeric(10,2) NOT NULL DEFAULT 0,    -- p.ej. 0.60 (3%)
  net_usd       numeric(10,2) NOT NULL,              -- usd_charged - fee_usd
  tc_credited   numeric(10,2) NOT NULL,              -- = net_usd (paridad 1:1)
  -- contexto cambiario (snapshot al momento)
  exchange_rate numeric(10,2) NOT NULL,              -- USD/CUP el-toque del día
  exchange_at   timestamptz   NOT NULL,
  cup_equivalent numeric(12,2) NOT NULL,             -- net_usd * exchange_rate
  -- método de pago
  stripe_payment_intent_id text NOT NULL,
  card_brand     text,                                -- 'visa', 'mastercard', etc.
  card_last4     text,                                -- '4242'
  -- pdf
  pdf_storage_path text,                              -- 'receipts/{user_id}/{receipt_no}.pdf'
  pdf_generated_at timestamptz,
  email_sent_at_user  timestamptz,
  email_sent_at_admin timestamptz,
  -- audit
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_receipts_user_created ON wallet_receipts (user_id, created_at DESC);
CREATE INDEX idx_wallet_receipts_payment_intent ON wallet_receipts (payment_intent_id);

-- numerador atómico para receipt_no
CREATE SEQUENCE wallet_receipts_seq START 1;
CREATE OR REPLACE FUNCTION generate_receipt_no() RETURNS text AS $$
  SELECT 'TG-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('wallet_receipts_seq')::text, 6, '0');
$$ LANGUAGE sql VOLATILE;

-- RLS: usuario lee solo los suyos; admin lee todos
ALTER TABLE wallet_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY wallet_receipts_user_read  ON wallet_receipts FOR SELECT USING (user_id = auth.uid());
CREATE POLICY wallet_receipts_admin_all  ON wallet_receipts FOR ALL    USING (is_admin());
```

### 3.3 Storage bucket

```sql
-- via Supabase dashboard o SQL:
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('receipts', 'receipts', false, 1048576 /* 1MB */, ARRAY['application/pdf']);

-- RLS:
CREATE POLICY "receipts_owner_read" ON storage.objects FOR SELECT
  USING (bucket_id='receipts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "receipts_service_write" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id='receipts' AND auth.role() = 'service_role');
```

---

## 4. Edge function `generate-recharge-receipt`

**Path:** `supabase/functions/generate-recharge-receipt/index.ts`

**Trigger:** invocada desde el webhook `process-stripe-webhook` cuando llega `payment_intent.succeeded` (después de acreditar al wallet).

**Input:** `{ payment_intent_id: uuid }`

**Lógica:**
```ts
1. Cargar payment_intents + user + exchange_rate del día
2. Calcular: usd_charged, fee_usd, net_usd, tc_credited (=net_usd), cup_equivalent
3. Generar PDF en memoria (lib: pdf-lib o jsPDF — ver §4.1)
4. Subir a storage: receipts/{user_id}/{receipt_no}.pdf
5. INSERT wallet_receipts con todos los campos
6. Llamar send-email × 2:
   - usuario: template "Tu comprobante TriciGo" + PDF attached + link descarga
   - soporte@: template "Nueva recarga procesada" + PDF attached
7. UPDATE wallet_receipts.email_sent_at_*
```

### 4.1 Librería PDF

Recomendación: **`pdf-lib`** (puro JS, runs en Deno/edge). Alternativas:
- `jsPDF` (cliente-friendly, server requiere shim)
- Plantilla HTML + Puppeteer (más bonito pero ~200ms más lento, edge functions tienen timeout)

`pdf-lib` permite armar el PDF programáticamente con tipografías embebidas. ~80KB minified, runs perfecto en Deno.

### 4.2 Layout del PDF (1 página A4)

```
┌─────────────────────────────────────────────────────┐
│  [Logo TriciGo]                       TG-2026-000123│
│                                                     │
│  COMPROBANTE DE RECARGA                             │
│  ────────────────────                               │
│                                                     │
│  Fecha:        30 abril 2026, 19:45 (Cuba)         │
│  Usuario:      Eduardo Daniel Pérez                 │
│  ID usuario:   8a9f-...-22b4                        │
│  Email:        eduardo@example.com                  │
│  Teléfono:     +53 5 5662-1636                      │
│                                                     │
│  Detalle:                                           │
│  ─────────                                          │
│  Importe cobrado USD ......................  20.00 │
│  Comisión de servicio (3%) ................   0.60 │
│  Importe neto acreditado ..................  19.40 │
│  TriciCoin acreditados (1 TC = 1 USD) .....  19.40 │
│                                                     │
│  Equivalencia CUP (informativa):                    │
│  Tasa USD/CUP del día (el-toque) ..........  385.00│
│  Equivalente en CUP .....................  7,469.00│
│                                                     │
│  Método de pago:                                    │
│  Visa terminada en •••• 4242                        │
│  Stripe PaymentIntent: pi_3O...                     │
│                                                     │
│  ─────────────────────────────────────────────────  │
│  Este comprobante se emite a efectos contables.    │
│  La equivalencia en CUP es referencial al momento  │
│  de la transacción y puede variar al gastar.       │
│                                                     │
│  TriciGo · Cuba                                     │
│  contacto@tricigo.com                               │
└─────────────────────────────────────────────────────┘
```

---

## 5. Cambios al cliente (`apps/client/app/(tabs)/wallet.tsx`)

### 5.1 Header del wallet

```diff
- Saldo: 426,334 TC (≈ $852.67 USD)
+ Saldo: $19.40 TriciCoin
+ ≈ 7,469 CUP al cambio de hoy (1 USD = 385 CUP)
```

### 5.2 Top-up screen

```diff
- Input: monto en TC, slider 1k - 50k
+ Input: monto en USD, validación min $20
+ Vista previa: "Recargás $20 USD = 20 TriciCoin"
+ Vista previa: "≈ $19.40 netos (después del 3% de comisión)"
+ Vista previa: "Equivale a 7,469 CUP al cambio de hoy"
```

### 5.3 Historial de transacciones

Cada item de tipo "recarga" tiene un nuevo botón **"Descargar comprobante"**:

```tsx
<Pressable onPress={() => downloadReceipt(receipt.pdf_storage_path)}>
  <Ionicons name="download-outline" />
  <Text>Descargar comprobante</Text>
</Pressable>
```

Implementación: usar `supabase.storage.from('receipts').createSignedUrl(path, 3600)` → `Linking.openURL(url)` o `expo-file-system` para descarga.

### 5.4 Comprobantes "viejos" (pre-implementación)

Eduardo confirmó que los PDFs deben poder descargarse para **cualquier fecha**. Plan:

1. Migración `00XXX_backfill_receipts.sql`:
   - Por cada `payment_intents` con `status='succeeded'` y `provider='stripe'`:
     - Generar `wallet_receipts` row sin PDF (`pdf_storage_path = NULL`)
     - Calcular USD desde `amount_usd` y `exchange_rate` del propio `payment_intents`
2. Edge function `generate-recharge-receipt` también acepta `payment_intent_id` retroactivos:
   - Si no encuentra row en `wallet_receipts`, genera con datos históricos
   - Si ya existe pero `pdf_storage_path IS NULL`, genera el PDF on-demand
3. Cliente: cuando el usuario clickea "Descargar comprobante" de una transacción vieja → llama RPC `request_receipt_for_payment_intent(payment_intent_id)` que dispara la edge function

---

## 6. Migración de balances actuales

⚠️ **Decisión pendiente** — ¿Cómo convertimos los 426,334 TC actuales en circulación al nuevo modelo USD-pegged?

**Opción A (conservadora):** snapshot de balances a la tasa **del día de la migración**.
- Ejemplo: si hoy 1 USD = 385 CUP, y los TC actuales valen ~0.002 USD c/u, entonces 426,334 TC × 0.002 = $852 USD totales.
- Pros: matemáticamente justo según el modelo viejo.
- Contras: si CUP devaluó entre que el usuario recargó y la migración, el usuario pierde.

**Opción B (favor al usuario):** snapshot a la tasa del **momento de cada recarga histórica**.
- Por cada usuario, sumamos TC de cada recarga × tasa de ese día → balance USD final.
- Pros: el usuario nunca pierde por devaluación.
- Contras: requiere `exchange_rate_at_recharge` en transacciones viejas (puede no existir).

**Opción C (más simple):** dar a todos un **bono compensatorio** redondeando hacia arriba.
- Ejemplo: convertir todos los TC a USD a la tasa del día y agregar 5-10% de bono "por la migración".
- Comunicar como "regalo de bienvenida al nuevo TriciCoin".

**Recomendación:** Opción C — más simple, mejor PR, y el costo total es bajo (~$50 USD redondeando).

---

## 7. Notificación al admin

Cada recarga procesada dispara un email a `soporte@gmail.com` (⚠️ confirmar dirección final con dominio propio).

**Subject:** `[TriciGo] Recarga procesada — TG-2026-000123 — $20.00 USD`

**Body:** PDF adjunto + resumen plain-text con link al admin para ver detalles.

**Implementación:** dentro de `generate-recharge-receipt`, después de mandar al usuario, mandar también a `Deno.env.get('ADMIN_RECEIPT_EMAIL')`.

---

## 8. Configuración / GH secrets nuevos

```
STRIPE_LIVE_PUBLISHABLE_KEY    pk_live_…       # cuando Eduardo tenga datos empresa
STRIPE_LIVE_SECRET_KEY         sk_live_…
STRIPE_WEBHOOK_SECRET          whsec_…
RESEND_API_KEY                 re_…             # ya existe
RECEIPT_FROM_EMAIL             contacto@tricigo.com
ADMIN_RECEIPT_EMAIL            soporte@gmail.com  ⚠️ confirmar
RECEIPT_PDF_LOGO_URL           https://...      # logo TriciGo para PDF
```

Variables Supabase (platform_config):
```
{ "stripe_recharge_fee_percent": 3.0,
  "stripe_recharge_min_usd": 20,
  "exchange_rate_auto_update": true,
  "eltoque_api_token": "..." }
```

---

## 9. Plan de release (orden de PRs)

| PR | Contenido | Riesgo | Bloqueante |
|---|---|---|---|
| 1 | Migración schema (`wallet_receipts`, sequence, storage bucket, RLS) | bajo | — |
| 2 | Edge function `generate-recharge-receipt` + lib pdf-lib | medio | PR 1 |
| 3 | Webhook hook: invocar generate-receipt post-acreditación | bajo | PR 2 |
| 4 | Cliente: botón "Descargar comprobante" + storage signedUrl | bajo | PR 1 |
| 5 | Cliente: nueva top-up UI (USD input, preview equivalencia) | medio | — |
| 6 | Cambio de unidad TRC → USD (header, formateo, copy en blog post) | **alto** | revisión exhaustiva |
| 7 | Migración de balances (Opción C bono) | **alto** | PR 6 |
| 8 | Backfill `wallet_receipts` para recargas históricas (sin PDF) | bajo | PR 1, 2 |
| 9 | Admin: tab "Comprobantes emitidos" + email a soporte@ | bajo | PR 1 |

**Estimación:** 3-4 días de dev, +2 días de QA y migración cuidadosa de balances.

---

## 10. Decisiones (CONFIRMADAS por Eduardo, 2026-05-01)

| # | Pregunta | Decisión final |
|---|---|---|
| 1 | Email del admin | ✅ **`soporte@tricigo.com`** (usar dominio propio para que Resend no caiga en spam — necesita registrar el dominio en Resend antes del primer envío) |
| 2 | Comisión Stripe | ✅ **3% del USD cobrado, mínimo $0.50** |
| 3 | Migración balances | ✅ **Opción C — bono 5% como bienvenida al nuevo TriciCoin** |
| 4 | PDF logo | (pendiente — asumir wordmark negro sobre fondo blanco) |
| 5 | Numerador receipts | (pendiente — asumir `TG-2026-000001`) |
| 6 | Cron sync-exchange-rate | (pendiente — asumir cada 1h, ya configurado) |
| 7 | Soft vs hard delete receipts | (pendiente — asumir **nunca borrar** por requerimiento legal 7 años) |

### Notas operativas decisión #1 (email)
- Hay que comprar/configurar el dominio `tricigo.com` (si no está)
- Verificar en Resend dashboard: agregar dominio + registros DNS (SPF, DKIM, DMARC) → ~30 min de wait para propagación
- Hasta que el dominio quede verificado, los emails se envían desde `onboarding@resend.dev` (default Resend) que llega a inbox en pruebas pero a spam en producción

### Notas operativas decisión #3 (bono)
- Aplicar al ejecutar la migración de schema
- Regla: `nuevo_balance_USD = (TC_actual × tasa_USD_hoy) × 1.05`
- Mínimo bono: 1 TC (para usuarios con saldo casi 0)
- Comunicación push: *"¡Bienvenido al nuevo TriciCoin! Te regalamos un bono del 5% por usar TriciGo. Tu nuevo saldo es X TC ($X USD)."*

---

## 11. Riesgos identificados

1. **Stripe en test mode hoy** — no se pueden hacer recargas reales hasta tener pk_live. Toda la implementación se prueba con tarjetas test (4242 4242 4242 4242).

2. **Cambio de tasa entre creación del PaymentIntent y webhook** — si tarda >1h, la tasa snapshot puede diferir. Mitigación: usar la tasa del momento del **webhook**, no del intent.

3. **Edge function timeout** — `generate-recharge-receipt` con PDF + email puede tardar 5-10s. Si se cae, el wallet ya fue acreditado pero no hay PDF. Mitigación: tabla `wallet_receipts` se crea con `pdf_generated_at IS NULL` y un cron diario re-genera los faltantes.

4. **Storage costs** — 1 PDF/recarga, ~50KB, sale unos $0.02 por GB/mes. Para 10k recargas/mes son 500MB → ~$0.01/mes. Negligible.

5. **Backfill de receipts históricos** — depende de tener `metadata` confiable en PaymentIntents viejos. Si falta, se generan con datos parciales y nota "Comprobante regenerado retroactivamente, datos parciales".

---

## 12. Métricas de éxito

- 100% de las recargas tienen `wallet_receipts` row dentro de 30s del `payment_intent.succeeded`
- 95% de las recargas tienen `pdf_storage_path` populado dentro de 60s
- 90% de los emails al usuario llegan en <2 min (Resend SLA)
- Admin recibe email de cada recarga (sin batch)
- Compliance: 0 recargas sin comprobante después de 1 mes
