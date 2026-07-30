# Driver Network Expansion — Design

**Date:** 2026-07-30
**Status:** Approved by user (question-by-question, then full design)
**Problem:** With ~6-7 drivers online (all in Havana) and low demand, roughly half of all ride
requests in the last 30 days died with **zero offers created** (39 of 79; only 3 completed).
Two root causes confirmed against prod:

1. Dispatch radius caps out at 10 km (5 km → 7.5 km → 10 km escalation) while Havana spans ~25 km
   and the only online triciclo driver can be >10 km from pickup.
2. Strict eligibility filters (3-minute heartbeat freshness, top-10 limit) shrink an already tiny
   candidate pool. ~80 approved drivers exist but only ~6-7 are ever online.

**Goal:** every ride request must reach someone — every eligible online driver gets the offer
regardless of distance, and the dormant offline network gets nudged to connect.

## User decisions (recorded verbatim intent)

| Topic | Decision |
|---|---|
| Max search radius | **No limit.** Offer reaches ALL eligible online drivers, ranked by proximity. Driver sees distance and decides. |
| Vehicle type | **Strict.** Only the requested vehicle type, ever. No cross-vehicle fallback. |
| Offline drivers | **Yes** — reactivation push to approved-but-offline drivers of the requested type, no geographic filter, with anti-spam throttle. |
| Stale-GPS online drivers | **Include in offers.** Online drivers whose heartbeat is >3 min old still receive offers (push can wake the app). |
| Passenger backgrounding tolerance | **~10 minutes** (up from 3) before an untouched searching ride is auto-canceled. |
| Offer TTL | 30s → **45s** (existing config key, admin-reversible). |
| Re-offers | **Yes, every ~2 min** (configurable). An offer a driver let EXPIRE re-arms and rings again while the ride keeps searching. Explicitly REJECTED offers are never re-offered. |

## Approach

All server-side SQL, governed by `platform_config` (Approach A). One migration modifies the four
dispatch functions and adds the reactivation piece inside the existing 1-minute retry cron.
**Zero mobile app changes → works for every installed APK the moment the migration applies.**

