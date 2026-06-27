# NETOPIA → Stripe fallback (in-app self-recharge) — design

**Status:** design approved (2026-06-27). Backend not yet built; WebView hook deferred.
**Scope:** mobile only (V1). Web out of scope.
**Related:**
- `docs/superpowers/specs/2026-06-26-diaspora-recharge-design.md` — the *public web* diaspora recharge (a separate Stripe flow, already built).
- CLAUDE.md → NETOPIA sections; memory `project_netopia_stripe_fallback`, `project_diaspora_recharge`.

## Problem

NETOPIA's hosted payment page is geo-blocked from Cuba (Google Cloud Armor `403`, IP-reputation — not geo). The block happens when the **browser** loads NETOPIA's page. The Edge Function that *creates* the intent succeeds, so a server-side failover can't detect the failure. Users in Cuba can't complete a NETOPIA recharge even though the intent was created fine.

## Goal

When NETOPIA fails to load in the in-app recharge, automatically fall back to Stripe Checkout so the user can still top up — without the user having to understand why.

## Decisions (from the user)

1. **Trigger — automatic in the browser.** The NETOPIA WebView detects the load failure (HTTP `403` via `onHttpError`, network error via `onError`, or a load timeout) and switches to Stripe with no user action.
2. **Surface — mobile only (V1).** Reliable `403` detection needs a custom `react-native-webview` (it exposes `onHttpError`). The web recharge is a `window.location` redirect — once the browser navigates to NETOPIA the app loses control and cannot auto-detect the `403`. Web is deferred (could later use a config switch or user-choice).
3. **Build order — backend now, WebView hook later.** The backend EF is independent and is built first; the hook drops into the WebView when one is available.

## Dependency

Auto-detect requires a **custom WebView**. As of the design date the in-app recharge uses `WebBrowser.openAuthSessionAsync` (the opaque system browser — it cannot see the `403`). The custom WebView (`NetopiaCheckout` + the `webview-proxy` native module) lands via **PR #664** (already on `origin/master`). The `claude/diaspora-recharge` branch must rebase onto master to pick up `NetopiaCheckout`; the hook then lives inside it.

## Components

### Backend — build now

**New EF `create-stripe-payment-intent`** — authenticated **self-recharge**, distinct from the public diaspora `create-stripe-recharge-intent`.

- `config.toml`: `verify_jwt = true`.
- Contract mirrors `create-netopia-payment-intent`: body `{ user_id, amount_usd, recharge_type, corporate_account_id? }`, sent by `paymentService.createRechargeIntent({ provider: 'stripe', … })`.
- **Auth:** `user_id` must equal the authenticated user (or an admin). The user funds **their own** wallet → `payment_intents.user_id = the authenticated user`.
- Reuses the fee + FX logic; inserts `payment_intents` with `payment_provider='stripe'`; creates a Stripe Checkout Session; returns `{ ok, redirectUrl }`.
- **Reuses the existing `process-stripe-webhook`** — it credits `payment_intents.user_id` regardless of self vs diaspora. **No new webhook.**

**Provider registration** in `packages/api/src/services/payment.service.ts`: add `'stripe'` to `KNOWN_PROVIDERS` (today `['netopia', 'euplatesc']`) plus a `stripe_enabled` `platform_config` flag, so `getEnabledPaymentProviders` includes it. `createRechargeIntent` already routes to `create-${provider}-payment-intent` dynamically.

### WebView hook — deferred (inside `NetopiaCheckout` from #664)

On `onHttpError` (403) / `onError` / load-timeout while loading the NETOPIA page:

1. call `paymentService.createRechargeIntent({ provider: 'stripe', user_id, amount_usd, recharge_type })`,
2. load the returned `redirectUrl` (Stripe Checkout) in the same WebView,
3. the Stripe `success_url` returns to the app → `pollIntentStatus` → success.

## Flow (complete)

1. Recharge → `create-netopia-payment-intent` → NETOPIA URL → WebView.
2. WebView fails to load NETOPIA (403 / timeout) → hook fires.
3. Hook → `create-stripe-payment-intent` → Stripe Checkout URL in the WebView.
4. Pay → `process-stripe-webhook` → `process_recharge_payment` credits the user's wallet.

## Error handling

One-level fallback (NETOPIA → Stripe). If Stripe also fails → "no se pudo procesar." Stripe stays in TEST mode behind `stripe_enabled` until KYC + live keys. Both NETOPIA and Stripe serve **non-Cuban cards only**.

## Out of scope (V1)

- Web auto-fallback (the redirect can't auto-detect the 403). Later: a config switch (`active_payment_provider`) or an explicit user-choice button.
- Anything in the public diaspora web recharge — that is a separate, already-built flow (`/recargar`).

## As-built (2026-06-27)

The **backend is built** on `claude/diaspora-recharge`; the WebView hook is deferred.

- `supabase/functions/create-stripe-payment-intent/index.ts` — the authenticated self-recharge EF. Mirrors `create-netopia-payment-intent` (JWT auth via `getUser`; `user_id` must equal the caller, admins exempt; OFAC region block; per-IP rate limit `create-stripe-pi`; MIN/MAX USD; FX fail-closed >24h; additive fee `max(3%,$0.50)`, only NET credited; velocity check) and creates a Stripe Checkout Session instead of the NETOPIA hosted page.
- `supabase/config.toml` — `[functions.create-stripe-payment-intent] verify_jwt = true`.
- `packages/api/src/services/payment.service.ts` — `'stripe'` added to `KNOWN_PROVIDERS`.

As-built deltas vs the plan above:

- **No migration needed.** `platform_config.stripe_enabled` already exists (JSONB boolean `false`, set by `00281_remove_stripe_promote_netopia`). The EF reads it **fail-closed**; flip to `true` to enable. `getEnabledPaymentProviders` correctly excludes Stripe while it's `false`.
- **No `metadata` field.** An earlier draft wrote `metadata: { source: 'self_recharge' }`, but `payment_intents.metadata` doesn't exist in prod yet (added by the diaspora migration `00462`). It was removed — the self-recharge EF does **not** need it, so it has **no dependency on 00462**.
- Reuses the existing `process-stripe-webhook` (matches on `client_reference_id`, claim set includes `pending`) and `process_recharge_payment` (validates against NET `amount_usd`, credits `user_id`). End-to-end verified by adversarial review against the prod schema.
- `success_url`/`cancel_url` are https-only (Stripe rejects custom schemes); the mobile WebView passes an `https://tricigo.com/` return URL it detects to dismiss + `pollIntentStatus`.

Verification: `pnpm check-types` 4/4; adversarial review (1 P0 `metadata` → fixed, 1 P1 gate hardening → fixed, remaining P2/P3 pre-existing & shared with siblings).

Still pending (the hook): `onHttpError`→Stripe inside `NetopiaCheckout` (lands with #664 on rebase), then deploy the EF, flip `stripe_enabled`, and rebuild the apps.
