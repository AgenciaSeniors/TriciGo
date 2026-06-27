# Diáspora Recharge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, no-login page `tricigo.com/recargar` where someone abroad recharges a relative's TriciGo wallet via Stripe Checkout.

**Architecture:** Mirror the NETOPIA recharge flow (`create-netopia-payment-intent` + `process-netopia-webhook`) as a Stripe sibling, but **public** (`verify_jwt=false`) with the recipient resolved by phone server-side. Reuse `payment_intents` + `process_recharge_payment` with `payment_intents.user_id = the recipient`. Built in Stripe **test mode** now; live keys after KYC; gated by a `feature_flags` row.

**Tech Stack:** Supabase Edge Functions (Deno, esm.sh imports), Postgres migrations, Next.js App Router (`apps/web`), Stripe SDK (`https://esm.sh/stripe@17.5.0?target=deno`).

---

## Reference files (read these — they are the structural template)
- `supabase/functions/create-netopia-payment-intent/index.ts` — template for create-intent (CORS, service client, FX check, fee math, payment_intents INSERT).
- `supabase/functions/process-netopia-webhook/index.ts` — template for the webhook (atomic claim, `process_recharge_payment` call, receipt + push).
- `supabase/functions/_shared/rate-limiter.ts` — `rateLimit(key, max, windowMs)`.
- `supabase/migrations/00461_normalize_cuban_phone.sql` — `_normalize_cuban_phone` + `find_user_by_phone` (THE phone fix).
- `apps/web/src/components/AddressAutocomplete.tsx` — debounce + AbortController pattern.
- `packages/api/src/hooks/useFeatureFlag.ts` — `useFeatureFlag('key')` (reads `feature_flags` table).

## Key facts locked from code review
- Stripe in Deno: import via **esm.sh** (`npm:` is NOT supported). Webhook verify is async: `await stripe.webhooks.constructEventAsync(rawBody, sig, secret)`.
- The web reads flags from the **`feature_flags`** table (NOT `platform_config`), via `useFeatureFlag`.
- `find_user_by_phone` has an INTERNAL per-caller rate-limit keyed on `auth.uid()`; for a service-role/anon path that key collapses to one shared bucket → we add a dedicated **`find_recipient_for_recharge`** RPC (same normalized WHERE, no per-user limit) and rate-limit per-IP in the EF.
- `process_recharge_payment` validates `p_webhook_payload->>'amount'` against `payment_intents.amount_usd` (±5%, currency USD) — so the webhook payload's `amount` MUST be the **net `amount_usd`** (not the fee-inclusive charge).
- `_gift_wallet_type(user_id)` → `'tricicoin'` (driver) | `'customer_cash'` (else). For `recharge_type` we map driver→`'tricicoin'`, else→`'customer'`.
- Env vars: EFs use `Deno.env.get('SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY')`; web uses `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## File structure
- Create: `supabase/migrations/00463_diaspora_recharge.sql`
- Create: `supabase/functions/_shared/stripe.ts`
- Create: `supabase/functions/resolve-recharge-recipient/index.ts`
- Create: `supabase/functions/create-stripe-recharge-intent/index.ts`
- Create: `supabase/functions/process-stripe-webhook/index.ts`
- Modify: `supabase/config.toml` (register the 3 EFs)
- Create: `apps/web/src/app/recargar/page.tsx`
- Modify: `apps/web/src/app/web-header.tsx` (+ `web-footer.tsx`) — "Recargar" link behind flag
- Modify: `packages/i18n/src/locales/{es,en,pt}/web.json` (recharge copy)

---

## Task 1: Migration — recipient-resolution RPC + feature flag

**Files:** Create `supabase/migrations/00463_diaspora_recharge.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00463: Diaspora recharge — public recipient resolution + feature flag.
-- A public (no-login) page lets someone abroad recharge a Cuban user's wallet.
-- The lookup MUST use the 00461-normalized matching (the phone bug fix); this
-- RPC reuses _normalize_cuban_phone on BOTH sides, with NO per-user rate-limit
-- (the Edge Function rate-limits per IP instead).

