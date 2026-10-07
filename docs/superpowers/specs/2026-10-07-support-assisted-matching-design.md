# Support-assisted matching — design

Date: 2026-10-07 · Status: approved in chat; revised the same day while writing the plan (e-mail alerts, Havana-time pricing, the driver app pickup) · Target: client and driver 1.7.4, admin, web · Plan: `docs/superpowers/plans/2026-10-07-support-assisted-matching.md`

## Why

The marketing agency (Baco) promises riders that when the app can't find a driver, TriciGo support helps them get one. Nothing supports that today:

- Over the last 60 days (test accounts excluded), 73 rides were requested and 10 got a driver. 38 were offered to drivers and nobody accepted (median cancellation after 203 s). 25 were never offered to anyone (median cancellation after 130 s). 51 of the 63 failures happened between 07:00 and 20:00 Havana time.
- Support therefore has roughly two to three minutes before the rider gives up.
- The admin can list and map searching rides, but it can only cancel them. Nothing alerts anyone that a ride has been waiting.
- The rider's searching screen has only a Cancel button. There is no way to ask for help.
- A driver only sees a ride that has a `ride_offers` row for them (RLS `r_select_driver`, and `accept_ride_v2` requires a pending, unexpired offer). Support therefore cannot route a ride to a chosen driver.

## Decisions taken with the founder

1. The ride stays inside the app. Commission, tracking, SOS and ratings work as usual.
2. Support finds out in two ways: an automatic alert, and a "Pedir ayuda" button the rider taps.
3. The alert shows in the admin panel, arrives as a push on the support staff's phones, and is also sent by e-mail.
4. Support may switch the ride to another vehicle type, with a recomputed price.
5. The rider consents to a type and price change either in the app (a card with Accept/Reject) or over WhatsApp, in which case support applies the change and records why.
6. Support chooses, case by case, between sending the ride as an offer the driver accepts and assigning it directly.
7. It ships in client 1.7.4. The driver app needs a small change too (see "Driver app"), so it ships in driver 1.7.4.

## User-facing behavior

### Rider (client app 1.7.4 and web)

- **Pedir ayuda.** From 45 s of searching (the `extended` stage of `searchWaitStage`, `packages/utils/src/searchWait.ts`), the searching screen shows "¿No aparece conductor? Pide ayuda". Tapping it:
  1. calls `request_ride_help(ride_id)`, which marks the ride and alerts support at once;
  2. opens `https://wa.me/5356621636?text=…` with "Hola, necesito ayuda para conseguir conductor. Viaje: <CODE>", where `<CODE>` is the first 8 characters of the ride id, upper case.

  The search keeps running, also while the rider is in WhatsApp: the cleanup that cancels a search the app stopped refreshing leaves the ride alone for `support_help_keepalive_s` (30 min) after the help request. If the RPC is missing or fails, WhatsApp still opens.
- **Proposal card.** While a pending proposal exists, the searching screen shows "Soporte encontró una <tipo> · <precio nuevo> (antes: <tipo>, <precio>)" with **Aceptar** and **Rechazar**. A proposal expires after `support_proposal_ttl_s` (180 s). Accepting switches the ride's type and price and searching continues. Rejecting it, or letting it expire, changes nothing. If the ride was shared (triciclo only) and the new type is not triciclo, the card shows the price without the shared-ride discount. The card does not show the insurance premium: `tg_rides_validate_insurance` recomputes it on the new fare and it is charged on top (0 of 185 rides in the last 90 days had insurance, measured 2026-10-07).
- **Older apps (≤ 1.7.3)** see neither the button nor the card, so their proposals simply expire. Support can still apply a change with WhatsApp consent, and same-type offers and direct assignment work for every app version, because they act on the driver's side.

### Support (admin panel)

