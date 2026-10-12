# Stuck-ride support — design

Date: 2026-10-12 · Status: approved in chat; written from the owner's answers · Target: admin; driver app next build (one small change) · Plan: `docs/superpowers/plans/2026-10-12-stuck-ride-support.md`

## Why

Support can already help a ride that is still searching (00628, `/rides/[id]/assist`). Once a driver has the ride, the panel can only cancel it. Rides get stuck after acceptance in a few ways, all measured in prod on 2026-10-12:

- **The driver app stops reporting.** `release_rides_from_dead_drivers` returns a ride to searching after 12 minutes of silence, but only before pickup. After pickup it only inserts a `stuck_ride_alerts` row (`dead_driver_app`). That has happened twice, and both rides were later completed by the driver.
- **The driver cannot finish.** `check_stuck_active_rides` flags `complete_blocked` (the app refused completion because of the distance gate) and `stationary_chat` (the driver has not moved for 5 minutes and the chat is active).
- **The driver cannot mark arrival.** Without live GPS and without a trail near the pickup, `update_ride_status_v2` refuses "Llegué" (`gps_required`, Path D). On Cuba's networks that happens.

In all three cases support has no tool. Cancelling charges nothing and pays the driver nothing for a ride that happened. Waiting 12 minutes for the automatic release makes the rider wait.

Volume is low: 185 rides in the last 90 days, 9 completed, 4 of them with a wait charge (397 CUP on average), none active right now. The tool protects the few real rides and the driver's pay.

## Decisions taken with the owner

1. Four tools: **Terminar y cobrar**, **Avanzar el estado**, **Volver a buscar conductor ya**, and **Contacto rápido** (WhatsApp and call for both parties).
2. **Charge:** the agreed price plus the recorded wait. This is what `complete_ride_and_pay` already charges: the estimate snapshot total, minus the discount, plus the wait.
3. **Push to both** rider and driver when support acts.
4. **Pickup time when support marks the trip as started:** when the GPS trail shows the driver leaving the pickup. With no such point, no wait is charged.
5. **Approach:** server functions plus the existing assist page, extended for active rides. Raw admin UPDATEs were discarded: they skip the charge rules and leave no reason. A separate page was discarded: it would duplicate the contact and ride-facts parts of the assist page.

## User-facing behavior

### Support (admin panel)

- **Entry points.**
  - On the ride detail page, "Asistir" also shows for `accepted`, `driver_en_route`, `arrived_at_pickup`, `in_progress` and `arrived_at_destination`. Today it shows only for `searching`.
  - `StuckRideBanner` (dashboard) links to `/rides/[id]/assist` when there is one alert. Today it links to `/rides/[id]`.
- **Assist page, active-ride view.** For those five statuses the page shows a different view from the searching one:
  - **The ride:** code, status, type, payment method, origin → destination, and the times so far (accepted, arrived, picked up).
  - **The rider:** name and phone, with WhatsApp and call links.
  - **The driver:** name and phone with WhatsApp and call links, the vehicle label (as in the candidate list), online state and time since the last heartbeat.
  - **The GPS trail:** the last trail point's age and its distance to the pickup (before pickup) or to the destination (after).
  - **The stuck alert:** the open alert's reason and when it was detected, if there is one.
  - **The charge:** the agreed price, the discount, the recorded wait (minutes and CUP), the insurance premium if any, and the total. Before pickup, the panel says the charge is not known yet.
- **Actions.** Only the actions that are valid for the current status show. The server decides which (`allowed_actions` in the context).

  | Status | Actions |
  |---|---|
  | `accepted`, `driver_en_route` | Volver a buscar conductor · Marcar llegada |
  | `arrived_at_pickup` | Marcar viaje iniciado |
  | `in_progress` | Marcar llegada al destino · Terminar y cobrar |
  | `arrived_at_destination` | Terminar y cobrar |

  Each action opens a dialog that says what will happen and asks for a reason (3 characters at least).
  - "Marcar viaje iniciado" shows the pickup time it will record and the resulting wait charge.
  - "Terminar y cobrar" shows the amount that will be charged.

  After the action the page reloads. When the ride is no longer active (released or completed), it switches to the regular view. Cancelling stays on the ride detail page, as today.
