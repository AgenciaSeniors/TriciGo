# Partner Places — Fare Discount

**Date:** 2026-08-09 · **Status:** in production · **Migrations:** 00558–00564

Replaces the counter-coupon model of
[2026-07-31](./2026-07-31-partner-places-discounts-design.md), which shipped and
was reversed nine days later.

---

## What it is

An admin registers a business with coordinates, a radius and a **discount
percentage**. A ride that **ends** inside that radius costs the passenger that
much less, and they see the reduced price **before confirming**.

TriciGo absorbs the discount out of its own commission. The driver is paid on
the full fare. There is no coupon, no code, no counter, and the business is not
in the loop at all.

Eligibility is by proximity of the **dropoff**, not by how the passenger picked
the destination — searching the address by hand works exactly like tapping the
carousel. Most people will never use the carousel.

## The money, and the invariant

With fare `F`, commission `c` and place discount `d`:

| | |
|---|---|
| Passenger pays | `F(1−d)` |
| Commission collected to `platform_revenue` | `F(1−d)·c` |
| Driver receives, after subsidy | `F(1−c)` |
| Subsidy paid from `platform_promotions` | `F(1−c)·d` |
| **Platform net** | **`F(c−d)`** |

`F(c−d) ≥ 0` **if and only if `d ≤ c`.**

**The cap at the ride's effective commission is not cosmetic — it is the whole
thing holding this up.** Without it a place set to 50% would have the platform
paying out of its own pocket. The cap follows the *effective* rate, so a
corporate ride caps lower on its own.

Measured against production (F = 2000, c = 15%, d = 10%):

```
passenger pays        1800   = F(1-d)
subsidy to driver      170   = F(1-c)d
subsidy ledger sum       0   balanced double entry
platform revenue      +270
platform promotions   -170
platform net          +100   = F(c-d)
```

The driver's wallet moves −100 while collecting 1800 in cash → **1700 net**,
identical to the same ride with no discount at all.

Bookkeeping note: the net is right but split across two accounts —
`platform_revenue` takes the full commission and `platform_promotions` pays the
subsidy, so viewed alone the latter goes negative. That is what promos already
did.

## Rules

- **Capped at the ride's effective commission.** Setting a place above it costs
  nothing extra: the cap simply applies.
- **Promo and partner do not stack — the larger wins.** The loser contributes 0,
  so 00481's subsidy cannot count the same discount twice.
- **Shared-ride discount stacks on top.** It is a different thing: the passenger
  gives up seats and the driver earns the cash from extra passengers, so no
  subsidy is involved.
- **Passenger rides only** (00564). In a delivery the person collecting the
  parcel is the one in the shop and the one who saves is someone else.
- **No frequency limit per passenger.** Exposure is already capped per ride.
- **Overlapping radii: nearest wins**, never summed.

## Where it lives

| Piece | Where |
|---|---|
| The charged amount | `tg_rides_validate_promo_discount` — writes `rides.partner_discount_cup` and folds it into `discount_amount_cup` |
| Driver made whole | `complete_ride_and_pay`, subsidy from 00481 |
| The shown amount | `get_partner_discount_for_dropoff` — **display only** |
| Discovery | `get_nearby_partner_places` |
| Admin | `admin_list_partner_places`, `admin_upsert_partner_place`, `/admin/partners` |

The client **never sends** the discount. The trigger derives it from
`dropoff_location`, so there is nothing to forge — a client supplying
`discount_amount_cup: 9999` gets it recomputed.

## Traps worth knowing

**00481's subsidy was gated on `promo_code_id IS NOT NULL`.** A partner discount
has no promo, so without 00560 the subsidy never fires and **the driver eats the
discount** — the exact opposite of the model. That gate is the only line of
`complete_ride_and_pay` this feature touches.

**`partner_places` has per-column SELECT grants, not a table grant** (that is how
`validation_token` stayed unreadable in the coupon era). **A new column without
an explicit grant is invisible to clients.**

**`get_nearby_partner_places` still returns `benefit_title`,
`benefit_description` and `has_active_coupon`** (00563). They are computed from
the percentage and exist only so the pre-00558 bundle does not crash: its
carousel does `p.benefit_title.toUpperCase()` unguarded, and the client's
`ErrorBoundary` wraps the whole app, so it would show the app down rather than a
broken card. **Remove them when that bundle is gone from the fleet — not
before.** Publishing an OTA is not enough: the client runs
`fallbackToCacheTimeout: 0`, so an update applies on the *next* launch.

**Storage does not validate this project's ES256 JWTs.** Photo uploads go
through the `storage-upload` Edge Function with service-role; the
`partner-photos` branch is gated on `isAdmin()` because a place belongs to the
platform, not to a user. Any new upload must go the same way.

**The display RPC takes `p_ride_mode` with a default** so a deployed client
calling with three arguments keeps working. What is shown must always equal what
is charged; that is why the delivery exclusion lives on both sides.

## Verifying a change here

This trigger governs promos and shared rides, both live. Any change to it gets
measured **against the current trigger and then against the new one in the same
rolled-back transaction**, and the six control scenarios must come out
identical: promo, shared, promo+shared, fixed promo, nothing, expired promo.
Transcribe from `pg_get_functiondef` — the live body, never the migration file —
and prefer an in-place patch for small edits, which cannot lose features.