- **Alert banner.** It is mounted in the admin shell, so it appears on every page (today `SosAlertBanner` and `StuckRideBanner` only appear on the dashboard). It lists rides that have been searching for more than `support_alert_after_s` (60 s) or whose rider asked for help: rides that asked for help first, in red, then the rest oldest first. Each row shows elapsed time, origin → destination, type and price, and links to the assist page. Rides of test accounts (`users.is_test`) are listed too, marked "Prueba", so the end-to-end check can be done with a test account. A sound plays when a new ride enters the list. Browsers block audio until the user interacts with the page, so the banner asks for one click to enable sound.
- **Push and e-mail.** For each ride, every active `admin` and `super_admin` gets a push and every address in `support_alert_email` gets an e-mail: once when the ride crosses 60 s, and once more when the rider taps Pedir ayuda. The automatic 60 s alert skips test accounts, and `support_alert_enabled = false` turns it off; a help request always alerts.
  - The push category is `system`, which is always delivered and already whitelisted. `send-push` overwrites `data.type` with the category, so the payload says what happened in `data.event` (`support_wait`, `support_help`). Each person on support must install the TriciGo app, sign in with their admin account and allow notifications; today only 1 of the 5 admins has a push token.
  - The e-mail goes through `send-email` with raw HTML (the 00538 pattern) and links to the assist page. Every value the rider typed (addresses, name) is HTML-escaped. `support_alert_email` starts as a copy of `business_notification_email`; leaving it empty turns the e-mail off.
  - Both go through `cron_http_post` (labels `support-help-alert`, `support-help-email`, `support-wait-alert`, `support-wait-email`). The cron watchdog (`check_cron_http_failures`, 00509) only reports a label whose calls failed at the HTTP level twice or more within 90 minutes, so a single failed alert goes unreported. A failure before the HTTP call (no service role key, an error while building the e-mail) only leaves a WARNING in the Postgres logs, and an error in the e-mail does not take back the push.