CREATE OR REPLACE FUNCTION public.find_recipient_for_recharge(p_phone text)
RETURNS TABLE(id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT u.id, u.full_name
  FROM users u
  WHERE public._normalize_cuban_phone(u.phone) = public._normalize_cuban_phone(p_phone)
    AND u.is_active = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_recipient_for_recharge(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_recipient_for_recharge(text) TO service_role;

-- Feature flag (default OFF until Stripe is live). The web reads feature_flags.
INSERT INTO public.feature_flags (key, value, description)
VALUES ('diaspora_recharge_enabled', 'false', 'Public diaspora wallet-recharge page (/recargar) via Stripe')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Pre-flight the feature_flags shape** (the INSERT columns must match)

Run (read-only, via Supabase MCP `execute_sql`):
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='public' AND table_name='feature_flags' ORDER BY ordinal_position;
```
Expected: columns `key`, `value`, `description` exist. If `description` does not exist, drop it from the INSERT. If `value` is boolean (not text), use `false` instead of `'false'`.

- [ ] **Step 3: Commit (do NOT apply — MCP guard; frontend tolerates absence)**

```bash
git add supabase/migrations/00463_diaspora_recharge.sql
git commit -m "feat(recharge): migration for diaspora recipient resolution + feature flag"
```

> The migration is committed, not applied to prod (MCP guard). The EF tolerates the RPC being absent (returns "not found" / disabled). Real apply is a human `supabase db push` or the deploy pipeline.

---

## Task 2: Shared Stripe helper

**Files:** Create `supabase/functions/_shared/stripe.ts`

- [ ] **Step 1: Write the helper**

```ts
// Shared Stripe client for Edge Functions (Deno). esm.sh (npm: is unsupported).
// Test-mode keys now; live keys swapped in Supabase secrets after KYC.
import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno';

export function getStripe(): Stripe {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function stripeWebhookSecret(): string {
  const s = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!s) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return s;
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/stripe.ts
git commit -m "feat(recharge): shared Stripe client helper for edge functions"
```

---

## Task 3: EF — resolve-recharge-recipient (public, rate-limited)

**Files:** Create `supabase/functions/resolve-recharge-recipient/index.ts`

- [ ] **Step 1: Write the function** (copy the CORS + service-client boilerplate structure from `create-netopia-payment-intent/index.ts:24-46`; the new logic is below)

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  // Anti-enumeration: per-IP rate-limit (this is the public path's guard).
  const rl = await rateLimit(`resolve-recipient:${clientIP}`, 20, 60 * 1000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  try {
    const { phone } = await req.json() as { phone?: string };
    if (!phone || typeof phone !== 'string' || phone.replace(/\D/g, '').length < 8) {
      return json(corsHeaders, 200, { found: false });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await supabase.rpc('find_recipient_for_recharge', { p_phone: phone });
    if (error) {
      console.warn('[resolve-recipient] rpc error (treating as not found):', error.message);
      return json(corsHeaders, 200, { found: false });
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.id) return json(corsHeaders, 200, { found: false });
    // Return ONLY the display name. Never the user id (the create-intent EF
    // re-resolves server-side so the client cannot pick the recipient).
    return json(corsHeaders, 200, { found: true, fullName: row.full_name ?? '' });
  } catch (err) {
    console.error('[resolve-recipient] error:', err);
    return json(corsHeaders, 200, { found: false });
  }
});

function json(corsHeaders: Record<string, string>, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/resolve-recharge-recipient/index.ts
git commit -m "feat(recharge): public resolve-recharge-recipient edge function"
```

---

## Task 4: EF — create-stripe-recharge-intent (public)

**Files:** Create `supabase/functions/create-stripe-recharge-intent/index.ts`

- [ ] **Step 1: Write the function** (mirror `create-netopia-payment-intent` for CORS/client/FX/fee; the deltas are: no auth, resolve recipient by phone, Stripe Checkout instead of NETOPIA)

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { rateLimit, rateLimitResponse } from '../_shared/rate-limiter.ts';
import { getStripe } from '../_shared/stripe.ts';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return { 'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
}
const MIN_USD = 20;
const MAX_USD = 500;
const SANCTIONED_REGIONS = new Set(['CU', 'IR', 'KP', 'SY']);

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const J = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = await rateLimit(`create-stripe-recharge:${clientIP}`, 5, 60 * 1000);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  // OFAC region block: the payer must NOT be in a sanctioned country.
  const country = (req.headers.get('cf-ipcountry') ?? 'XX').toUpperCase();
  if (SANCTIONED_REGIONS.has(country)) {
    return J(451, { ok: false, error: 'region_unsupported', detail: 'Card payments are not available from this region.' });
  }

  try {
    const { phone, amount_usd, payer_email } = await req.json() as { phone?: string; amount_usd?: number; payer_email?: string };
    if (!phone || !Number.isFinite(amount_usd as number) || (amount_usd as number) <= 0 || !payer_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payer_email)) {
      return J(400, { ok: false, error: 'invalid_params' });
    }
    const amt = amount_usd as number;
    if (amt < MIN_USD) return J(400, { ok: false, error: 'amount_too_low', min_usd: MIN_USD });
    if (amt > MAX_USD) return J(400, { ok: false, error: 'amount_too_high', max_usd: MAX_USD });

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Authoritative recipient resolution (server-side; client cannot forge it).
    const { data: recRows, error: recErr } = await supabase.rpc('find_recipient_for_recharge', { p_phone: phone });
    const recipient = Array.isArray(recRows) ? recRows[0] : recRows;
    if (recErr || !recipient?.id) return J(404, { ok: false, error: 'recipient_not_found', detail: 'Este número no es usuario de TriciGo.' });

    // Wallet must not be frozen. recharge_type from role (driver→tricicoin, else customer).
    const { data: roleRow } = await supabase.from('users').select('role').eq('id', recipient.id).single();
    const rechargeType = roleRow?.role === 'driver' ? 'tricicoin' : 'customer';
    const walletType = roleRow?.role === 'driver' ? 'tricicoin' : 'customer_cash';
    const { data: walletRow } = await supabase.from('wallet_accounts').select('is_frozen').eq('user_id', recipient.id).eq('account_type', walletType).maybeSingle();
    if (walletRow?.is_frozen) return J(409, { ok: false, error: 'recipient_wallet_frozen', detail: 'La billetera del destinatario está suspendida.' });

    // FX staleness (fail closed if missing / > 24h).
    const { data: rateRow } = await supabase.from('exchange_rates').select('usd_cup_rate, created_at').eq('is_current', true).single();
    const fxTooOld = !rateRow?.created_at || (Date.now() - new Date(rateRow.created_at).getTime()) > 24 * 60 * 60 * 1000;
    if (!rateRow?.usd_cup_rate || fxTooOld) return J(503, { ok: false, error: 'fx_unavailable', detail: 'Tipo de cambio no disponible. Intentalo más tarde.' });
    const exchangeRate = rateRow.usd_cup_rate as number;

    // Fee math (same as NETOPIA recharge): payer pays the fee additively.
    const feeUsd = Math.max(Number((amt * 0.03).toFixed(2)), 0.50);
    const chargeUsd = Number((amt + feeUsd).toFixed(2));
    const amountCupCredited = Math.round(amt * exchangeRate);

    // payment_intents: user_id = RECIPIENT. payer email + masked phone in metadata.
    const phoneDigits = phone.replace(/\D/g, '');
    const { data: intent, error: insErr } = await supabase.from('payment_intents').insert({
      user_id: recipient.id,
      amount_usd: amt,
      amount_cup: amountCupCredited,
      exchange_rate: exchangeRate,
      fee_usd: feeUsd,
      status: 'created',
      payment_provider: 'stripe',
      intent_type: 'recharge',
      recharge_type: rechargeType,
      client_ip: clientIP,
      metadata: { source: 'diaspora', payer_email, recipient_phone_masked: `***${phoneDigits.slice(-4)}` },
    }).select().single();
    if (insErr || !intent) {
      console.error('[create-stripe-recharge] insert error:', insErr?.message);
      return J(500, { ok: false, error: 'db_error' });
    }

    // Stripe Checkout Session (hosted page). Amount in cents. Email for the receipt.
    const siteUrl = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://tricigo.com';
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: payer_email,
      client_reference_id: intent.id,
      success_url: `${siteUrl}/recargar?status=ok&intent=${intent.id}`,
      cancel_url: `${siteUrl}/recargar?status=cancel&intent=${intent.id}`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(chargeUsd * 100),
          product_data: { name: `TriciGo — recarga para ${recipient.full_name ?? 'usuario'}` },
        },
      }],
      payment_intent_data: { metadata: { tricigo_intent_id: intent.id } },
      metadata: { tricigo_intent_id: intent.id },
    });

    await supabase.from('payment_intents').update({ stripe_payment_intent_id: session.id, status: 'pending', updated_at: new Date().toISOString() }).eq('id', intent.id);

    return J(200, { ok: true, provider: 'stripe', intentId: intent.id, amountUsdRequested: amt, feeUsd, chargeUsd, amountCupCredited, exchangeRate, redirectUrl: session.url });
  } catch (err) {
    console.error('[create-stripe-recharge] error:', err);
    return J(500, { ok: false, error: 'internal_error' });
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/create-stripe-recharge-intent/index.ts
git commit -m "feat(recharge): create-stripe-recharge-intent edge function (public)"
```

---

## Task 5: EF — process-stripe-webhook

**Files:** Create `supabase/functions/process-stripe-webhook/index.ts`

- [ ] **Step 1: Write the function** (mirror `process-netopia-webhook` atomic claim + RPC + receipt + push; auth = Stripe signature)

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2';
import { getStripe, stripeWebhookSecret } from '../_shared/stripe.ts';

const ACK = { received: true };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const sig = req.headers.get('stripe-signature');
  const rawBody = await req.text();
  const stripe = getStripe();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig ?? '', stripeWebhookSecret());
  } catch (err) {
    console.error('[stripe-webhook] signature verify failed:', (err as Error).message);
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify(ACK), { status: 200 }); // ACK other events
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const session = event.data.object as { id: string; client_reference_id?: string | null; amount_total?: number | null; payment_status?: string };
  const intentId = session.client_reference_id;
  if (!intentId) return new Response(JSON.stringify(ACK), { status: 200 });
  if (session.payment_status !== 'paid') return new Response(JSON.stringify(ACK), { status: 200 });

  // Load intent (for amount_cup / user_id used in the notification).
  const { data: existingIntent } = await supabase.from('payment_intents').select('user_id, amount_usd, amount_cup, status').eq('id', intentId).single();
  if (!existingIntent) return new Response(JSON.stringify(ACK), { status: 200 });
  if (existingIntent.status === 'completed') return new Response(JSON.stringify(ACK), { status: 200 }); // replay

  // Atomic claim (idempotent: 0 rows on replay).
  const { data: claimed } = await supabase.from('payment_intents')
    .update({ status: 'processing', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', intentId).in('status', ['pending', 'created', 'failed', 'expired']).select();
  if (!claimed || claimed.length === 0) return new Response(JSON.stringify(ACK), { status: 200 });

  // Credit the recipient. amount = NET amount_usd so the RPC's ±5% USD check passes.
  const { error: processError } = await supabase.rpc('process_recharge_payment', {
    p_payment_intent_id: intentId,
    p_webhook_payload: { stripe_session_id: session.id, amount: existingIntent.amount_usd, currency: 'USD', stripe_status: 'paid' },
  });
  if (processError) {
    console.error('[stripe-webhook] process_recharge_payment error:', processError.message);
    return new Response(JSON.stringify({ error: 'process_error', detail: processError.message }), { status: 500 }); // Stripe retries
  }

  // Receipt (fire-and-forget) + recipient in-app notification.
  fetch(`${supabaseUrl}/functions/v1/generate-recharge-receipt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ payment_intent_id: intentId }),
  }).catch((e) => console.error('[stripe-webhook] receipt trigger failed:', e));

  try {
    const amount = (existingIntent.amount_cup ?? 0).toLocaleString('es-CU');
    await fetch(`${supabaseUrl}/functions/v1/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': serviceRoleKey, 'Authorization': `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({
        user_id: existingIntent.user_id,
        title: 'Recibiste una recarga',
        body: `Te recargaron ${amount} TriciCoin en tu billetera.`,
        category: 'wallet_recharge',
        data: { type: 'wallet_recharge', success: 'true', provider: 'stripe' },
      }),
    });
  } catch (e) { console.error('[stripe-webhook] notify failed:', e); }

  return new Response(JSON.stringify(ACK), { status: 200 });
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/process-stripe-webhook/index.ts
git commit -m "feat(recharge): process-stripe-webhook edge function"
```

---

## Task 6: Register the EFs in config.toml

**Files:** Modify `supabase/config.toml`

- [ ] **Step 1: Add three blocks** (next to the other `[functions.*]` entries; all three are PUBLIC — they self-auth or verify signatures)

```toml
[functions.resolve-recharge-recipient]
verify_jwt = false

