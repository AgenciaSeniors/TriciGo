# Support-assisted matching — design

Date: 2026-10-07 · Status: approved in chat, pending spec review · Target: client 1.7.4, admin, web

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
3. The alert shows in the admin panel and arrives as a push on the support staff's phones.
4. Support may switch the ride to another vehicle type, with a recomputed price.
5. The rider consents to a type and price change either in the app (a card with Accept/Reject) or over WhatsApp, in which case support applies the change and records why.
6. Support chooses, case by case, between sending the ride as an offer the driver accepts and assigning it directly.
7. It ships in client 1.7.4.

## User-facing behavior

### Rider (client app 1.7.4 and web)

- **Pedir ayuda.** From 45 s of searching (the `extended` stage of `searchWaitStage`, `packages/utils/src/searchWait.ts`), the searching screen shows "¿No aparece conductor? Pide ayuda". Tapping it:
  1. calls `request_ride_help(ride_id)`, which marks the ride and alerts support at once;
  2. opens `https://wa.me/5356621636?text=…` with "Hola, necesito ayuda para conseguir conductor. Viaje: <CODE>", where `<CODE>` is the first 8 characters of the ride id, upper case.

  The search keeps running. If the RPC is missing or fails, WhatsApp still opens.
- **Proposal card.** While a pending proposal exists, the searching screen shows "Soporte encontró una <tipo> · <precio nuevo> (antes: <tipo>, <precio>)" with **Aceptar** and **Rechazar**. A proposal expires after `support_proposal_ttl_s` (180 s). Accepting switches the ride's type and price and searching continues. Rejecting it, or letting it expire, changes nothing. If the ride was shared (triciclo only) and the new type is not triciclo, the card shows the price without the shared-ride discount.
- **Older apps (≤ 1.7.3)** see neither the button nor the card, so their proposals simply expire. Support can still apply a change with WhatsApp consent, and same-type offers and direct assignment work for every app version, because they act on the driver's side.

### Support (admin panel)

- **Alert banner.** It is mounted in the admin shell, so it appears on every page (today `SosAlertBanner` and `StuckRideBanner` only appear on the dashboard). It lists rides that have been searching for more than `support_alert_after_s` (60 s) or whose rider asked for help: rides that asked for help first, in red, then the rest oldest first. Each row shows elapsed time, origin → destination, type and price, and links to the assist page. A sound plays when a new ride enters the list. Browsers block audio until the user interacts with the page, so the banner asks for one click to enable sound.
- **Push.** Every active `admin` and `super_admin` gets a push for each ride: once when it crosses 60 s, and once more when the rider taps Pedir ayuda. The category is `system`, which is always delivered and already whitelisted. Each person on support must install the TriciGo app, sign in with their admin account and allow notifications; today only 1 of the 5 admins has a push token.
- **Assist page `/rides/[id]/assist`.** It opens from the banner or from the ride detail page and shows:
  - Ride facts: origin, destination, type, price, wait time, whether help was requested, the rider's phone with a WhatsApp link, the current offer (which driver, expiry) and the current proposal (status, expiry).
  - **Candidates**, from `admin_ride_assist_candidates`: drivers of the ride's type, with a filter for other types, sorted online-first and then by distance to pickup. Each row shows name, phone with WhatsApp and call links, online state, last heartbeat, distance, whether they are on another ride, and whether their balance covers the commission. Approved drivers who are offline but had a heartbeat in the last 7 days are listed below, so support can ask them to connect.
  - Two actions per driver:
    - **Enviar oferta**: an offer with a `support_offer_ttl_s` (120 s) TTL. The driver gets the usual push and card.
    - **Asignar directo**: asks for a reason, then assigns at once if every check passes.
  - **Cambiar tipo**: pick a type. The price is computed in the admin with `rideService.getLocalFareEstimate`, the same code and inputs the rider app uses: the ride's pickup, dropoff, `estimated_distance_m` and `estimated_duration_s`, and the current time band and weather surge. Then **Proponer al pasajero**, or **Aplicar (conformidad por WhatsApp)**, which requires a reason.
- Admins and super admins can use all of it.

## Server design (one migration)

The next free number is checked against master and open PRs right before writing. All functions are `SECURITY DEFINER` with `SET search_path = public, pg_catalog`. EXECUTE is revoked from `PUBLIC` and `anon` and granted only where the table below says.