- **Refusals** show a Spanish message per code (see "Errors").

### Rider

- **Advance and complete:** the rider gets the status push that every status change already sends (`notify_ride_status_change`): "Conductor llegó", "Viaje iniciado", "Llegaste a tu destino", or "Viaje completado · Pago: $X CUP". The SMS trigger also sends its usual text on arrival and completion. Support does not add a second push for these: it would repeat the same news a second later.
- **Release:** "Buscando otro conductor — Tu conductor no pudo continuar. Estamos buscándote otro ahora mismo." This is the dead-driver release text, minus the connection reason, which may not apply. The rider app polls the ride every 3 s and goes back to the searching screen, as it already does after an automatic release. If the next dispatch is round 2 or 3, `notify_dispatch_retry` also sends its "Seguimos buscando" push, as it does after an automatic release.

### Driver

- **Every support action pushes the driver,** category `system` (always delivered), with `data.event = 'support_ride_update'` and the ride id:
  - **Release:** "Soporte te quitó el viaje — Estamos buscando otro conductor para este viaje. Te pusimos fuera de línea: conéctate cuando puedas tomar viajes."
  - **Advance:** "Soporte actualizó tu viaje", with one sentence per step: "Marcamos que llegaste al punto de recogida.", "Marcamos el viaje como iniciado." or "Marcamos que llegaste al destino."
  - **Complete:** no extra push. `notify_ride_status_change` already sends the driver "Viaje completado. ¡Revisa tus ganancias!".
- **App change (next driver build).** While a trip is active, the 5 s trip poll in `useDriverRide` today only refreshes GPS-override fields and the fare. It will also apply a status from the server that is further along than the one on screen (`accepted` < `driver_en_route` < `arrived_at_pickup` < `in_progress` < `arrived_at_destination`), with a neutral toast "Tu viaje se actualizó — Te mostramos el estado actual del viaje." (the poll cannot tell support's change from the driver's own tap whose answer was lost; the support push says who did it).
  - It applies only a status that is further along, so a slow poll answer from before the driver's own tap cannot move the screen back.
  - Completion and release already reach the screen through the same poll: a ride that leaves the active set is read once and shown as completed or lost.
  - On builds without this change, the screen catches up when the app returns to the foreground or restarts (`checkActive`). Until then, a tap on the old button either repeats a step the server already has (it passes and changes nothing) or fails with "Invalid ride transition". Support tells the driver by WhatsApp to leave the app and come back.
- **A released driver** gets the same notice the automatic release gives today ("Perdimos tu conexión — Tu app dejó de reportar…") on builds that read the ride after it leaves. The support push says what actually happened. The notice text is not changed here.

## Server design (one migration)

The number is the next free one when the migration is written: 00660 at the earliest. #1151 (team invitations) also needs one, so check master and every open PR right before writing it.

Every new function:

- is `SECURITY DEFINER` with `SET search_path = public, pg_catalog` (plus `extensions` where it reaches PostGIS);
- requires `is_admin()` (admin and super_admin; marketing is refused);
- has EXECUTE revoked from `PUBLIC` and `anon`, and granted to `authenticated` only for the four RPCs the panel calls.

The migration asserts all of this at the end. Refusals return `{error: <code>, status}` like 00628, and the service turns them into `AppError` with that code.

### Helpers