[functions.create-stripe-recharge-intent]
verify_jwt = false

[functions.process-stripe-webhook]
verify_jwt = false
```

- [ ] **Step 2: Commit**

```bash
git add supabase/config.toml
git commit -m "chore(recharge): register the 3 diaspora-recharge edge functions"
```

---

## Task 7: i18n copy

**Files:** Modify `packages/i18n/src/locales/es/web.json` (then mirror keys in `en/web.json`, `pt/web.json`)

- [ ] **Step 1: Add a `recharge` block to `es/web.json`** (inside the existing top-level object)

```json
"recharge": {
  "nav": "Recargar",
  "title": "Recargar billetera",
  "subtitle": "Recargá la billetera TriciGo de un familiar en Cuba.",
  "recipient_phone": "Teléfono del usuario a recargar",
  "recipient_found": "Recargando a: {{name}}",
  "recipient_not_found": "Este número no es usuario de TriciGo. Pedile que instale la app.",
  "amount": "Monto a recargar (USD)",
  "amount_min": "Mínimo 20",
  "rate": "Tasa de cambio",
  "will_receive": "Recibirá en billetera",
  "fee": "Comisión",
  "total": "Total a pagar",
  "payer_email": "Tu email (para el comprobante)",
  "pay": "Realizar pago",
  "secured_by_stripe": "Pago seguro procesado por Stripe.",
  "success": "¡Recarga enviada! El comprobante llegó a tu email.",
  "cancelled": "Pago cancelado.",
  "error": "No se pudo procesar. Intentalo de nuevo."
}
```

- [ ] **Step 2: Mirror the same keys** in `en/web.json` and `pt/web.json` (translate the values; keep `{{name}}` placeholders).

- [ ] **Step 3: Commit**

```bash
git add packages/i18n/src/locales/es/web.json packages/i18n/src/locales/en/web.json packages/i18n/src/locales/pt/web.json
git commit -m "feat(recharge): i18n copy for the recharge page (es/en/pt)"
```

---

## Task 8: Public page /recargar

**Files:** Create `apps/web/src/app/recargar/page.tsx`

- [ ] **Step 1: Write the page** (client component; debounced resolve via `supabase.functions.invoke`; feature-flag gated; mirrors the inline-style pattern of other web pages)

```tsx
'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from '@tricigo/i18n';
import { useFeatureFlag } from '@tricigo/api';
import { getSupabaseClient } from '@tricigo/api';

