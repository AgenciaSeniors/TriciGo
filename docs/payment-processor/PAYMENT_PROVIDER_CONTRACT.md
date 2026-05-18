# Contrato de Payment Provider — TriciGo

> Define qué debe implementar un procesador de pagos para integrarse al flujo de
> recarga de TriciGo. Establecido en la **Fase D1** del plan de cierre de pagos.
> Lo implementan las Fases D2 (NETOPIA) y D3 (EuPlătesc).

## Idea

El flujo de recarga es **agnóstico de proveedor** salvo en tres puntos: crear el
intent de pago, recibir el webhook de confirmación, y la UI de tarjeta. Todo lo
demás —la tabla `payment_intents`, la acreditación de la wallet, el ledger— es
común. Para integrar un procesador `X` se rellenan esos tres puntos contra este
contrato.

## 1. Edge function `create-X-payment-intent`

- **Entrada:** el cuerpo de `RechargeIntentRequest` (`packages/types/src/payment.ts`),
  serializado como `{ user_id, amount_cup, recharge_type, corporate_account_id? }`.
- **Debe:**
  1. Validar: JWT del caller (`auth.uid()` = `user_id` o admin), región (bloqueo
     OFAC por `cf-ipcountry`), monto contra `X_min_recharge_cup` /
     `X_max_recharge_cup`, y el velocity control por usuario
     (RPC `check_topup_velocity`, Fase B1).
  2. Insertar una fila en `payment_intents` con `payment_provider = 'X'`,
     `status = 'created'`, `intent_type = 'recharge'`, y los montos snapshot
     (`amount_cup`, `amount_usd`, `exchange_rate`, `fee_usd`).
  3. Llamar a la API de `X` para crear el cargo/sesión; guardar el id externo;
     pasar `status` a `'pending'`.
- **Salida:** un `RechargeIntentResult` — los campos comunes (`ok`, `provider`,
  `intentId`, `amountCup`, `amountUsd`, `feeUsd`, `exchangeRate`) más los campos
  que la UI de `X` necesite: `clientSecret` + `publishableKey` para Stripe,
  `redirectUrl` para un proveedor con redirección.

## 2. Edge function `process-X-webhook`

- **Debe:**
  1. Verificar la firma/autenticidad del webhook según el esquema de `X`
     (Stripe usa HMAC sobre el raw body; otros usan firma digital, IP whitelist,
     etc.).
  2. Mapear el evento a la fila de `payment_intents` por un id interno que `X`
     devuelve en el webhook (Stripe lo lleva en `metadata.tricigo_intent_id`).
  3. Claim atómico de idempotencia:
     `UPDATE payment_intents SET status='processing' WHERE id=... AND status IN ('pending','created')`;
     si afecta 0 filas, el webhook ya fue procesado → salir sin re-acreditar.
  4. Llamar al RPC de acreditación (ver §3).
  5. En fallo de pago: `status='failed'` + `error_message`.

## 3. RPC de acreditación

Hoy son `process_stripe_recharge` y `process_stripe_driver_quota_recharge`
(`supabase/migrations/00110_stripe_integration.sql`). Su lógica —acreditar la
wallet, postear la transacción en el ledger, marcar el intent `completed`— **ya
es agnóstica de proveedor**; lo único Stripe-específico es el prefijo de la
idempotency-key y el string `'stripe'` en metadata.

→ La **Fase D2** generaliza este RPC a `process_recharge_payment` (lee el
proveedor de `payment_intents.payment_provider` en lugar de hardcodearlo) y
**repuntea el webhook de Stripe a él en la misma migración**, para que Stripe y
NETOPIA usen el mismo RPC y no se desincronicen.

## 4. Claves en `platform_config`

Por convención, cada proveedor `X` usa claves con prefijo `X_`:

| Clave | Para |
|---|---|
| `X_enabled` | `true`/`false` — si el proveedor está activo |
| `X_secret_key` | credencial de servidor |
| `X_publishable_key` | clave pública / de cliente (si el proveedor la usa) |
| `X_webhook_secret` | secreto para verificar el webhook |
| `X_min_recharge_cup` / `X_max_recharge_cup` | topes por transacción |
| `X_fee_usd` / `X_fee_type` | fee de la plataforma (`fixed` / `percentage`) |

Registry global (migración `00277`):

| Clave | Para |
|---|---|
| `active_payment_provider` | qué proveedor se usa para recargas nuevas |
| `<provider>_enabled` | flag de habilitación de cada proveedor |

## 5. UI de tarjeta

La recarga real ocurre en la web (`apps/web/src/app/wallet/page.tsx`) — las apps
móviles hacen `Linking.openURL('https://tricigo.com/wallet')`. Hoy esa página es
específica de Stripe (Stripe Elements). La **Fase D2** la generaliza para
ramificar según el proveedor: Stripe → Elements con `clientSecret`; un proveedor
con redirección → navegar a `redirectUrl`.

## 6. Tipos y service layer (ya existentes — Fase D1)

- **Tipos** (`packages/types/src/payment.ts`): `PaymentProvider`,
  `RechargeIntentRequest`, `RechargeIntentResult`, `PaymentProviderConfig`.
- **Service** (`packages/api/src/services/payment.service.ts`):
  - `createRechargeIntent(req)` — rutea a `create-${provider}-payment-intent`.
  - `getPaymentProviderConfig(provider)` — lee la config del proveedor.
  - `getActivePaymentProvider()` / `getEnabledPaymentProviders()` — consultan el
    registry.
  - `createStripePaymentIntent()` / `getStripeConfig()` — wrappers de compat.

## Checklist para agregar un proveedor `X`

- [ ] Edge function `create-X-payment-intent` (§1).
- [ ] Edge function `process-X-webhook` (§2).
- [ ] Generalizar el RPC de acreditación si aún no se hizo (§3).
- [ ] Claves `X_*` en `platform_config` vía migración (§4).
- [ ] `X_enabled = true` cuando esté verificado en Sandbox.
- [ ] Ramificar la UI web de recarga si `X` no usa Stripe Elements (§5).
- [ ] Tarjetas de prueba en Sandbox; verificar webhook + reconciliación.
