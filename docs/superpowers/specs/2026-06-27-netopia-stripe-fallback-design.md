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
- **No `metadata` field.** An earlier draft wrote `metadata: { source: 'self_recharge' }`, but `payment_intents.metadata` doesn't exist in prod yet (added by the diaspora migration `00463`). It was removed — the self-recharge EF does **not** need it, so it has **no dependency on 00462**.
- Reuses the existing `process-stripe-webhook` (matches on `client_reference_id`, claim set includes `pending`) and `process_recharge_payment` (validates against NET `amount_usd`, credits `user_id`). End-to-end verified by adversarial review against the prod schema.
- `success_url`/`cancel_url` are https-only (Stripe rejects custom schemes); the mobile WebView passes an `https://tricigo.com/` return URL it detects to dismiss + `pollIntentStatus`.

Verification: `pnpm check-types` 4/4; adversarial review (1 P0 `metadata` → fixed, 1 P1 gate hardening → fixed, remaining P2/P3 pre-existing & shared with siblings).

Still pending (the hook): `onHttpError`→Stripe inside `NetopiaCheckout` (lands with #664 on rebase), then deploy the EF, flip `stripe_enabled`, and rebuild the apps.

## Hook implementation — ready to apply (deferred to rebase + go-live)

Designed against the real `NetopiaCheckout` (#664). It is **additive and dormant**: with `stripe_enabled=false` (today) `createRechargeIntent({provider:'stripe'})` throws 503 → the `catch` falls through to the existing NETOPIA-in-browser retry, so `present()` behaves exactly as today. It only activates once the EF is deployed and `stripe_enabled=true`. **Apply to BOTH `apps/client/src/components/NetopiaCheckout.tsx` and `apps/driver/src/components/NetopiaCheckout.tsx` (kept-in-sync duplicates) plus the two callers.** `RETURN_URL_BASE` is already `https://tricigo.com/app/{client,driver}/wallet` in both apps, so it passes the EF's https-only whitelist and the Stripe `success_url` is detected by `isReturnUrl` exactly like the NETOPIA return.

**Why it isn't shipped today:** it changes the payment WebView's failure path, which the component flags as device-test-pending on Android. The active behavior (Stripe re-load in the sheet, return detection, one-shot loop guard) must be verified on a device once the EF is deployed.

### 1. `NetopiaCheckout.tsx`

Carry the recharge params + the *effective* intentId (the Stripe one if it fell back, so the caller polls the right intent):

```tsx
type RechargeType = 'customer' | 'driver_quota' | 'tricicoin';
type PresentArgs = {
  url: string; returnUrlBase: string; intentId: string;
  stripeFallback?: { userId: string; amountUsd: number; rechargeType?: RechargeType };
};
type PresentResult = { outcome: Outcome; intentId: string };
// resolverRef: useRef<((r: PresentResult) => void) | null>(null)
const triedStripeRef = useRef(false);
```

`settle` resolves with the effective intentId:

```tsx
const settle = useCallback((o: Outcome) => {
  if (settledRef.current) return;
  settledRef.current = true;
  WebViewProxy.clearProxyOverride().catch(() => {});
  setActive(null);
  const r = resolverRef.current;
  resolverRef.current = null;
  r?.({ outcome: o, intentId: argsRef.current?.intentId ?? '' });
}, []);
```

`handleLoadFailure` tries Stripe first (one shot), else the existing browser retry:

```tsx
const handleLoadFailure = useCallback(async () => {
  if (settledRef.current) return;
  const args = argsRef.current;

  // NETOPIA unreachable even via proxy (geo-403). Stripe isn't geo-blocked,
  // so load it WITHOUT the proxy, in this same sheet.
  if (args?.stripeFallback && !triedStripeRef.current) {
    triedStripeRef.current = true;
    await WebViewProxy.clearProxyOverride().catch(() => {});
    try {
      const r = await paymentService.createRechargeIntent({
        provider: 'stripe',
        userId: args.stripeFallback.userId,
        amountUsd: args.stripeFallback.amountUsd,
        rechargeType: args.stripeFallback.rechargeType,
        returnUrl: args.returnUrlBase, // https://tricigo.com/... → EF accepts it
      });
      if (r.redirectUrl) {
        // Reload the sheet with Stripe Checkout; its https success_url hits
        // isReturnUrl → settle('returned') with the NEW (Stripe) intentId.
        argsRef.current = { ...args, url: r.redirectUrl, intentId: r.intentId };
        setActive({ url: r.redirectUrl, username: '', password: '' });
        return; // stay open
      }
    } catch { /* Stripe disabled/unavailable → fall through */ }
  }

  // Existing recovery: retry NETOPIA in the system browser.
  settledRef.current = true;
  await WebViewProxy.clearProxyOverride().catch(() => {});
  setActive(null);
  const resolve = resolverRef.current;
  resolverRef.current = null;
  let outcome: Outcome = 'closed';
  if (args) {
    try {
      const dismissUrl = `${args.returnUrlBase}?intent=${encodeURIComponent(args.intentId)}`;
      const res = await WebBrowser.openAuthSessionAsync(args.url, dismissUrl);
      outcome = res.type === 'success' ? 'returned' : 'closed';
    } catch { /* poll regardless */ }
  }
  resolve?.({ outcome, intentId: args?.intentId ?? '' });
}, []);
```

`present()` returns `Promise<PresentResult>`, resets both guards (`settledRef.current = false; triedStripeRef.current = false;`), and `fallbackToBrowser` returns `{ outcome, intentId }`.

### 2. Callers — pass `stripeFallback`, poll the *returned* intentId

```tsx
// client wallet.tsx
const { intentId: effId } = await presentNetopiaCheckout({
  url: result.redirectUrl, returnUrlBase: RETURN_URL_BASE, intentId: result.intentId,
  stripeFallback: { userId, amountUsd: usd },          // rechargeType defaults to 'customer'
});
const final = await paymentService.pollIntentStatus(effId, 20, 2000);

// driver recharge.tsx
const { intentId: effId } = await presentNetopiaCheckout({
  url: result.redirectUrl, returnUrlBase: RETURN_URL_BASE, intentId: result.intentId,
  stripeFallback: { userId: user.id, amountUsd: selectedAmount, rechargeType: 'tricicoin' },
});
const final = await paymentService.pollIntentStatus(effId, 20, 2000);
```