Rejected: EF orchestrator (adds pg_cron→HTTP blindness for no benefit), client-driven retry
(removed by ride-flow audit #18 as misleading/redundant).

## 1. Matching changes (`find_best_drivers`, `dispatch_ride`, `retry_dispatch_expired_rides`, `dispatch_searching_rides_for_driver`)

New `platform_config` keys (all read at call time, admin-tunable, `ON CONFLICT DO NOTHING`):

| Key | Default | Meaning |
|---|---|---|
| `dispatch_max_radius_m` | `0` | `0` = unlimited radius. `>0` restores a hard cap. Applies from round 1; the 5000/7500/10000 escalation ladder is retired (kept only as the parameter floor for backward compat). |
| `dispatch_offer_limit` | `0` | `0` = offer to ALL eligible drivers. `>0` caps the per-round candidate count (for when supply grows). |
| `dispatch_heartbeat_window_s` | `0` | `0` = no heartbeat freshness filter. `>0` = only drivers whose `last_heartbeat_at` is within N seconds (restores audit-R5 hardening). |
| `reoffer_cooldown_s` | `120` | Minimum seconds since an offer EXPIRED before it re-arms for the same driver (re-offer cadence). Rejected offers never re-arm. |

Mechanics:

- `dispatch_ride` keeps its `(p_ride_id, p_radius_m)` signature (trigger + cron callers pass
  values), but internally resolves the effective radius/limit/heartbeat from config.
  `dispatch_max_radius_m = 0` → skip `ST_DWithin` entirely.
- `find_best_drivers` keeps its signature; `p_radius_m <= 0` (or a sentinel) means unbounded.
  The distance component of the composite score normalizes against `GREATEST(radius, 10000)` so
  proximity still ranks nearby drivers higher; beyond the normalization scale drivers tie on
  distance and rank by rating/score. Ordering is informational only — offers go to everyone in
  parallel when the limit is 0.
- `retry_dispatch_expired_rides` drops the 7500/10000 ladder and always re-dispatches with the
  config-resolved radius. Cadence (1/min, only when no pending offers) unchanged.
- `dispatch_searching_rides_for_driver` (fires when a driver comes online): the hidden 15 km
  ride-search / 10 km dispatch caps are lifted to the same config. This closes the reactivation
  loop: push → driver opens app → goes online → immediately receives the offer.
- **Re-offers (discovered during planning, user-approved):** prod has `UNIQUE (ride_id,
  driver_profile_id)` + `ON CONFLICT DO NOTHING`, so today a driver receives at most ONE offer per
  ride ever — retry rounds only reach *new* drivers. Fix: the dispatch INSERT becomes `ON CONFLICT
  DO UPDATE` that re-arms the row (`status='pending'`, fresh `expires_at`) **only when** the
  existing offer is `'expired'` AND expired at least `reoffer_cooldown_s` ago (default 120).
  `'rejected'` (explicit decline), `'accepted'` and `'superseded'` rows are never touched. A new
  trigger `AFTER UPDATE OF status WHEN (OLD.status='expired' AND NEW.status='pending')` reuses
  `notify_driver_new_offer()` so the re-arm pushes again. Current APKs render re-armed offers via
  the 30s poll fallback (`getSearchingRides` → `addRequest`); the store honors server
  `offer_expires_at`, so the 45s TTL needs no app change. `tg_ride_offer_increment_offered` is
  INSERT-only → re-arms don't inflate the "offered" counter.
- **Unchanged:** low-rating rider gate (first round restricted), one-active-ride gate,
  vehicle-type matching, `user_blocks` exclusion, fleet restriction, pricing/parity snapshot.
- Consciously reverts the R5 heartbeat hardening **by config default** — with parallel offers a
  ghost driver blocks nobody (offer just expires), and `dispatch_heartbeat_window_s > 0` restores
  it instantly. Documented here as the audit trail.

## 2. Reactivation push to offline drivers (new)

Runs inside `retry_dispatch_expired_rides` (existing 1-min cron — no new cron, no HTTP between
cron and logic; the only HTTP is the push send itself, same pattern as offer pushes).

Trigger condition per searching ride: `created_at <= now() - reactivation_push_after_s` and still
`status='searching'`.

Recipient set: drivers with `status='approved'`, `is_online=false`, `is_financially_eligible`,
active vehicle of the **requested type** (same `service_type → vehicle_type[]` mapping as
`find_best_drivers`, incl. auto→auto+confort; mensajería → any cargo-capable), `match_score > 10`,
minus `user_blocks` (either direction) with the requesting customer, minus drivers inside their
cooldown window. **No geographic filter** (user's explicit choice — correct while the whole fleet
is in Havana; revisit when multi-province supply exists → noted as conscious debt below).

Anti-spam:

- New table `driver_reactivation_pushes (driver_profile_id uuid PK, last_pushed_at timestamptz)`
  upserted on send. Separate table (not a `driver_profiles` column) to avoid the
  `*_protect_admin_fields` trigger family entirely. RLS enabled, no policies (service-role only).
- Cooldown: 1 push per driver per `reactivation_push_cooldown_s` (default 1800 = 30 min),
  regardless of how many rides are searching.
- Kill switch: `reactivation_push_enabled` (default `true`; read tolerant of jsonb
  boolean-vs-string forms per the platform_config trap).

Delivery: one `net.http_post` to the `send-push` EF with the full `userIds` list (mirrors the
existing vault + service-role pattern of `trg_notify_driver_new_offer`), type/category
**`announcement`** — already whitelisted in the notifications type check, already mapped in the
driver inbox → zero APK rebuild. Wrapped in `BEGIN…EXCEPTION` so a push failure never breaks the
dispatch loop.

Copy (es neutro): title `🚕 Un pasajero está buscando {tipo}`, body
`Conéctate en TriciGo Conductor para tomar el viaje.` ({tipo} = triciclo / moto / auto / mensajería).
No "cerca" wording — the push is geography-free by design.

New config keys: `reactivation_push_after_s` (default `60`), `reactivation_push_cooldown_s`
(default `1800`), `reactivation_push_enabled` (default `true`).

## 3. Passenger wait window

- `searching_abandon_seconds`: INSERT the key with `600` (function `cleanup_orphan_searching_rides`
  already reads it; today the key is absent → default 180). Passenger can background the app up to
  10 min while waiting; acceptance arrives via push.
- `offer_ttl_seconds`: UPDATE `30` → `45` (existing key). More reaction time per offer round with
  scarce supply; retry cadence stretches to ~45-75s accordingly.
- Client-side search loop unchanged (it never auto-cancels; reassurance toast as-is).

## 4. Admin panel

Add the 8 new rows to `KNOWN_KEYS` in `apps/admin/src/app/settings/platform-config/page.tsx`
(the 7 brand-new keys + `searching_abandon_seconds`, whose row is also new; booleans use
`type: 'text'` per the page's existing convention) + help texts in es/en/pt `admin.json`.
`offer_ttl_seconds` already has metadata. Web deploy only.

## 5. Explicitly out of scope / unchanged

Vehicle-type fallback (rejected by user), pricing and fare parity, acceptance flow, driver offer
card UI, rider search UI, `expire-ride-offers` / `cleanup_orphan_searching_rides` crons
(mechanics unchanged — only the config value moves), scheduled rides, delivery (cargo) specifics
beyond inheriting the same radius/limit config.

## 6. Risks accepted

| Risk | Mitigation |
|---|---|
| Driver accepts a far pickup, passenger waits long | Offer card shows distance; passenger sees assigned-driver ETA and can cancel free within the 120s grace window. |
| Nationwide reactivation push becomes spam when fleet grows beyond Havana | Conscious debt: add a distance filter then. Cooldown (30 min) + kill switch exist today. |
| Ghost searching ride (passenger truly gone) lives up to 10 min and a driver accepts it | Driver cancel with `no_show` reason is penalty-free; symmetric rating system covers abuse. |
| Ghost driver (stale GPS) receives offers they never see | Costs nothing — offers are parallel; the offer expires alone. Config can restore the heartbeat filter. |

## 7. Verification plan

All prod checks run inside `BEGIN; … ROLLBACK;` — `net.http_post` only enqueues into the
transactional `net.http_request_queue`, so a rollback cancels every push (pattern verified in the
FX-watchdog work). **Zero real drivers get pinged during verification.**

1. Rolled-back INSERT of a searching ride at Havana coords → the insert trigger runs the new
   dispatch synchronously → assert `offers_created` = ALL eligible online drivers of the type,
   including the stale-heartbeat one and drivers >10 km away.
2. Rolled-back reactivation: INSERT a searching ride with `created_at = now() - 2 min`, call the
   reactivation function directly → assert rows in `driver_reactivation_pushes` + queued push
   with `user_ids`; call again → assert cooldown blocks a second push.
3. Rolled-back re-offer: expire the seeded offers, backdate `expires_at` past the cooldown,
   re-dispatch → assert the same drivers' offers re-armed to `pending` (and `rejected` ones
   stayed untouched).
4. `cleanup_orphan_searching_rides` reads the new 600s value (direct call assertion).
5. `pnpm check-types` green (admin change).

## Conscious-debt register

- Reactivation push has no geographic filter — add `reactivation_push_radius_m` when supply exists
  outside Havana.
- The 5000/7500/10000 radius ladder constants remain as dead parameters for caller compat; remove
  in a later cleanup once config-driven dispatch has soaked.
