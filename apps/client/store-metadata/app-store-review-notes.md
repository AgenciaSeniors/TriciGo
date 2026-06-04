# App Store Review Notes — TriciGo (Pasajero)

> Pegar el contenido de la sección **"Notes for Reviewer"** en App Store Connect → My Apps → TriciGo → App Information → App Review Information → Notes.

---

## Demo credentials

```
Login type: SMS OTP (phone number)
Phone: +5355550100
OTP code: 000000
(Demo number — no real SMS is sent. Enter the fixed code above directly.)

Alternative:
Email: reviewer-rider@tricigo.com
Password: <fill in before submit>
```

The reviewer account has a pre-funded wallet ($50 demo balance) and one
historical completed ride so the full app surface is exercisable without
real driver availability.

---

## Notes for Reviewer

### Wallet recharge — Apple Guideline 3.1.1 defense

The in-app trip credit balance (visible at bottom tab "Créditos de viaje") accepts top-ups via
**NETOPIA Payments** (a Romanian payment processor) opened in a hosted
checkout page via `WebBrowser.openAuthSessionAsync`. **This is intentionally
not StoreKit / In-App Purchase**, and we believe it falls outside Apple's
IAP requirement based on the published precedents for ride-sharing
wallets (Uber Cash, Starbucks, Lyft Cash):

1. **Wallet credit is redeemable only for physical transportation
   services.** The credit pays for rides between physical locations
   delivered by independent drivers in the real world. There is no
   digital content, no in-app feature unlock, no premium tier, no
   game currency, and no virtual goods of any kind tied to the wallet
   balance.

2. **Explicit in-app disclaimer.** Before the user submits a recharge,
   the recharge sheet shows the text: *"El saldo se canjea exclusivamente
   por viajes físicos. No desbloquea contenido digital ni funciones
   premium dentro de la app."* (English: "Balance is redeemable only for
   physical transportation services. It does not unlock digital content
   or premium features inside the app.")

3. **Closed-loop and no cash-out.** TriciCoin credit is closed-loop: it
   is redeemable only for TriciGo rides. It can be optionally gifted to
   another active TriciGo user (spend-only — see "Regalo" below), but it
   cannot be cashed out, withdrawn to a bank/card, or sent outside the
   platform. On account closure, any unused balance may be refunded to the
   original payment method in line with consumer-protection rules.

4. **Reference apps with the same model:** Uber, Lyft, DoorDash,
   Postmates — all use third-party payment processors for physical
   service top-ups without StoreKit.

If the reviewer needs to test the recharge flow, the NETOPIA POS account
is in sandbox mode; the test card published by NETOPIA in their dev
docs (`9900 0000 0000 5159` exp `01/26` cvc `123`) succeeds without a
real charge. The hosted page returns to the app via Universal Link
`https://tricigo.com/app/client/wallet` after the user confirms or
cancels. Sandbox is fully OFAC-safe; we evaluated Stripe and rejected
it because Stripe terms prohibit servicing Cuba directly.

### Regalo (peer-to-peer gift) — Guideline 3.1.5

The app lets a user optionally send part of their TriciCoin balance to
another **active TriciGo user** as a "Regalo" (gift), looked up by a
share-code/QR or phone number (`send_gift` RPC, atomic double-entry). We
believe this fits Guideline 3.1.5(b):

1. **Completely optional** — no ride, feature, or content is gated behind
   sending or receiving a gift.
2. **100% goes to the receiver** — the full amount is credited to the
   recipient's balance; TriciGo takes no cut on the transfer.
3. **Not tied to digital content/services** — the gifted balance is
   redeemable only for **physical transportation** (real-world rides),
   exactly like the rest of the wallet, so the "gift tied to digital goods
   must use IAP" carve-out does not apply.
4. **Closed-loop, no cash-out** — the recipient must be an existing active
   TriciGo user; the gift cannot be sent to a bank/card/external account
   and cannot be withdrawn to cash. It can only be spent on rides.
5. **Abuse controls** — recipient lookup is server-side rate-limited
   (anti-enumeration); frozen wallets cannot send; admins can reverse a
   gift and freeze abusive wallets.

### App Tracking Transparency (ATT)

TriciGo does **not** implement an ATT prompt (no
`AppTrackingTransparency` framework, no `NSUserTrackingUsageDescription`
in `Info.plist`) because the app does **not** track the user across
other companies' apps or websites:

- PostHog analytics runs with `autocapture: false` and is used only
  for first-party product metrics on TriciGo's own surfaces.
- Sentry is configured with `sendDefaultPii: false` and the
  `beforeSend` hook strips authorization headers and any payload
  fields that could carry PII before transmission.
- No advertising SDK (AdMob, Meta Ads, AppsFlyer, Branch, etc.) is
  integrated. No third-party SDK reads or shares the IDFA.
- `apps/client/PrivacyInfo.xcprivacy` declares `NSPrivacyTracking
  = false` and an empty `NSPrivacyTrackingDomains`, matching the
  runtime behavior.

Per Apple's ATT policy, the prompt is required only when an app
tracks; since we don't, surfacing the prompt would actually be
misleading to the user.

### Sign in with Apple

Available on the login screen as required when other social sign-in
methods (Google) are present. Implemented via Supabase OAuth.

### Account deletion

Settings → Eliminar cuenta. Calls the `delete-account` Supabase Edge
Function (authenticated with the user's JWT — user_id is derived
server-side, not from a request body) which performs an **immediate,
irreversible hard-delete**:

1. `anonymize_user_references(user_id)` Postgres function re-points
   every non-CASCADE foreign key (rides, ratings, referrals, chat
   messages, ledger entries, etc.) from the user to a well-known
   anonymous user (UUID `00000000-…-099`, role `customer`,
   `is_active=false`). This preserves the financial / AML audit
   trail without violating FK constraints during the next step.
2. Best-effort cleanup of the user's avatar from the `avatars`
   storage bucket.
3. `auth.admin.deleteUser(user_id)` deletes the `auth.users` row,
   which CASCADEs to `public.users` and the CASCADE-flagged
   children: `wallet_accounts`, `trusted_contacts`, `notifications`,
   `recurring_rides`, `driver_profiles`. The phone and email are
   freed immediately and can be used to register a brand-new
   account.

There is **no grace period** — deletion is immediate. Users who
prefer to deactivate temporarily can simply sign out and not log
back in; we never auto-delete inactive accounts.

Public URL for users who have already uninstalled the app:
`https://tricigo.com/account/delete`.

### Background location

The passenger app **does not use background location**. Foreground only,
and only during ride request/active ride.

### Data collection — see Privacy Manifest

`PrivacyInfo.xcprivacy` is bundled at the root of the .app. It declares
all data collection and Required Reason API usage. App Privacy details
in App Store Connect mirror it exactly.

### Internationalization

Primary language: Spanish (Latin America). English UI strings are also
present for travelers using the app abroad.

### Known reviewer notes

- The recharge flow opens a NETOPIA hosted checkout page in an
  in-app browser (`WebBrowser.openAuthSessionAsync`). If the
  NETOPIA POS sandbox is unreachable from the review device, the
  recharge button surfaces a toast with the network error; rides
  using cash payment continue to work normally.
- The "Próximamente" sections in some menus are intentionally
  disabled features awaiting a future release.

---

## Contact

- App support email: soporte@tricigo.com
- Developer contact: edua56621636@gmail.com (technical)