| Function | Caller | What it does |
|---|---|---|
| `request_ride_help(ride_id)` | rider (`auth.uid() = customer_id`) | Ride must be `searching`. Sets `help_requested_at` (idempotent) and sends the help push to admins immediately via `cron_http_post('support-help-alert', …)`. Returns the short code. |
| `admin_support_waiting_rides()` | admin | Feeds the banner: searching rides (test customers excluded) older than the threshold or with help requested. |
| `admin_ride_assist_candidates(ride_id, service_type default ride's)` | admin | The candidate list described above. Commission affordability uses the same rule as `driver_can_afford_commission`. |
| `admin_offer_ride_to_driver(ride_id, driver_profile_id)` | admin | Locks the ride `FOR UPDATE`. The ride must be `searching`; the driver must be `approved` and have an active vehicle of the ride's type. Creates or re-arms that driver's `ride_offers` row as `pending` with `expires_at = now() + support_offer_ttl_s` and the real distance to pickup. The driver must get the standard offer push in every case: INSERT fires `trg_notify_driver_new_offer`, and `expired → pending` fires `trg_notify_driver_reoffer`. Re-arming a `rejected` or `superseded` row must also push. Logs to `admin_actions`. Online state, free state and balance are left to `accept_ride_v2` when the driver accepts. |
| `admin_assign_ride_to_driver(ride_id, driver_profile_id, reason)` | admin | Reason is required. Mirrors the checks in `accept_ride_v2` (latest body: `00377`), except that the offer is not required: ride `searching`; driver `approved`, `is_online`, heartbeat no older than 3 min, active vehicle of the ride's type, fleet rule for corporate rides, no other active ride, and `driver_can_afford_commission` ok. Then it applies the same writes `accept_ride_v2` makes: `driver_id`, `status='accepted'`, `accepted_at`, that driver's offer row set to `accepted` (inserted if missing), and every other pending offer set to `superseded`. Logs to `admin_actions` and pushes the driver (category `ride`, "Soporte te asignó un viaje", data `{type:'ride', ride_id}`). Errors return a specific code (`not_online`, `insufficient_balance`, `busy`, `wrong_vehicle_type`, `ride_not_searching`, …). |
| `admin_change_ride_service(ride_id, service_type, fare_cup, fare_trc, mode, reason)` | admin | `mode = 'propose'` inserts a proposal, superseding any pending one, with expiry `support_proposal_ttl_s`. `mode = 'apply'` requires a reason, calls `_apply_ride_service_change` and logs to `admin_actions`. Not allowed on corporate rides (`corporate_not_supported`). |
| `get_my_ride_service_proposal(ride_id)` | rider | Returns the pending, unexpired proposal for the caller's own ride, or nothing. |
| `respond_ride_service_proposal(proposal_id, accept)` | rider | Locks the ride first, then the proposal (same order as everything else on `rides`). The proposal must be pending and unexpired and the ride still `searching`. Accept calls `_apply_ride_service_change`; reject marks it `rejected`. |
| `_apply_ride_service_change(ride_id, service_type, fare_cup, fare_trc)` | internal only (no client EXECUTE) | Details below. |
| `notify_support_waiting_rides()` | cron, every minute | For each searching ride (test customers excluded) older than `support_alert_after_s` with no `wait_alert_sent_at`, it pushes the admins and stamps the column. It also sends the help push for any ride with `help_requested_at` set and `help_alert_sent_at` still empty (a backstop: `request_ride_help` normally sends it and stamps `help_alert_sent_at` itself). Pushes go through `cron_http_post` (label `support-wait-alert`). Does nothing when `support_alert_enabled = false`. |

`_apply_ride_service_change`:
- The ride must be `searching`, and the fare must be at least `service_type_configs.min_fare_cup` for the new type.
- If the new type is not `triciclo_basico`, it clears `shared_ride` and `shared_ride_seats_occupied`.
- It updates `service_type`, `estimated_fare_cup` and `estimated_fare_trc`. The fare TRC is computed the same way `createRide` does. The same UPDATE also sets `discount_amount_cup = discount_amount_cup` so that `tg_rides_validate_promo_discount` recomputes the promo and shared-ride discount. That trigger fires on `UPDATE OF … discount_amount_cup`, and the fare-floor trigger only fires on INSERT.
- It rebuilds the `estimate` row of `ride_pricing_snapshots`, because `complete_ride_and_pay` charges `snapshot.total`. The insert logic is extracted from `tg_rides_create_estimate_snapshot` into a shared helper, so the trigger and this function produce identical rows.
- It sets pending offers to `superseded`, marks other pending proposals `superseded`, and calls `dispatch_ride(ride_id)` so drivers of the new type get offers.

