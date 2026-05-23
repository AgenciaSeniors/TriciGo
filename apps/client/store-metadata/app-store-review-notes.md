# App Store Review Notes — TriciGo (Pasajero)

> Pegar el contenido de la sección **"Notes for Reviewer"** en App Store Connect → My Apps → TriciGo → App Information → App Review Information → Notes.

---

## Demo credentials

```
Login type: SMS OTP (phone number)
Phone: +1 415 555 0100
OTP code: 000000  (test override active in DEV/Apple Review accounts)

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
Stripe Payment Sheet. **This is intentionally not StoreKit / In-App
Purchase**, and we believe it falls outside Apple's IAP requirement based
on the published precedents for ride-sharing wallets (Uber Cash,
Starbucks, Lyft Cash):

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

3. **Closed-loop and refundable.** TriciCoin credit is closed-loop: it
   is redeemable only for TriciGo rides and is not transferable between
   users. On account closure, any unused balance may be refunded to the
   original payment method in line with consumer-protection rules.

4. **Reference apps with the same model:** Uber, Lyft, DoorDash,
   Postmates — all use third-party payment processors for physical
   service top-ups without StoreKit.

If the reviewer needs to test the recharge flow, the publishable Stripe
key is in test mode; any test card (e.g. `4242 4242 4242 4242` exp
`12/30` cvc `123`) will succeed without a real charge.

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

- The recharge flow may show a "stripe_not_ready" banner if the Stripe
  publishable key has not been provisioned for the review account. If
  this happens, the button label changes to "Abrir versión web" and
  opens a web fallback — both flows redeem to the same wallet.
- The "Próximamente" sections in some menus are intentionally disabled
  features awaiting a future release.

---

## Contact

- App support email: soporte@tricigo.com
- Developer contact: edua56621636@gmail.com (technical)
