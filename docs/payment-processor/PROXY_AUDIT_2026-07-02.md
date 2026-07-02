# NETOPIA payment-proxy audit — 2026-07-02

Audit of the VPS proxy that lets Cuban users pay with card through NETOPIA, plus
the recharge-UX remediation shipped alongside it. Companion to
[`PAYMENT_PROVIDER_CONTRACT.md`](./PAYMENT_PROVIDER_CONTRACT.md) and the VPS
runbook in [`ops/squid/README.md`](../../ops/squid/README.md).

## Why the proxy exists

NETOPIA serves its hosted card page behind Google Cloud Armor, which returns
**HTTP 403** to reputation-flagged IPs — including ETECSA (Cuba). To let a Cuban
pay, TriciGo routes through the Hostinger VPS `187.77.214.236` (clean IP) in two
layers:

1. **`nginx /np-proxy/`** — the server→API calls of NETOPIA
   (`create-netopia-payment-intent`, the re-query in `process-netopia-webhook`)
   go here → `secure.mobilpay.ro/pay/`, guarded by an `x-proxy-secret` header.
2. **`squid` CONNECT :13128** — the in-app checkout WebView (`NetopiaCheckout`)
   tunnels the hosted card page + 3-D Secure through here, so NETOPIA's edge sees
   the VPS IP. **TLS passthrough, no SSL-bump → the VPS never sees the card →
   PCI SAQ-A.** Auth = ephemeral HMAC tokens (TTL 10 min) minted by the
   `mint-netopia-proxy-credential` EF (the squid `hmac_auth.sh` validates them
   statelessly). **Never add `ssl_bump`.**

## State at audit time (2026-07-02)

- Prod config: `netopia_enabled=true`, `netopia_environment=live`,
  `netopia_proxy_enabled=true`, `active_payment_provider=netopia`,
  `stripe_enabled=false`.
- Real recharge volume ≈ 0: the only recent intents are Eduardo's own test
  traffic (Brazil `okhttp` device, Windows browser, the VPS IP itself); every
  post-launch attempt `expired`/abandoned. The app just launched and Cuban card
  penetration is low → this was the right moment to harden **before** volume.
- 3-D Secure was validated E2E through the tunnel on 2026-06-27.

## Findings

