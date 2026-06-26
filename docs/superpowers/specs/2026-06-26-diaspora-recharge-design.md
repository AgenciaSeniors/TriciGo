# Diáspora Recharge — Design Spec

**Date:** 2026-06-26
**Status:** Approved (pending spec review)
**Owner:** Eduardo

## Goal

A **public, no-login** page on `tricigo.com` where someone abroad recharges a
relative's TriciGo wallet, paid with Stripe. Reference: `cincotaxi.com/recharge`.
This is the Stripe payment surface the processor's review will eventually look at
("where does the customer pay?"), and the diaspora-funding model designed earlier
(foreign card → Cuban user's wallet; Stripe never touches Cuba).

## Locked decisions

1. **Recipient display:** show the recipient's **full name** ("Recargando a: Juan
   Pérez"), mitigated by **per-IP rate-limiting** in the lookup Edge Function.
2. **Fee:** the **payer pays the fee** additively — `fee = MAX(amount × 3%, $0.50)`
   (same model as the current NETOPIA recharge). The recipient receives
   `amount_usd × market_rate` in TriciCoin.
3. **Minimum:** **$20 USD** (matches the existing customer-recharge floor).
4. **Payment processor:** Stripe **Checkout (hosted page)** — lowest PCI scope
   (SAQ-A), reuses the redirect pattern, Stripe handles card + 3DS + email receipt.
5. **Payment confirmation:** by **email** (Stripe Checkout collects the payer email
   and sends the receipt). Recipient gets an **in-app notification**.

## Architecture

Reuses the existing recharge backend (`payment_intents`, `process_recharge_payment`)
with `payment_intents.user_id = the recipient` (not the payer).

### 1. Public page — `apps/web/src/app/recargar/page.tsx` (no auth)
- Field: recipient Cuban phone (`+53`). On input (debounced ~400ms) → calls the
  resolve EF → shows **"Recargando a: <full name>"** or "no es usuario de TriciGo".
- Field: amount USD (min $20). Shows market rate + **"Recibirá: X TriciCoin"** +
  a visible **fee line** + total charged.
- Field: payer email (for the receipt).
- "Realizar pago" → calls the create-intent EF → **redirects to Stripe Checkout**.
- Region-neutral copy (consistent with the neutralized site). Add a **"Recargar"**
  item to the web nav (like Cinco), gated by the feature flag.
- Client patterns: debounce + AbortController + cache (mirror AddressSearchInput).

### 2. EF `resolve-recharge-recipient` (public, `verify_jwt=false`)
- Body `{ phone }` → **per-IP rate-limit** (anti-enumeration) → normalize via
  `_normalize_cuban_phone` → `find_user_by_phone` (service-role) → return
  `{ found: boolean, fullName?: string }`. **Does NOT return the user id** (the
  create-intent EF re-resolves server-side, so the client can't pick the recipient).

### 3. EF `create-stripe-recharge-intent` (public, `verify_jwt=false`)
- Body `{ phone, amount_usd, payer_email }`.
- **Re-resolves** the phone → recipient **server-side** (authoritative; client can't
  forge the recipient).
- Validates: recipient exists + active + **wallet not frozen**; `amount_usd >= 20`;
  email format; per-IP velocity.
- Computes `fee_usd = MAX(amount_usd × 0.03, 0.50)`, `charge_usd = amount_usd + fee`,
  `amount_cup = ROUND(amount_usd × exchange_rate)` (current `exchange_rates`).
- Inserts `payment_intents`: `user_id = recipient`, `payment_provider = 'stripe'`,
  `intent_type = 'recharge'`, `recharge_type` from recipient role
  (`_gift_wallet_type`: driver → `tricicoin`, else `customer`), `amount_usd`,
  `amount_cup`, `fee_usd`, `exchange_rate`, metadata `{ payer_email, source:
  'diaspora', recipient_phone_masked }`.
- Creates a **Stripe Checkout Session** (`mode=payment`, line item = `charge_usd`,
  `customer_email = payer_email`, `client_reference_id = intent.id`, success/cancel
  URLs back to `/recargar`). Returns the Checkout URL. Page redirects.

### 4. EF `process-stripe-webhook` (public endpoint, **Stripe signature verified**)
- On `checkout.session.completed`: verify `Stripe-Signature` (HMAC, simpler than
  NETOPIA's re-query), look up the intent by `client_reference_id`, **atomic claim**
  (`UPDATE … WHERE status IN ('pending','created','failed')`), then call
  **`process_recharge_payment(intent_id, payload)`** (existing RPC — credits the
  recipient's role wallet, double-entry ledger, idempotent by `idempotency_key`).
- Then: generate receipt (reuse `generate-recharge-receipt`) + **in-app
  notification to the recipient** ("Recibiste una recarga de X TriciCoin").
- Idempotent: atomic claim + the RPC's `idempotency_key` (replay-safe).

## Phone-bug safeguard (migration 00461 / PR #669)

Both EFs resolve the phone with `_normalize_cuban_phone` + `find_user_by_phone`
(the exact functions fixed in 00461, which compare the **normalized** value on both
sides). A phone in any format (`+535xxxxxxx`, `535xxxxxxx`, `5xxxxxxx`) resolves to
the correct user. **The raw phone is never compared.** This is the critical
correctness point — the prior bug (mixed `+535` vs `535`) broke gift/phone lookups.

## Stripe not active yet → build with TEST mode

Stripe issues **test-mode keys immediately on signup** (before KYC/activation). We
build and test the full flow with **test keys + test cards** now; swap to **live
keys** when María's KYC completes. The page + nav item stay behind a
**feature flag** (`diaspora_recharge_enabled` in `platform_config`, default off)
until live.

### Secrets / config
- Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, publishable key (test now,
  live later).
- `platform_config`: `diaspora_recharge_enabled` (flag), reuse `exchange_rates` for FX.

## Error handling & edge cases
- Recipient not found → "Este número no es usuario de TriciGo. Pedile que instale la
  app." (no payment created).
- Below min / bad email → inline validation.
- Recipient wallet **frozen** → block at create-intent (don't send to Stripe).
- Payment cancelled/failed → return to `/recargar` with a message; intent marked
  `failed` (recoverable on a later successful webhook, like the NETOPIA fix).
- Webhook replay → idempotent (atomic claim + `idempotency_key`).
- Stale FX (`exchange_rates.created_at` > 24h) → block (reuse existing check).
- Enumeration → per-IP rate-limit on the resolve EF.

## Testing
- Stripe **test mode** E2E (test cards: success, 3DS, decline).
- Phone normalization: `+535…`, `535…`, `5…` all resolve to the same recipient.
- Anti-enumeration: rate-limit kicks in after N lookups/IP.
- Idempotency: duplicate webhook → single credit.
- Frozen wallet → blocked.

## Out of scope (V1)
- Stripe Elements / embedded card form (V2 if we want no-redirect UX).
- Recipient lookup by gift-code (only phone in V1).
- Recurring / scheduled diaspora recharges.
- Corporate diaspora funding.

## Reuse map (what already exists)
- `payment_intents` table + `process_recharge_payment` + `process_recharge_refund`
  (provider-agnostic; idempotency keys literally `stripe_recharge_*`).
- `_gift_wallet_type`, `_normalize_cuban_phone`, `find_user_by_phone`.
- `exchange_rates`, the fee math, `generate-recharge-receipt`, `send-push`.
- Dormant Stripe vestiges (`process_stripe_recharge`, `stripe_enabled`) from when
  Stripe was the provider pre-2026-05-20.
