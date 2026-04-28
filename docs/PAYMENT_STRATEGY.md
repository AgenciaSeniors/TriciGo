# Payment Strategy — TriciGo

Updated 2026-04-26.

## Current Production Stack

- **Stripe** (international card payments)
- **TriciCoin (TRC)** (in-app credit, 1:1 with CUP)
- **Cash** (efectivo en mano al conductor)

## ❌ NOT used (was previously documented)

- ~~TropiPay~~ (Cuba-specific gateway) — **removed**. References in older docs (`AUDITORIA_BUGS.md`, `PRODUCTION_READINESS.md`, etc.) are stale and should be ignored.

## Payment Methods Per User Type

### Customer (rider)
- Cash (most common for now)
- TriciCoin balance (loaded via Stripe topup)
- Stripe direct (card on file)
- Mixed (TriciCoin + cash split via `wallet_ratio`)

### Driver (operator)
- Receives net earnings (fare − 15% commission) into:
  - `driver_cash` wallet (CUP) — for cash rides
  - `tricicoin` balance (TRC) — for TriciCoin/Stripe rides
- Commission deducted from `tricicoin` balance always (driver must keep balance > 0 to accept new rides)

## Stripe Integration

- **Webhook**: backend Edge Function processes Stripe events
- **3D Secure**: handled by Stripe SDK
- **Refunds**: via admin panel
- **Topups**: minimum $20 USD per recharge (migration `00132_stripe_min_recharge_20usd.sql`)

## Code paths to clean up

When refactoring, replace any remaining references to `tropipay` payment method with a clear strategy:

```sql
-- DB rides.payment_method enum currently includes 'tropipay'
-- Decision: keep enum value for backwards compat with old rides,
-- but remove from new ride creation paths in client/driver apps.
```

The backend `complete_ride_and_pay` still has a `payment_method = 'tropipay'` branch (no-op). Safe to leave for legacy rides, do not remove from enum.

## Mobile UI

- Cliente home → métodos de pago disponibles (Cash, TriciCoin, Stripe-card)
- Driver wallet → muestra saldo TriciCoin para verificar elegibilidad de aceptar rides