export default function RechargePage() {
  const { t } = useTranslation('web');
  const enabled = useFeatureFlag('diaspora_recharge_enabled');

  const [phone, setPhone] = useState('');
  const [recipient, setRecipient] = useState<{ found: boolean; fullName?: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Current FX rate for the live "will receive" preview.
  useEffect(() => {
    (async () => {
      const { data } = await getSupabaseClient().from('exchange_rates').select('usd_cup_rate').eq('is_current', true).single();
      if (data?.usd_cup_rate) setRate(Number(data.usd_cup_rate));
    })();
  }, []);

  const resolve = useCallback((value: string) => {
    if (abortRef.current) abortRef.current.abort();
    if (value.replace(/\D/g, '').length < 8) { setRecipient(null); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    getSupabaseClient().functions.invoke('resolve-recharge-recipient', { body: { phone: `+53${value.replace(/\D/g, '').replace(/^53/, '')}` } })
      .then(({ data }) => { if (!controller.signal.aborted) setRecipient(data as { found: boolean; fullName?: string }); })
      .catch(() => { if (!controller.signal.aborted) setRecipient({ found: false }); });
  }, []);

  function onPhoneChange(v: string) {
    setPhone(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => resolve(v), 400);
  }

  const amt = Number(amount) || 0;
  const fee = amt > 0 ? Math.max(Number((amt * 0.03).toFixed(2)), 0.5) : 0;
  const willReceive = rate && amt > 0 ? Math.round(amt * rate) : 0;

  async function handlePay() {
    setError(null);
    if (!recipient?.found || amt < 20 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError(t('recharge.error')); return; }
    setSubmitting(true);
    try {
      const { data, error: efErr } = await getSupabaseClient().functions.invoke('create-stripe-recharge-intent', {
        body: { phone: `+53${phone.replace(/\D/g, '').replace(/^53/, '')}`, amount_usd: amt, payer_email: email },
      });
      const res = data as { ok?: boolean; redirectUrl?: string };
      if (efErr || !res?.ok || !res.redirectUrl) throw new Error('failed');
      window.location.href = res.redirectUrl; // → Stripe Checkout
    } catch {
      setError(t('recharge.error'));
      setSubmitting(false);
    }
  }

  if (!enabled) {
    return <main style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>—</main>;
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: '2.5rem 1.25rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.25rem' }}>{t('recharge.title')}</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{t('recharge.subtitle')}</p>

      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('recharge.recipient_phone')}</label>
      <input value={phone} onChange={(e) => onPhoneChange(e.target.value)} inputMode="numeric" placeholder="+53 …"
        style={{ width: '100%', padding: '0.7rem 0.9rem', margin: '0.4rem 0 0.25rem', borderRadius: '0.6rem', border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />
      {recipient && (
        <p style={{ fontSize: '0.85rem', color: recipient.found ? 'var(--primary)' : 'var(--error, #c00)', marginBottom: '1rem' }}>
          {recipient.found ? t('recharge.recipient_found', { name: recipient.fullName }) : t('recharge.recipient_not_found')}
        </p>
      )}

      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('recharge.amount')}</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder={t('recharge.amount_min')}
        style={{ width: '100%', padding: '0.7rem 0.9rem', margin: '0.4rem 0 0.75rem', borderRadius: '0.6rem', border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '0.6rem', padding: '0.9rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
        <Row label={t('recharge.rate')} value={rate ? `${rate} CUP / USD` : '—'} />
        <Row label={t('recharge.fee')} value={`$${fee.toFixed(2)}`} />
        <Row label={t('recharge.total')} value={`$${(amt + fee).toFixed(2)}`} />
        <Row label={t('recharge.will_receive')} value={`${willReceive.toLocaleString('es-CU')} TriciCoin`} strong />
      </div>

      <label style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('recharge.payer_email')}</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="correo@ejemplo.com"
        style={{ width: '100%', padding: '0.7rem 0.9rem', margin: '0.4rem 0 1rem', borderRadius: '0.6rem', border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />

      {error && <p style={{ color: 'var(--error, #c00)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</p>}

      <button onClick={handlePay} disabled={submitting || !recipient?.found || amt < 20}
        style={{ width: '100%', padding: '0.9rem', borderRadius: '0.6rem', border: 'none', background: 'var(--primary)', color: '#fff', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', opacity: submitting || !recipient?.found || amt < 20 ? 0.6 : 1 }}>
        {t('recharge.pay')}
      </button>
      <p style={{ textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.78rem', marginTop: '0.75rem' }}>🔒 {t('recharge.secured_by_stripe')}</p>
    </main>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: strong ? 800 : 600, color: strong ? 'var(--primary)' : 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm check-types`
Expected: `Tasks: 4 successful, 4 total`. (If `getSupabaseClient`/`useFeatureFlag` aren't exported from `@tricigo/api`, import from their exact paths — grep `packages/api/src/index.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/recargar/page.tsx
git commit -m "feat(recharge): public /recargar diaspora page (flag-gated)"
```

---

## Task 9: Nav + footer "Recargar" link (flag-gated)

**Files:** Modify `apps/web/src/app/web-header.tsx`, `apps/web/src/app/web-footer.tsx`

- [ ] **Step 1: Header** — in `AuthNav`, read the flag and prepend a Recargar link for BOTH guest and authed states. At the top of `AuthNav`, add:

```tsx
const rechargeOn = useFeatureFlag('diaspora_recharge_enabled');
```
(import `useFeatureFlag` from `@tricigo/api`). In the guest `return (<>…</>)`, add before the Blog link:
```tsx
{rechargeOn && <a href="/recargar" className="nav-link-animated" style={{ fontSize: 'var(--text-base)' }}>{t('recharge.nav')}</a>}
```
In the authed `links` array, conditionally include it:
```tsx
const links = [
  ...(rechargeOn ? [{ href: '/recargar', label: t('recharge.nav') }] : []),
  { href: '/rides', label: t('nav.rides') },
  // …rest unchanged
];
```

- [ ] **Step 2: Footer** — in the Links column of `web-footer.tsx`, add (the footer is a client component, so `useFeatureFlag` works):
```tsx
{useFeatureFlag('diaspora_recharge_enabled') && <a href="/recargar" className="footer-link">{t('recharge.nav')}</a>}
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm check-types` → 4 successful.
```bash
git add apps/web/src/app/web-header.tsx apps/web/src/app/web-footer.tsx
git commit -m "feat(recharge): flag-gated Recargar nav + footer link"
```

---

## Task 10: Secrets, Stripe webhook endpoint, and test-mode verification

> No code — operator steps. Do these once the EFs are deployed (the human applies migration 00463, deploys the 3 EFs, sets secrets).

- [ ] **Step 1:** Set Supabase secrets (TEST keys from the Stripe dashboard, test mode):
  `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PUBLISHABLE_KEY=pk_test_…`, `STRIPE_WEBHOOK_SECRET=whsec_…`.
- [ ] **Step 2:** In Stripe (test mode) → Developers → Webhooks → add endpoint
  `https://<project>.supabase.co/functions/v1/process-stripe-webhook`, event `checkout.session.completed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- [ ] **Step 3:** Flip the flag on (test): `UPDATE feature_flags SET value='true' WHERE key='diaspora_recharge_enabled';`
- [ ] **Step 4:** E2E with a Stripe **test card** (`4242 4242 4242 4242`): open `/recargar`, enter a known test user's phone (verify "Recargando a: <name>" shows), amount $20, an email, pay. Confirm: Stripe shows the test payment, the webhook fires, `payment_intents` row → `completed`, the recipient's wallet credited (`SELECT balance FROM wallet_accounts …`), the recipient got the push/inbox notification, and a receipt row exists.
- [ ] **Step 5:** Phone-normalization check: enter the same recipient as `+535XXXXXXX`, `535XXXXXXX`, and `5XXXXXXX` — all three must resolve to the SAME recipient.
- [ ] **Step 6:** When María's KYC completes → swap the secrets to LIVE keys (`sk_live_…`, `whsec_…` for a live webhook endpoint), keep the flag OFF in prod until you're ready to launch.

---

## Self-review (run before handing off)
- **Spec coverage:** page ✓(T8) · resolve EF ✓(T3) · create-intent EF ✓(T4) · webhook EF ✓(T5) · `process_recharge_payment` reuse with `user_id=recipient` ✓(T4/T5) · full-name + per-IP rate-limit ✓(T3) · payer pays fee ✓(T4) · min $20 ✓(T4) · Checkout hosted ✓(T4) · email receipt ✓(Stripe) · recipient notification ✓(T5) · phone-bug safeguard via `_normalize_cuban_phone`/`find_recipient_for_recharge` ✓(T1/T3/T4) · test mode + flag ✓(T1/T10).
- **Placeholder scan:** none (all code shown; i18n values concrete).
- **Type consistency:** EF response `{ ok, redirectUrl }` consumed by the page ✓; `recharge_type` ∈ {'customer','tricicoin'} matches the CHECK constraint ✓; webhook payload `amount = amount_usd` matches the RPC's USD validation ✓.
</content>
