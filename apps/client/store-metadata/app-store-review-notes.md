# App Store Review Notes — TriciGo (Pasajero)

> Pegar el contenido de la sección **"Notes for Reviewer"** en App Store Connect → My Apps → TriciGo → App Information → App Review Information → Notes.

---

## Demo credentials

```
Login type: SMS OTP (phone number)
Phone: +1 415 555 0100
OTP code: 000000  (test override active in DEV/Apple Review accounts)

Alternative:
Email: reviewer-rider@tricigo.app
Password: <fill in before submit>
```

The reviewer account has a pre-funded wallet ($50 demo balance) and one
historical completed ride so the full app surface is exercisable without
real driver availability.

---

## Notes for Reviewer

### Wallet recharge — Apple Guideline 3.1.1 defense

The in-app wallet (visible at bottom tab "Billetera") accepts top-ups via
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

3. **Refundable**. Users may transfer remaining balance to other
   verified users (peer-to-peer, no commission), or contact support to
   request a refund of unused balance to the original payment method.

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

Settings → Eliminar cuenta. Calls a server endpoint that hard-deletes
the user record + cascade-deletes related data after a 30-day grace
period (per privacy policy).

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

- App support email: soporte@tricigo.app
- Developer contact: edua56621636@gmail.com (technical)