| Function | What it does |
|---|---|
| `_wait_charge_for(service_type, arrived_at, pickup_at)` | Pure (STABLE, no writes). Returns `wait_minutes`, `billable_minutes` and `charge` using `calculate_wait_charge`'s rules: free minutes from the service config, the `max_billable_wait_minutes` cap, and the rate of the Havana-time band the wait started in, falling back to the service config's rate. Zero when either time is missing. |
| `calculate_wait_charge(ride_id)` (existing, rewritten) | Calls `_wait_charge_for` and writes `wait_time_minutes` / `wait_time_charge_cup`, as today. The migration replaces it only if the live body has the md5 it was written for (`2c0679d1…`). The rehearsal and the prod check prove it returns the same values as the old body for every ride that has both times, plus synthetic waits in each band. |
| `_ride_gps_departure_at(ride_id, since)` | The time of the first trail point more than 100 m from the pickup at or after `since`, taking for each point `LEAST(recorded_at, received_at)`: never later than the server received it. For departure, a later time means more wait for the rider, so this is the bound that protects them (00659 used `GREATEST` for arrival, for the same reason). Never later than `now()`. NULL when there is no such point. |
| `_active_ride_charge_preview(ride, pickup_at)` | The agreed price (estimate snapshot `total`), the discount, the wait for the given pickup time, the insurance premium if selected, and the total `GREATEST(total − discount, 0) + wait`. NULL when the ride has no estimate snapshot. In the last 90 days every ride had one. On a corporate ride with a commission below the default, `complete_ride_and_pay` lowers the final fare. The preview returns `is_corporate` and the panel says the final amount can be lower. `amount_changed` still compares the same preview. |

### RPCs