### Data

- `ride_assist` (lock table): `ride_id` PK → `rides` ON DELETE CASCADE, `help_requested_at`, `wait_alert_sent_at`, `help_alert_sent_at`. RLS with no policies; GRANT to `service_role` only.
- `ride_service_proposals`:
  - Columns: `id`, `ride_id`, `from_service_type`, `to_service_type`, `from_fare_cup`, `to_fare_cup`, `to_fare_trc`, `proposed_by`, `status` (`pending`, `accepted`, `rejected`, `expired`, `superseded`), `expires_at`, `responded_at`, `created_at`.
  - A partial unique index allows one pending proposal per ride.
  - RLS SELECT for the ride's customer and for admins. No client writes.
  - GRANT SELECT to `authenticated`; all privileges to `service_role`.
  - Expiry is evaluated at read and respond time (`expires_at > now()`). No sweeper is needed.
- `platform_config`: `support_alert_enabled` (true), `support_alert_after_s` (60), `support_offer_ttl_s` (120), `support_proposal_ttl_s` (180). All four are added to `KNOWN_KEYS` with es/en/pt help text.
- New tables follow the explicit-GRANT rule (`pnpm check:migration-grants`).

## Client and web changes

- `packages/api`:
  - Services: `rideService.requestRideHelp`, `getPendingServiceProposal`, `respondServiceProposal`; admin: `getSupportWaitingRides`, `getAssistCandidates`, `offerRideToDriver`, `assignRideToDriver`, `changeRideService`.
  - Every rider-side call tolerates a missing RPC (`PGRST202`): no button side effect, no card.
- Client `SearchingView` (`apps/client/app/(tabs)/index.tsx`): the help button and the proposal card. While searching, it polls for a proposal every 5 s. After accepting, it refetches the ride so the type and price on screen update.
- Web `track/[id]`: the same button and card.
- Driver app: no change for offers. The plan must verify that a directly assigned ride appears in the driver app without the driver accepting it, both when the app is open and when the push is tapped. If it does not, the fix belongs to this work.
- Admin: banner in the shell, the `/rides/[id]/assist` page, a link to it from the ride detail page, and a search by the 8-character code in `/rides`. Copy goes in `admin.json` (es/en/pt).

## Errors

- **The ride was taken or canceled while support was acting.** Every action re-checks `searching` under the row lock. The panel says "El viaje ya no está buscando" and refreshes.
- **An offer expires unanswered.** Support sends it to another driver.
- **Direct assignment fails.** The specific reason is shown: not online, busy, no balance, wrong type.
- **The proposal is answered after expiry, or after a newer one replaced it.** The rider's response is refused (`proposal_not_pending`) and the card disappears.
- **The migration is not applied yet.** The app and web hide the button and the card, and the admin assist page shows an "unavailable" state instead of crashing.

## Testing

- **Local rehearsal** `supabase/tests/<n>/` (Postgres 16 scaffold with the live bodies of `accept_ride_v2`, `dispatch_ride`, `tg_rides_validate_promo_discount` and `tg_rides_create_estimate_snapshot`):
  - RED without the migration, GREEN with it, applied twice.
  - Covers: help request (rider only, idempotent); offer creation and each re-arm path with push enqueued; direct assignment with each failure code; races (the ride accepted or canceled concurrently, a proposal answered concurrently with an admin apply); service change recomputing the discount and rebuilding the snapshot (charged total equals the new fare); rejection of a fare below the minimum; corporate refusal; the cron alert stamping once.
- **Prod check** inside a block that rolls back at the end, before the merge.
- **Apps:** typecheck and lint for admin, client and web; unit tests for the new service methods.
- **Before submitting 1.7.4:** an end-to-end run with a test account (request, ask for help, receive the push, send an offer, change the type, accept the card, driver accepts, complete), checking the charged amount.

## Rollout

1. Merge and apply the migration (per-PR authorization; a DELETE-free migration, so it should apply through MCP).
2. The admin deploys automatically.
3. Client 1.7.4 is built with the button and card.
4. Each person on support installs the app, signs in with their admin account and enables notifications.
5. Baco's document describes the service as "el soporte te ayuda a conseguir conductor por WhatsApp".

## Out of scope

- Changing the service type on corporate rides.
- SMS or e-mail alerts.
- Analytics of support interventions beyond `admin_actions`.
- Riders on app versions older than 1.7.4 asking for help from inside the app.