- **Assist page `/rides/[id]/assist`.** It opens from the banner or from the ride detail page and shows:
  - Ride facts: origin, destination, type, price, wait time, whether help was requested, the rider's phone with a WhatsApp link, the current offer (which driver, expiry) and the current proposal (status, expiry).
  - **Candidates**, from `admin_ride_assist_candidates`: drivers of the ride's type, with a filter for other types, sorted online-first and then by distance to pickup. Each row shows name, phone with WhatsApp and call links, online state, last heartbeat, distance, whether they are on another ride, and whether their balance covers the commission. Approved drivers who are offline but had a heartbeat in the last 7 days are listed below, so support can ask them to connect. Drivers blocked by the rider, or who blocked the rider, are left out, as `dispatch_ride` does. The "covers the commission" flag uses the ride's current fare, even when the list is filtered by another type; "Asignar directo" checks it again with the fare at that moment.
  - Two actions per driver:
    - **Enviar oferta**: an offer with a `support_offer_ttl_s` (120 s) TTL. The driver gets the usual push and card. If the driver already holds a live offer for this ride, it is extended to the support TTL without a second push. While it is live, automatic re-dispatch waits: `retry_dispatch_expired_rides` skips a ride with a live pending offer, so a support offer holds it for up to `support_offer_ttl_s`.
    - **Asignar directo**: asks for a reason, then assigns at once if every check passes.
  - **Cambiar tipo**: pick a type. The price is computed in the admin with `rideService.getLocalFareEstimate`, the code the rider app uses: it takes the ride's pickup and dropoff, fetches the route again, and applies the time band and the weather surge. Two inputs change for support:
    - the time band is read in `America/Havana` (the admin can be opened anywhere; the rider app reads the phone's clock, which in Cuba is Havana time);
    - a pricing experiment, if one is ever active, uses the rider's variant (`for_user_id`), not the admin's, and support's quote is not counted as an experiment ride.

    The admin build has no Mapbox token, so its route comes from the public OSRM server while the rider app uses Mapbox; the distance can differ by a few percent. The rider consents to the exact price shown, and that price is what is charged.

    Then **Proponer al pasajero**, or **Aplicar (conformidad por WhatsApp)**, which requires a reason. The type can only change on a passenger ride without stops that is not corporate, to a type that fits the ride's passengers, at a price between the type's minimum fare and five times the larger of the current fare and the new type's minimum. In the last 90 days no ride had stops or was corporate, and 3 were deliveries.
- Admins and super admins can use all of it.

## Server design (one migration)

Migration `00628` (the next free number on 2026-10-07 after #1095 took `00627`, checked against master and every open PR; re-check right before writing it). The RPCs are `SECURITY DEFINER` with `SET search_path = public, pg_catalog` (plus `extensions` where they reach the snapshot code). EXECUTE is revoked from `PUBLIC`, `anon` and `authenticated` on every function and granted back to `authenticated` only for the RPCs the table marks as called by the rider or an admin; the migration asserts it.

Besides its own functions, the migration changes three existing ones, each only if its live body has the md5 the migration was written for (it refuses otherwise): `tg_rides_create_estimate_snapshot` (its body moves into `_write_ride_estimate_snapshot`, step 2 below), `tg_rides_validate_promo_discount` (a one-line patch, step 3 below) and `cleanup_orphan_searching_rides` (one more condition, in the table). The two patches are made in place from the live body and leave the rest of it as it was.

| Function | Caller | What it does |
|---|---|---|
| `request_ride_help(ride_id)` | rider (`auth.uid() = customer_id`) | Ride must be `searching`. Sets `help_requested_at` (idempotent) and, the first time only, sends the help alert (push and e-mail, see above) and stamps `help_alert_sent_at`. Returns the short code. |
| `admin_support_waiting_rides()` | admin | Feeds the banner: searching rides older than the threshold or with help requested, help first, then oldest first. Each row carries `is_test`. |
| `admin_ride_assist_context(ride_id)` | admin | Everything the assist page shows about the ride in one call: the ride (with `pickup_lat`/`pickup_lng`/`dropoff_lat`/`dropoff_lng`, which `rides_sync_coords` keeps), the rider's name and phone, `help_requested_at`, every offer with its driver and status, and the latest proposal. |
| `admin_ride_assist_candidates(ride_id, service_type default ride's)` | admin | The candidate list described above. Commission affordability calls `driver_can_afford_commission`. |
| `admin_offer_ride_to_driver(ride_id, driver_profile_id)` | admin | Locks the ride `FOR UPDATE`. The ride must be `searching`; the driver must be `approved`, have an active vehicle that can serve the ride (the `find_best_drivers` type mapping, plus `accepts_cargo` for deliveries) and not be blocked with the rider. With no offer row it inserts one (`trg_notify_driver_new_offer` pushes it). A live pending offer gets the support TTL and no second push. Any other row is re-armed through `expired → pending`, so `trg_notify_driver_reoffer` pushes it. Logs to `admin_actions`. Online state, free state and balance are left to `accept_ride_v2` when the driver accepts. |
| `admin_assign_ride_to_driver(ride_id, driver_profile_id, reason)` | admin | Reason is required. Mirrors the checks in `accept_ride_v2` (live body, `00377`), except that the offer is not required: ride `searching`; driver `approved`, `is_online`, heartbeat no older than 3 min, a vehicle that can serve the ride, not blocked, fleet rule for corporate rides, no other active ride, and `driver_can_afford_commission` ok. Then it makes the same ride write `accept_ride_v2` makes (`driver_id`, `status='accepted'`, `accepted_at`, `driver_custom_rate_cup`), sets that driver's pending offer to `accepted` if there is one, and every other pending offer to `superseded`. It inserts no offer row: an INSERT would fire the "Viaje disponible cerca" push for a ride that is already theirs. Logs to `admin_actions` and pushes the driver (category `system`, "Soporte te asignó un viaje", `data.event = 'ride_assigned'`). Errors return a specific code (`not_online`, `stale_heartbeat`, `insufficient_balance`, `busy`, `wrong_vehicle_type`, `blocked`, `not_in_fleet`, `ride_not_searching`, …). |
| `admin_change_ride_service(ride_id, service_type, fare_cup, mode, reason)` | admin | `mode = 'propose'` inserts a proposal, superseding any pending one, with expiry `support_proposal_ttl_s`. `mode = 'apply'` requires a reason, calls `_apply_ride_service_change` and logs to `admin_actions`. The checks of `_ride_service_change_error` apply to both. |
| `get_my_ride_service_proposal(ride_id)` | rider | Returns the pending, unexpired proposal for the caller's own searching ride, or nothing. |
| `respond_ride_service_proposal(proposal_id, accept)` | rider | Locks the ride first, then the proposal (same order as everything else on `rides`). The proposal must be pending and unexpired and the ride still `searching`. Accept calls `_apply_ride_service_change`; if that refuses (for example the type's minimum fare went up), the proposal stays pending and the error is returned. Reject marks it `rejected`. |
| `_ride_service_change_error(ride, service_type, fare_cup)` | internal | `ride_not_searching`, `cargo_not_supported`, `corporate_not_supported`, `waypoints_not_supported`, `same_service_type`, `service_type_unavailable` (inactive, or `mensajeria`), `too_many_passengers`, `fare_below_minimum`, `fare_out_of_range` (above five times the larger of the current fare and the new type's minimum), or NULL. |
| `_apply_ride_service_change(ride_id, service_type, fare_cup)` | internal only (no client EXECUTE) | Details below. |
| `notify_support_waiting_rides()` | cron, every minute | For each searching ride of a non-test customer that has been waiting longer than `support_alert_after_s` (at most 6 hours; a scheduled ride waits from `scheduled_at`) and has no `wait_alert_sent_at`, it stamps the column and sends the wait alert. Does nothing when `support_alert_enabled = false`. Help alerts are sent by `request_ride_help` itself, which does not read that setting. |
| `cleanup_orphan_searching_rides()` (existing, patched) | cron, every minute | Cancels a searching ride as `searching_abandoned` once its `searching_seen_at` (a scheduled ride: `scheduled_at`) is older than `searching_abandon_seconds` (600 s). The rider app refreshes `searching_seen_at` only in the foreground, and Pedir ayuda sends the rider to WhatsApp, so 00628 adds one condition: a ride whose `ride_assist.help_requested_at` is less than `support_help_keepalive_s` (1800 s) old is left alone. |

`_apply_ride_service_change`, in this order:
1. Re-locks the ride and re-runs `_ride_service_change_error`.
2. Rewrites the `estimate` row of `ride_pricing_snapshots` in place for the new type and fare, because `complete_ride_and_pay` charges `snapshot.total`. The logic moves from `tg_rides_create_estimate_snapshot` into `_write_ride_estimate_snapshot(ride, replace)`, which the trigger now calls with `replace = false` (insert only if there is none, as today), so both produce identical rows. It goes first because the discount trigger reads the snapshot as its fare base. It is an UPDATE, not a DELETE and INSERT: a destructive statement in a migration makes the MCP apply wait for approval (CLAUDE.md, 00617/00620).
3. Updates `service_type`, `estimated_fare_cup` and `estimated_fare_trc` (equal to the CUP fare: `cupToTrc` is the identity), and sets `discount_amount_cup = discount_amount_cup` so that `tg_rides_validate_promo_discount` (`UPDATE OF … discount_amount_cup`) recomputes the promo, partner and shared-ride discounts, and clears `shared_ride` when the new type is not `triciclo_basico`. That trigger skips the recompute for a `super_admin` caller (a deliberate escape hatch for support). A one-line patch makes it recompute anyway when the transaction sets `app.force_discount_recompute = '1'`, which only this function does, around this UPDATE.
4. `tg_rides_validate_insurance` recomputes the insurance premium on its own, on the new fare (see the proposal card). The surge multiplier is left as it was: `enforce_ride_update_columns` forbids a rider to change it, and the snapshot only records it.
5. Offers. `dispatch_ride` re-offers an `expired` offer once its expiry is older than `reoffer_cooldown_s` (120 s), and never a `superseded`, `rejected` or `accepted` one (00524), so the type change supersedes no offer:
   - a driver whose vehicle can serve the new type (`auto_standard` and `auto_confort` share their drivers) keeps the ride. If the new fare is the same or higher, their pending or expired offer becomes `expired` with its expiry back-dated past the cooldown, so the `dispatch_ride` call below re-offers it at once, on the same row, with a fresh TTL and a push at the new price (`trg_notify_driver_reoffer`). If the new fare is lower, only a pending offer changes, to `expired`: the driver app may still show the old card, at the higher price, until its next 30 s poll, and the offer must not be acceptable from it. Normal re-dispatch offers the new fare once the cooldown has passed;
   - a pending offer of a driver whose vehicle cannot serve the new type also only expires, so it cannot be accepted. `find_best_drivers` filters the vehicle type, so that driver gets no offer while the ride keeps a type they cannot serve. If the ride comes back to one they serve (triciclo → moto → triciclo), the rules above apply: their offer is re-offered at once if the fare is the same or higher, after the cooldown if it is lower;
   - rejected and accepted offers are left alone.

   Then it marks pending proposals `superseded` and calls `dispatch_ride(ride_id)`, so drivers of the new type get offers.

### Data

- `ride_assist` (lock table): `ride_id` PK → `rides` ON DELETE CASCADE, `help_requested_at`, `help_alert_sent_at`, `wait_alert_sent_at`, `created_at`. RLS with no policies; GRANT to `service_role` only.
- `ride_service_proposals` (lock table, read only through the RPCs above):
  - Columns: `id`, `ride_id`, `from_service_type`, `to_service_type`, `from_fare_cup`, `to_fare_cup`, `proposed_by`, `status` (`pending`, `accepted`, `rejected`, `superseded`), `expires_at`, `responded_at`, `created_at`.
  - A partial unique index allows one pending proposal per ride.
  - RLS with no policies; GRANT to `service_role` only. The rider reads through `get_my_ride_service_proposal`, the admin through `admin_ride_assist_context`.
  - Expiry is evaluated at read and respond time (`expires_at > now()`): a pending row past its expiry is expired. No sweeper is needed.
- `platform_config`: `support_alert_enabled` (true; turns off only the automatic wait alert, never a help request's), `support_alert_after_s` (60), `support_offer_ttl_s` (120), `support_proposal_ttl_s` (180), `support_help_keepalive_s` (1800: how long after a help request `cleanup_orphan_searching_rides` leaves the ride alone), `support_alert_email` (copied from `business_notification_email`). All six are added to `KNOWN_KEYS` with es/en/pt help text.
- Floors and caps the SQL applies whatever the settings say: a proposal lives at least 60 s and a support offer at least 30 s; the wait threshold is at least 15 s; the banner lists at most 50 rides; the candidate list has at most 60 drivers, active users only; the cron alerts at most 20 rides per run (one run a minute), none that has waited more than 6 hours.
- New tables follow the explicit-GRANT rule (`pnpm check:migration-grants`).

## Client and web changes

- `packages/api`:
  - Services: a new `rideAssistService` (`packages/api/src/services/ride-assist.service.ts`): `requestHelp`, `getPendingProposal`, `respondProposal` for the rider; `getWaitingRides`, `getAssistContext`, `getCandidates`, `offerToDriver`, `assignToDriver`, `changeServiceType` for support. Server error codes come back as `AppError` with the code.
  - Every rider-side call tolerates a missing RPC (`PGRST202`): no button side effect, no card.
  - `getLocalFareEstimate` gains `for_user_id` and `time_zone` (both optional; the rider app passes neither, so its prices do not change). The clock reading moves into `pricingClock(date, timeZone?)` in `packages/utils/src/fareCalculator.ts`.
- Client `SearchingView` (`apps/client/app/(tabs)/index.tsx`): the help button and the proposal card. While searching, it polls for a proposal every 5 s. After accepting, it refetches the ride so the type and price on screen update. The 3 s ride poll in `useRide.ts` also learns to notice a change of `service_type` or `estimated_fare_trc`, so a change support applies with WhatsApp consent reaches the screen.
- Web `track/[id]`: the same button and card.
- **Driver app.** Offers need no change. A directly assigned ride, though, only appears today when the app starts or comes back to the foreground (`useDriverRideInit` re-reads the active trip then); a driver looking at the home screen sees nothing, because realtime is off (BUG-277) and the 30 s poll only looks for offers. Driver 1.7.4 fixes it:
  - `requestActiveTripReconcile()`, exported from `useDriverRide.ts`, re-runs the home tab's active-trip check;
  - the 30 s poll of `useIncomingRequests` calls it when `getActiveTrip` finds a trip;
  - a push with `data.event = 'ride_assigned'` calls it, received in the foreground or tapped, and shows a toast with sound.

  Until drivers update, support tells the driver to switch apps and come back (which is what happens anyway when support coordinates by WhatsApp), and "Enviar oferta" works on every version.
- Admin: banner in the shell, the `/rides/[id]/assist` page, a link to it from the ride detail page, and a search by the 8-character code in `/rides`. Copy goes in `admin.json` (es/en/pt).

## Errors

- **The ride was taken or canceled while support was acting.** Every action re-checks `searching` under the row lock. The panel says "El viaje ya no está buscando" and refreshes.
- **An offer expires unanswered.** Support sends it to another driver.
- **Direct assignment fails.** The specific reason is shown: not online, busy, no balance, wrong type.
- **The proposal is answered after expiry, after a newer one replaced it, or when it can no longer be applied** (for example the type's minimum fare went up). The rider's response is refused (`proposal_expired`, `proposal_not_pending`, or the refusal code) and the card disappears; a network error keeps it, so the rider can retry.
- **The migration is not applied yet.** The app and web hide the button and the card, and the admin assist page shows an "unavailable" state instead of crashing.

## Testing

- **Local rehearsal** `supabase/tests/00628/` (Postgres 16 + PostGIS scaffold with the live bodies of `accept_ride_v2`, `dispatch_ride`, `find_best_drivers`, `tg_rides_validate_promo_discount`, `tg_rides_create_estimate_snapshot`, `cleanup_orphan_searching_rides` and the ride and offer triggers around them, checked by md5):
  - RED without the migration, GREEN with it, applied twice.
  - Covers: help request (rider only, idempotent); offer creation and each re-arm path with push enqueued; direct assignment with each failure code; races (the ride accepted or canceled concurrently, a proposal answered concurrently with an admin apply); service change recomputing the discount and rebuilding the snapshot (charged total equals the new fare); rejection of a fare below the minimum; corporate refusal; the cron alert stamping once.
  - A type change keeps the offers of drivers who can still serve the ride (S15-S17): on a higher fare their pending offer is re-offered at once, on the same row, with a push at the new price; on a lower fare it only expires (the driver cannot accept it) and `dispatch_ride` re-offers it once the cooldown has passed; an offer that expired inside the cooldown is re-offered at once on a higher fare. A driver who cannot serve the new type only sees the offer expire (S1), and gets it back at once, on the same row, when the ride returns to their type at a fare at least as high (S18: triciclo → moto → triciclo).
  - The abandoned-search cleanup (H9-H11): a stale search with no help request is still cancelled; one whose rider asked for help 5 minutes ago is not; one whose help request is 40 minutes old is.
- **Prod check** inside a block that rolls back at the end, before the merge.
- **Apps:** typecheck and lint for admin, client and web; unit tests for the new service methods.
- **Before submitting 1.7.4:** an end-to-end run with a test account (request, ask for help, receive the push, send an offer, change the type, accept the card, driver accepts, complete), checking the charged amount. Dispatch does not skip test accounts, so real online drivers get these offers and, after 60 s, offline drivers get the reconnect push: agree the moment with the founder and keep it short.

## Rollout

1. Merge and apply the migration (per-PR authorization). It has no DELETE, DROP or TRUNCATE, so it should apply through MCP without waiting for in-app approval; if the call still times out, apply it from the SQL Editor and verify by object (md5 of each function body), as CLAUDE.md describes.
2. The admin deploys automatically.
3. Client 1.7.4 is built with the button and card, and driver 1.7.4 with the assigned-ride pickup.
4. Each person on support installs the app, signs in with their admin account and enables notifications.
5. Baco's document describes the service as "el soporte te ayuda a conseguir conductor por WhatsApp".

## Out of scope

- SMS alerts.
- Changing the type of deliveries, corporate rides and rides with stops (none of the last two in 90 days).
- Analytics of support interventions beyond `admin_actions`.
- Riders on app versions older than 1.7.4 asking for help from inside the app.