| Function | Status | What it does |
|---|---|---|
| `admin_active_ride_context(ride_id)` | any | Everything the active view shows, in one call: the ride with its times, rider and driver (name, phone, online, last heartbeat, vehicle label), the last trail point (age, distance to pickup and to dropoff), the open stuck alert, the charge preview, and `allowed_actions`. For `arrived_at_pickup` it also returns the pickup time "Marcar viaje iniciado" would record and the preview for it. |
| `admin_release_active_ride(ride_id, expected_status, expected_driver_id, reason)` | `accepted`, `driver_en_route` | Locks the ride. Refuses with `ride_changed` if the status is not the one support saw, and with `scheduled_not_due` if the ride is scheduled for later (support cancels it instead). Then it does what the automatic release does (block A), right away. The driver goes offline. The ride goes back to `searching` with `driver_id`, `accepted_at` and `last_dispatched_at` NULL and `searching_seen_at = now()`. The driver's pending offers expire; the accepted offer stays `accepted`, so dispatch never gives this ride back to him and his `acceptance_rate` does not change. Two more things: it also resets the previous driver's GPS state (`driver_gps_status`, `gps_override_requested_at`, `gps_override_confirmed_at`, `gps_check_distance_m`, `driver_custom_rate_cup`), so a rider confirmation given to that driver does not let the next one skip the arrival gate; and it calls `dispatch_ride` at once instead of waiting for the next cron minute. Marks the open stuck alert resolved, logs to `admin_actions` (`support_release_ride`) and pushes both. No reputation event for anyone. |
| `admin_advance_active_ride(ride_id, expected_status, expected_driver_id, reason)` | `accepted`, `driver_en_route`, `arrived_at_pickup`, `in_progress` | Locks the ride, refuses `ride_changed`, and moves it one step. **Marcar llegada** goes from `accepted` or `driver_en_route` to `arrived_at_pickup` with `driver_arrived_at = COALESCE(driver_arrived_at, now())`. **Marcar viaje iniciado** goes from `arrived_at_pickup` to `in_progress` with `pickup_at = COALESCE(pickup_at, _ride_gps_departure_at(ride, driver_arrived_at), driver_arrived_at, now())`: with no departure point the pickup is the arrival time, so there is no wait. **Marcar llegada al destino** goes from `in_progress` to `arrived_at_destination`. None of these runs the GPS gate of `update_ride_status_v2`: support stands in for the driver's tap. Logs to `admin_actions` (`support_advance_ride`, old and new status, the recorded times) and pushes the driver. |
| `admin_complete_active_ride(ride_id, expected_status, expected_driver_id, expected_total_cup, reason)` | `in_progress`, `arrived_at_destination` | Locks the ride and refuses `ride_changed`. Refuses `no_agreed_price` when there is no estimate snapshot. Recomputes the preview and refuses `amount_changed` when it differs from the total support confirmed (for example, the driver's app moved the ride meanwhile). Then it calls `complete_ride_and_pay(ride, ride.driver_id, estimated_distance_m, estimated_duration_s)`, which admits admin callers, charges the snapshot total minus the discount plus the wait, and handles wallets, the shortfall to cash (00637), corporate rides and splits as for any ride. The distance arguments do not change the charge of a ride with a snapshot: the function prefers the trail distance and only records it. Marks the open stuck alert resolved and logs to `admin_actions` (`support_complete_ride`, with the final fare). The completion pushes come from the existing trigger. If the driver's app later replays its own queued completion, it gets "cannot be completed (current: completed)", which the app already treats as success (BUG-263). |

### Data

- `valid_transitions` gets one row: `accepted → arrived_at_pickup` for `{admin, super_admin}`. Without it, "Marcar llegada" from `accepted` would take two transitions and send the rider two pushes ("Conductor en camino", then "Conductor llegó") a second apart. Drivers keep the step-by-step path.
- No new tables or columns.
- The pushes go through `cron_http_post` with the label `support-ride-resolved`, each in a block of its own. A failure before the HTTP call leaves a WARNING and an `rpc_attempt_log` row (`push_failed`); the action stays.

## Admin and app changes

- **`packages/api`.** `rideAssistService` gains `getActiveContext`, `releaseActiveRide`, `advanceActiveRide` and `completeActiveRide`. A missing RPC (`PGRST202`) makes the page show its "unavailable" state, as in 00628.
- **Admin.**
  - The assist page renders the active view, as a new `AssistActiveRide` component next to `AssistCandidates`, for the five statuses. It polls the context every 10 s like the searching view.
  - "Asistir" on the ride detail page for active statuses, and the banner link.
  - The new error codes go into `assistErrors.ts`, with copy in `admin.json` (es/en/pt).
- **Driver app.** The poll change above, and the toast copy in `driver.json` (es/en/pt).
- **Rider app and web:** no changes.

## Errors

- **The ride changed while support was looking** (`ride_changed`, `amount_changed`): "El viaje cambió mientras lo mirabas. Revisa los datos y vuelve a intentarlo." The page reloads.
- **The action does not fit the status** (`ride_not_releasable`, `ride_not_advanceable`, `ride_not_completable`): the page reloads and shows the actions that fit.
- **No agreed price** (`no_agreed_price`): "Este viaje no tiene precio acordado; no se puede cobrar desde soporte."
- **Scheduled for later** (`scheduled_not_due`): reused from 00628.
- **Missing reason** (`reason_required`) and **not an admin** (`forbidden`): reused.
- **`complete_ride_and_pay` raises** (for example, a corporate wallet that cannot be charged): the whole action rolls back. The panel shows the server's message, and nothing changes.
- **A push fails:** the action stays, and `push_failed` is logged.

## Testing

- **Local rehearsal** `supabase/tests/<n>/`: Postgres 16 + PostGIS scaffold with the live bodies of `calculate_wait_charge`, `enforce_ride_transition`, `notify_ride_status_change`, `dispatch_ride` (stubbed to record the call), `complete_ride_and_pay` (stubbed to record its arguments) and the 00659 trail guard, each checked by md5. RED without the migration, GREEN with it, applied twice, plus a CRLF copy. It covers:
  - **Wait helper:** `_wait_charge_for` equals the old `calculate_wait_charge` on a grid of waits (0 to 40 minutes, every band, a missing time).
  - **Departure:** first point beyond 100 m; a point recorded before arrival is ignored; `LEAST` picks the server time when the phone's time is later; no point gives NULL, and the advance then records no wait.
  - **Each action, per status:** allowed and refused (`ride_changed`, `scheduled_not_due`, `no_agreed_price`, `amount_changed`, `reason_required`, marketing and rider callers refused).
  - **Release:** the ride state matches block A, plus the GPS reset; the accepted offer stays; the driver goes offline; dispatch is called.
  - **Transitions:** `accepted → arrived_at_pickup` produces one transition row and one status push.
  - **Pushes:** one push per party per action, and a failed push keeps the action.
  - **Self-checks:** the migration's assertions, each seen failing on a broken copy.
- **Prod check** in a block that rolls back, before the merge:
  - `calculate_wait_charge` old vs new on every prod ride that has both times;
  - an end-to-end run with the demo rider and driver: create the ride, accept, mark arrival, insert trail points with back-dated `recorded_at`, mark started, complete. Check the final fare (snapshot total − discount + wait from the GPS departure), the ledger entries, and the queued pushes.
- **Apps:** typecheck and lint for admin and driver; unit tests for the new service methods and for the driver's forward-only status rule.

## Rollout

1. Merge and apply the migration (per-PR authorization). It has no DELETE, DROP or TRUNCATE, so it should apply through MCP without waiting for in-app approval. Verify by object: the md5 of each function body, and the `valid_transitions` row.
2. The admin deploys automatically.
3. The driver change goes in the next driver build.

## Out of scope

- **A support notice** that replaces "Perdimos tu conexión" for a support release. It needs the driver app to know why the ride left; the push covers it meanwhile.
- **Changing a stuck ride's price or route.** Support charges the agreed price; anything else is a dispute.
- **Alerts for stuck pre-pickup rides** before the 12-minute release. Support finds them from the ride list or the rider.

## Review round 1 (2026-10-12)

A code review of the first version of 00660, and checks against prod, changed the design as follows.

- **Bound to the driver support saw.** Release, advance and complete take `p_expected_driver_id` and refuse `ride_changed` when the ride's driver is another one. Without it, if the ride was released and taken by another driver while support was looking, support would act on that new driver. The context returns `driver_profile_id` for the panel to send back.
- **Lock order.** The release locks the driver profile first, then the ride, like the automatic release and `update_driver_position`. Advance and complete lock the ride first, like `complete_ride_and_pay`.
- **Other drivers' offers.** `accept_ride_v2` marks every other pending offer `superseded`, and `dispatch_ride` re-arms only `expired` rows past the re-offer cooldown. So after a release, nobody who had been offered the ride ever got it again. This applied to the support release and to the automatic release (block A of `release_rides_from_dead_drivers`), checked in prod on 2026-10-12. `_reopen_ride_offers` resets those rows to `expired` with a past `expires_at`, and both releases call it. `rejected` offers stay as they are. Block A is patched in place from its live body (md5 `c99dd7b8…`), and it also gets the GPS and proximity reset that the support release does.
- **Proximity notice.** Both releases reset `proximity_pickup_notified_at`, so the rider gets "Conductor cerca" for the new driver.
- **Driver offline by hand.** `tg_driver_profiles_shift_intent` clears `auto_offline_at` on any `is_online` change made with a user token, the admin's included. The support release no longer writes it, and the driver reconnects by hand (the push says so).
- **Cargo rides.** Admins skip `tg_rides_require_delivery_proof`, so "Terminar y cobrar" refuses a cargo ride without the recipient code and the delivery photo (`delivery_proof_missing`). The context drops "complete" for that ride. Support can still advance it to the destination, so the driver's app collects the proof, or cancel it.
- **A silent gap in the trail.** Measured in prod: while a driver waits at the pickup with the app alive, it sends a point every few seconds (the longest gap seen was 5.5 minutes). When more than 6 minutes pass between the last point and the first point away from the pickup, the app is treated as not running (a live app rarely goes silent that long; when it does, the driver loses that stretch). The departure is then the last point that proves the driver was still there (or the arrival, if there is none), and the unrecorded wait is not charged. This follows decision 4: no evidence, no charge. Only the current driver's points count.
- **Scheduled rides not yet due.** Advance refuses `scheduled_not_due`, and the context offers neither release nor advance for them.
- **Self-ride.** An admin who is the ride's rider or driver gets `self_ride`. Prod has a super_admin who also drives.
- **Responses.** Advance returns the times and the wait it recorded. Complete returns `payment_method`, `cash_amount_cup` (the cash the driver collects) and `wallet_amount_cup` (paid from wallets), derived from the ride row after `complete_ride_and_pay`: its own keys are 0 on a cash ride. On a cash ride the driver collects the whole fare; on a mixed ride (a wallet shortfall, splits included) the row's cash part. The panel keeps that notice up for 20 seconds, so support can tell a driver whose app is down how much to collect.
- **Accepted as is:**
  - On a release the rider can get two pushes together: the support push and the dispatch-retry push of the new round.
  - A rider who stays away from the app (for example on WhatsApp with support) for more than `searching_abandon_seconds` after a release can have the ride closed as abandoned, as after any release.
  - The new driver can read the rider's chat with the previous one. That predates this work and also happens after the automatic release.