| # | Sev | Finding |
|---|-----|---------|
| A | HIGH | **Single point of failure, no monitoring.** VPS/squid/nginx down → all Cuban in-app checkouts fall back to the browser → 403. No health-check, uptime monitor, or alert. First symptom would be a user who can't recharge. |
| B | HIGH | **The in-app fallback is a dead-end for the target user.** On proxy failure (squid down, unanswered 407, TLS, iOS<17) `present()` falls back to `WebBrowser.openAuthSessionAsync(<same NETOPIA url>)`, which 403s from a flagged IP. Real fix = Stripe fallback (designed, blocked on Stripe KYC). **Decision (2026-07-02): left as-is, tracked as debt.** |
| C | MED-HIGH | **No resume-poll recovery.** After returning from payment the app polls the intent ~40s; if the user leaves during "Verificando…", the completing webhook is never reflected in-session (only the push covers it). |
| D | MED | **Poll window (40s) too short for 3-D Secure** OTP-by-SMS on a slow link → ambiguous "pending" with no in-app resolution. |
| E | MED | **Authenticated open CONNECT proxy.** Any logged-in user can mint a token (10/min) and tunnel arbitrary `:443` (squid can't dst-restrict — 3-D Secure ACS domains are unpredictable). No bandwidth/concurrency cap, no fail2ban, no destination visibility. |
| F | LOW-MED | **Static htpasswd cred still live** in `hmac_auth.sh` (curl/dev only; app doesn't send it) — a standing credential on a money-path proxy. |
| G | LOW-MED | **Drift risk:** `NetopiaCheckout.tsx` + `webview-proxy` are byte-duplicated per app with manual sync, no test. |
| H | LOW | Error card doesn't distinguish proxy-down vs offline vs decline; `NETOPIA_ERROR_MAP` had 5 entries; double-submit possible; iOS<17 gap. |

**Sound already:** 2-stage prepare overlay + parallel `prewarm`; DB-as-source-of-truth
polling; idempotent atomic webhook claim (WPS-01) tolerating `failed`/`expired`;
authoritative server-to-server re-query; TLS passthrough / `cache deny all` / CONNECT-only-:443.

## Remediation shipped (2026-07-02)

### Track 1 — Observability + alerts (VPS + Supabase)
- **Log retention** 2→30 days (`ops/squid/logrotate-squid`).
- **Watchdog** (`ops/squid/healthcheck.sh`, systemd timer every 5 min): probes the
  squid tunnel (local ephemeral token) + `/np-proxy/`, reports to the
  `proxy-health` EF, and auto-restarts the failing service after ~10 min down.
- **Auto-recovery**: `Restart=always` drop-ins for squid + nginx (covers Track 4a).
- **`proxy-health` EF** (`supabase/functions/proxy-health/`): records state in
  `platform_config.netopia_proxy_health*` and emails the business address (Resend)
  ONLY on a state transition (de-duped). Also serves the synthetic probe.
- **Edge-side synthetic probe**: pg_cron every 5 min (migration `00475`) hits
  `proxy-health?probe=1` — alerts even if the whole VPS is down.

### Track 2 — Recharge UX (client + driver, needs rebuild)
- **Resume-poll recovery** (C): persist the pending `intentId`
  (`apps/<app>/src/lib/pendingRecharge.ts`); re-check on focus + `AppState`
  'active' and surface the settled result.
- **Poll window** (D): 20×2s → 30×2s (~60s) at all callers.
- **Error differentiation** (H): `NetopiaCheckout` classifies offline vs
  "couldn't reach payment" for the error card.
- **Error map** (H): +8 entries in `netopia-errors.ts` and its EF mirror
  (incl. `Invalid card number`, seen in prod as provider_error_code 17).
- **Drift guard** (G): `scripts/check-netopia-checkout-sync.mjs`
  (`pnpm check:netopia-sync`) asserts the client/driver copies are byte-identical.
- **Not touched:** the browser fallback path (finding B) — by decision.

### Track 3 — squid hardening (VPS)
- **Abuse limits** in `ops/squid/squid.conf`: `maxconn 25`/IP, `connect_timeout`,
  `client_lifetime`, header hygiene (a bandwidth `delay_pool` is provided but OFF
  by default to never throttle a real 3-D Secure page).
- **fail2ban** on repeated 407/403 (`ops/squid/fail2ban/`).
- **Destination anomaly digest** (`ops/squid/anomaly-alert.sh`) — log-only
  visibility of non-payment CONNECT destinations (can't block; ACS is unpredictable).
- **Static cred rotation** (F) — runbook step in `ops/squid/README.md`.

### Track 4b — Redundancy (design + dormant app code)
- `platform_config.netopia_proxy_host_fallback`/`_port_fallback` (migration `00475`,
  empty by default). `getNetopiaProxyConfig` exposes them; `NetopiaCheckout` retries
  ONCE through the fallback proxy before the (unchanged) browser fallback. **Dormant
  until a 2nd CONNECT proxy is provisioned with the SAME `hmac_secret`** (so the
  ephemeral token authenticates to both).

## Operational runbook

VPS apply steps (log retention, hardened `squid.conf`, watchdog + systemd,
fail2ban, `proxy-health` EF + secret + cron, static-cred rotation) are in
[`ops/squid/README.md`](../../ops/squid/README.md). Health at a glance:

```sql
SELECT key, value, updated_at FROM platform_config
WHERE key LIKE 'netopia_proxy_health%';   -- 'ok' | 'down' | 'unknown'
```

## Known debt

- **B — browser fallback 403s the Cuban user.** Real fix is the in-app Stripe
  fallback (designed in `docs/superpowers/specs/2026-06-27-netopia-stripe-fallback-design.md`),
  blocked on Stripe KYC. Until then a proxy failure has no working in-app recovery
  for a flagged IP.
- **iOS < 17** has no WebView proxy → browser → 403 in Cuba (small coverage).
- **Track 4b needs a 2nd proxy box** provisioned before the failover is live.
- **A second alert channel** (push/Telegram) would harden the email-only alert.
