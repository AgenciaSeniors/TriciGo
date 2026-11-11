# Moto Deportiva: a ride type that turns on when its pilot goes online

Date: 2026-11-08, revised 2026-11-09. Status: decisions taken with the owner (Luis Manuel, task assigned by Eduardo). Not implemented. Next free migration number on 2026-11-08: **00679** (master ends at 00678; open PRs hold 00569 and 00662). Check master and every open PR again before writing it.

## Why

A marketing video with an influencer who rides a sports motorbike got very good engagement. The idea: passengers can ask for a ride on that bike, with the influencer as the driver, whenever he is connected. Nobody knows in advance when that will be, so people subscribe to a notice and keep opening the app. No competitor has this. The rides also give the influencer and TriciGo content for social media (always with the passenger's spoken consent, see Decisions).

## Decisions (owner, 2026-11-08 and 2026-11-09)

- **Name:** "Moto Deportiva". Slug: `moto_deportiva`.
- **Availability is automatic (2026-11-09):** the Moto Deportiva can be requested whenever a pilot is online and free. Nobody on the team has to switch it on.
- **Activar / Desactivar in the panel (2026-11-09):** super admins keep that button (activated by default). Deactivated, it never shows as available, even with the pilot online. Activating it while a pilot is online notifies subscribers right away (same 3-hour limit).
- **Pilots:** a list kept by super admins. Today only the influencer; later there could be more.
- **Exclusive while connected:** a pilot only receives Moto Deportiva offers, never regular moto or delivery ones. Since availability is automatic, this holds every time he is online. To work as a regular moto driver he has to be removed from the list.
- **Price (2026-11-09):** **200 CUP less than a regular moto** for the same trip, at every hour. The 200 is a setting (`moto_deportiva_price_offset_cup`, value `-200`), so it can change later without a release. Never below the Moto Deportiva minimum fare (the moto minimum minus 200).
- **Filming consent:** nothing in the app. If a ride is going to be filmed, the pilot asks the passenger in person and only films if the answer is yes.
- **Safety:** same as any other ride. No extra steps.
- **Pickup distance:** the same dispatch rules as the other vehicles (stage 1 at 8 km, then `dispatch_max_radius_m`).
- **Visibility:** the card is always in the selector. When the pilot is not connected it is greyed out with "No disponible ahora" and an "Avísame" button. The setting `moto_deportiva_show_when_unavailable` (default `true`) can hide it without a release.
- **"Busy" state:** while the pilot is on a ride, the card shows "Ocupada · en un viaje" and cannot be requested.
- **No answer in 2 minutes:** the passenger is offered to change to a regular moto with one tap.
- **"Avísame" (2026-11-09):** a permanent subscription. Every time a pilot goes online, everybody subscribed gets a notification, until they leave the list by tapping "Te avisaremos". At most one notice every 3 hours (`moto_deportiva_waitlist_cooldown_h`), so a pilot whose app reconnects several times does not spam anyone. Tapping "Avísame" without notification permission asks for it at that moment; the notice is also saved in the in-app inbox for people without push.
- **Subscribers in the panel (2026-11-09):** super admins see who is subscribed (name, phone, date, last notice) and can remove anyone from the list.
- **Web parity:** tricigo.com/book gets the same option, states, "Avísame" and fallback.
- **Image:** an illustration in the same style and colours as the current selection images (`apps/client/assets/vehicles/selection/*.png`, `apps/web/public/images/vehicles/*.png`), showing a generic sports bike in the Yamaha / Honda / Ducati style. No brand, logo or model name on it.

## Current behaviour this builds on (verified 2026-11-08)

- `service_type_configs` (prod): `auto_confort`, `auto_standard`, `mensajeria`, `moto_standard`, `triciclo_basico` active; `triciclo_premium` exists with `is_active = false`. `rides.service_type` and `pricing_rules.service_type` are `text` with no CHECK constraint, so a new slug needs no enum change. Both price tables have a CHECK that every fare column is `>= 0`.
- **Trap:** dispatch maps services to vehicles by prefix. `_vehicle_types_for_service` (00669), `find_best_drivers` (last full body in 00524, patched later: read the **live** body) and `notify_offline_drivers_for_searching_rides` (00531) send every `moto%` service to every moto. A slug starting with `moto` would reach all moto drivers unless each of these is changed on purpose.
- The apps hardcode the list of services: client `apps/client/app/(tabs)/index.tsx` (lines ~110, 118, 831, 2879, 3059, 3072, 3086, 3898, 4365), `apps/client/src/hooks/useRide.ts:501`, web `apps/web/src/app/book/page.tsx` (~51, 327, 624, 1475), `packages/types/src/enums.ts` (`ServiceTypeSlug`), `packages/api/src/schemas.ts` (`serviceTypeSchema`), admin `apps/admin/src/lib/rideType.ts`. One app update (OTA is enough: JS and one image) is needed before the option exists.
- **The price comes from the app.** `rideService.getLocalFareEstimate` computes the fare on the device from `service_type_configs` and `pricing_rules`; the ride is created with that `estimated_fare_cup`, the estimate snapshot keeps it and `complete_ride_and_pay` charges it. The server only checks the floor (`tg_rides_validate_estimated_fare`, `service_type_configs.min_fare_cup`) and the ceiling of 00631 (the most expensive band of the service).
- A fixed −200 cannot live in the price tables: the moto 06:00–12:00 band has base fare 0, and the CHECK forbids a negative base.
- Searching has no server deadline: with the app open, dispatch retries forever (CLAUDE.md, "La búsqueda NO tiene deadline"). A ride offered only to the pilot would wait forever if he does not answer, hence the fallback.
- Drivers fall offline and reconnect often (72 % of disconnections are forced, CLAUDE.md "Conductores que se caen solos de línea"): a notice on every reconnection would spam, hence the 3-hour window.

## Design

### Data (migration 00679)

1. `service_type_configs` row `moto_deportiva`: `is_active = true` (the panel's Activar / Desactivar), `max_passengers = 1`, the moto_standard USD rates, and a minimum fare 200 CUP below the moto one (as USD at today's rate). Its 4 `pricing_rules` bands copy the moto ones with the same reduction on the minimum (never below 0). These rows only serve the server checks (floor and ceiling); the app prices the trip as below.
2. `platform_config`: `moto_deportiva_price_offset_cup` = `-200`, `moto_deportiva_show_when_unavailable` = `true`, `moto_deportiva_waitlist_cooldown_h` = `3`.
3. `moto_deportiva_pilots (driver_profile_id uuid PK → driver_profiles ON DELETE CASCADE, added_by, created_at)`. Lock table: RLS on, no policies, GRANT to `service_role` only.
4. `moto_deportiva_waitlist (user_id uuid PK → users ON DELETE CASCADE, created_at, notified_at)`. Lock table too. `notified_at` records the last notice. Both FKs cascade, so account deletion needs no change.
5. `moto_deportiva_notices (id, sent_at, recipients, source)`: one row per notice sent (`pilot_online` or `admin_on`), for the cooldown and the metrics. Lock table.

### Price

`getLocalFareEstimate({service_type: 'moto_deportiva', …})` computes the `moto_standard` estimate for the same trip (same route, band, weather surge, stops) and adds `moto_deportiva_price_offset_cup`, with the Moto Deportiva minimum fare as the floor. Client and web share this function, so both show the same price. The server checks stay valid: the floor is 200 below the moto one, and the ceiling uses the copied bands.

### Dispatch

- A helper `_md_driver_allowed(driver_profile_id, service_type)`: for `moto_deportiva`, only pilots; for any other service, everybody except pilots (the exclusivity rule).
- It is patched into `find_best_drivers`, `notify_offline_drivers_for_searching_rides` (which also gets its own `moto_deportiva` group, matched by no vehicle, so nobody is pushed for it) and `_driver_can_serve_ride` (support offers and assignments). In-place patches of the live bodies with md5 guards, as in 00669/00671.

### Status for the apps

`get_moto_deportiva_status()` (SECURITY DEFINER, `anon` and `authenticated`) returns `{status, waiting}`; `waiting` is true when the caller is subscribed. Statuses:

| Value | When | Card shows |
|---|---|---|
| `hidden` | not requestable and `moto_deportiva_show_when_unavailable = false` | no card |
| `off` | deactivated in the panel | greyed out, "No disponible ahora", "Avísame" / "Te avisaremos" |
| `offline` | no pilot online | greyed out, "No disponible ahora", "Avísame" / "Te avisaremos" |
| `busy` | pilots online but every one has an active ride or is on a break, or a Moto Deportiva request is already searching (created in the last 150 s) | greyed out, "Ocupada · en un viaje" |
| `available` | a pilot online, approved, free | normal card with price, can request |

It never returns positions or ids. The apps refresh it on focus and every 30 s while the selector is open.

A client request for `moto_deportiva` when the status is not `available` (or a delivery, a company ride or a scheduled ride) is rejected by a BEFORE INSERT trigger with DETAIL `moto_deportiva_unavailable` and a Spanish MESSAGE.

### "Avísame" notice

`_moto_deportiva_send_notice(source)` runs when a pilot goes from offline to online (AFTER UPDATE OF `is_online` trigger on `driver_profiles`) and when a super admin activates the service while a pilot is online. If the service is activated and the last notice is older than the cooldown, it sends one push to everybody subscribed, in batches of 300 ids, through `cron_http_post` to `send-push` (label `moto-deportiva-waitlist`, category `promo`). Text: "¡La Moto Deportiva está disponible! Pídela ahora." It stamps `notified_at` and writes a `moto_deportiva_notices` row. A failure never blocks the pilot going online or the panel action; it is logged in `rpc_attempt_log`.

`send-push` saves every push in the inbox (`notifications`), so people without a push token see it the next time they open the app. Tapping "Avísame" without permission asks for it while it is still `undetermined` (`shouldSpendPushPrompt`), or opens the soft-ask sheet with the link to Settings after a denial; joining works either way.

### Fallback to regular moto (client + web)

After 120 s searching with no driver on a `moto_deportiva` ride, the search screen shows "La Moto Deportiva no respondió" with a "Cambiar a Moto" button. The tap cancels the ride (free while searching: no reputation event) and returns to the selection screen with the same addresses and Moto selected; the app estimates the moto price (200 CUP more) and the rider confirms it. Rejected: a server RPC that changes the type in place, because the server has no fare calculator and would have to trust a fare sent by the client.

### Admin panel (super admins only)

A "Moto Deportiva" page:

- the "Activar" / "Desactivar" button (`admin_set_moto_deportiva`, one `admin_actions` row per change) and the current status (Disponible / Ocupada / Activada · piloto desconectado / Desactivada);
- pilots: list (name, online), add by phone (`admin_add_moto_deportiva_pilot`, an approved driver with an active moto), remove (`admin_remove_moto_deportiva_pilot`);
- subscribers: list with name, phone, subscription date and last notice (`admin_moto_deportiva_subscribers`), and "Quitar del aviso" (`admin_remove_moto_deportiva_subscriber`), each removal in `admin_actions`;
- metrics (decided 2026-11-09), over 7, 30 or 90 days (`admin_moto_deportiva_metrics(p_days)`): subscribers now and new, notices sent and people notified, requests, completed, canceled, changed to a regular moto, revenue, people whose first completed ride was a Moto Deportiva, and hours with the pilot online (heartbeats are kept 30 days).

`rideType.ts` and the ride filters learn the new label.

### Apps

- **Client and web:** new card after "Moto", the states above, "Avísame", the fallback banner, and Moto Deportiva in history, receipts and the active ride view. i18n es/en/pt.
- **Driver:** a "Moto Deportiva" badge on the offer card and the active trip.

## Testing

- Migration rehearsal in `supabase/tests/00679/run.sh` (RED without the migration, GREEN applied twice, CRLF copy, negative tests of the self-checks): offers only to pilots; pilots never get other services; statuses; insert guard; the notice on a pilot going online, once per cooldown, to every subscriber, again on a later connection; only super admins use the admin RPCs.
- A rehearsal in prod inside a rolled-back block before applying, with the demo accounts.
- vitest: status → card mapping, the 120 s fallback rule, and the price offset in `getLocalFareEstimate`; `pnpm check-types`.

Implementation plan: `docs/superpowers/plans/2026-11-08-moto-deportiva.md`.

## Open items (block the launch, not the build)

1. **Pilot account:** the influencer must have an approved driver account with his bike registered as a moto.
2. **Pilot income:** at 200 CUP below a regular moto the pilot earns less per ride than on regular moto work; confirm it with him.

## Rejected

- A switch the team turns on and off by hand (first version of this design): replaced by automatic availability on 2026-11-09.
- A new `vehicle_type` enum value for sports bikes: touches onboarding, documents, dispatch and several screens, for one pilot.
- Broadcasting a push to every user: one pilot cannot serve that demand.
- Putting the −200 in the price tables: the CHECK forbids a negative base fare.
- In-app filming consent: the pilot asks in person.
