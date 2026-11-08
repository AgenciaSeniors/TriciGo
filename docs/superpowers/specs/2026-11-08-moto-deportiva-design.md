# Moto Deportiva: a ride type that super admins switch on, served by one pilot

Date: 2026-11-08. Status: decisions taken with the owner (Luis Manuel, task assigned by Eduardo); waiting for his review of this document. Price and marketing metrics are still open (see "Open items"). Not implemented. Next free migration number on 2026-11-08: **00679** (master ends at 00678; open PRs hold 00569 and 00662). Check master and every open PR again before writing it.

## Why

A marketing video with an influencer who rides a sports motorbike got very good engagement. The idea: passengers can sometimes ask for a ride on that bike, with the influencer as the driver. Nobody knows in advance which day it will be available, so people keep opening the app to check. No competitor has this. The rides also give the influencer and TriciGo content for social media (always with the passenger's spoken consent, see Decisions).

## Decisions (owner, 2026-11-08)

- **Name:** "Moto Deportiva". Slug: `moto_deportiva`.
- **Who switches it on and off:** only super admins, from the admin panel, any day. The schedule is agreed with the pilot beforehand (today it is mostly Sundays). There is **no** automatic switch-off: a super admin turns it off by hand. Accepted risk: if someone forgets, people can still request it while the pilot is not around; the "no answer in 2 minutes" fallback below covers that case.
- **The pilot does nothing special:** he goes online in the driver app and waits for requests.
- **Pilots:** a list kept by admins. Today only the influencer; later there could be more.
- **Exclusive while active:** while Moto Deportiva is on, a pilot only receives Moto Deportiva offers, never regular moto ones. While it is off, he is a regular moto driver.
- **Filming consent:** nothing in the app. If a ride is going to be filmed, the pilot asks the passenger in person and only films if the answer is yes.
- **Safety:** same as any other ride. No extra steps.
- **Price:** premium, value to be decided by the team. It is set in the migration, **not** from the panel.
- **Pickup distance:** the same dispatch rules as the other vehicles (stage 1 at 8 km, then `dispatch_max_radius_m`).
- **"Busy" state:** while the pilot is on a ride, the card shows "Ocupada · en un viaje" and cannot be requested.
- **No answer in 2 minutes:** the passenger is offered to switch the same request to a regular moto with one tap.
- **"Avísame":** opt-in. With the service off, the card is shown greyed out with an "Avísame" button; when a super admin switches it on, only those people get a push. No broadcast to everyone (one pilot cannot serve hundreds of requests at once).
- **Web parity:** tricigo.com/book gets the same option, states and fallback.
- **Image:** a picture of the bike for the selection card, like the other vehicles. Until the team sends it, the moto image is used.

## Current behaviour this builds on (verified 2026-11-08)

- `service_type_configs` (prod): `auto_confort`, `auto_standard`, `mensajeria`, `moto_standard`, `triciclo_basico` active; `triciclo_premium` exists with `is_active = false`. `rides.service_type` and `pricing_rules.service_type` are `text` with no CHECK constraint, so a new slug needs no enum change.
- **Trap:** dispatch maps services to vehicles by prefix. `_vehicle_types_for_service` (00669) and `find_best_drivers` (last full body in 00524, patched later: read the **live** body) send every `moto%` service to every moto. `notify_offline_drivers_for_searching_rides` (00531) does the same for the "a passenger is looking for…" push to offline drivers. A slug starting with `moto` would reach all moto drivers unless each of these is changed on purpose.
- The apps hardcode the list of services: client `apps/client/app/(tabs)/index.tsx` (lines ~110, 118, 831, 2879, 3059, 3072, 3086), web `apps/web/src/app/book/page.tsx` (~51, 327, 624, 1475), `packages/types/src/enums.ts` (`ServiceTypeSlug`), `packages/api/src/schemas.ts` (`serviceTypeSchema`), admin `apps/admin/src/lib/rideType.ts`. One app update (OTA is enough: JS and one image) is needed before the option exists; from then on it is switched from the server.
- Searching has no server deadline: with the app open, dispatch retries forever (CLAUDE.md, "La búsqueda NO tiene deadline"). A ride offered only to the pilot would wait forever if he does not answer, hence the fallback.
- Support can already change a ride's service type with `_apply_ride_service_change` (00628), which rewrites the estimate snapshot and reopens offers.
- Prices: the source of truth is the `*_usd` columns; `recompute_cup_from_usd_prices()` derives CUP. `tg_rides_validate_estimated_fare` rejects a fare below `service_type_configs.min_fare_cup` and above the ceiling of 00631.

## Design

### Data (migration 00679)

1. `service_type_configs` row `moto_deportiva`, `is_active = false`, `max_passengers = 1`, premium USD prices (open item), plus its `pricing_rules` rows for the 4 bands, then `recompute_cup_from_usd_prices()`.
2. `moto_deportiva_pilots (driver_profile_id uuid PK → driver_profiles, added_by, created_at)`. RLS on, readable and writable by admins only, explicit GRANTs (`service_role` always, per the GRANT rule).
3. `moto_deportiva_waitlist (user_id uuid PK → users ON DELETE CASCADE, created_at, notified_at)`. RLS: a user reads, inserts and deletes their own row. One row per person; after the push it stays, and `notified_at` is reset when the person taps "Avísame" again. Must be added to the account-deletion checks if any FK is not CASCADE.
4. The switch is `service_type_configs.is_active` of `moto_deportiva`. Changed only through `admin_set_moto_deportiva(p_active boolean)` (SECURITY DEFINER, `is_super_admin()`, one `admin_actions` row per change). A direct UPDATE by a client is already blocked by RLS on that table (verify).

### Dispatch

- `_vehicle_types_for_service`, `find_best_drivers` and `notify_offline_drivers_for_searching_rides`: `moto_deportiva` is handled **before** the `moto%` branch and only matches drivers listed in `moto_deportiva_pilots`. The offline-driver push is skipped for this service (pilots are told by the team, not by push).
- While `moto_deportiva` is active, drivers in `moto_deportiva_pilots` are excluded from every other service in `find_best_drivers` and in the offline push.
- Each change is an in-place patch of the live body with an md5 guard, as in 00669/00671, so no feature is lost.

### Status for the apps

`get_moto_deportiva_status()` (SECURITY DEFINER, `authenticated`; `anon` for the web landing if needed) returns one of:

| Value | When | Card shows |
|---|---|---|
| `off` | switch off | greyed out, "No disponible ahora", button "Avísame" / "Te avisaremos" |
| `offline` | switch on, no pilot online | "No disponible ahora" (cannot request) |
| `busy` | switch on, every online pilot has an active ride | "Ocupada · en un viaje" (cannot request) |
| `available` | switch on, at least one pilot online and free | normal card, can request |

It never returns positions or ids. The client refreshes it on focus (`useRefreshOnFocus`) and every 30 s while the service selector is open.

A ride request for `moto_deportiva` when the status is not `available` is rejected by a BEFORE INSERT trigger with DETAIL `moto_deportiva_unavailable` and a Spanish MESSAGE, so a stale screen cannot create a ride nobody can take.

### "Avísame" push

`admin_set_moto_deportiva(true)` sends, through `cron_http_post` to `send-push` (label `moto-deportiva-waitlist`, category `promo`), one push to every waitlist row with `notified_at IS NULL`, then sets `notified_at`. Text: "¡La Moto Deportiva está activa! Pídela ahora." A failure never blocks the switch; it is logged in `rpc_attempt_log`.

### Fallback to regular moto (client + web)

After 120 s searching with no driver on a `moto_deportiva` ride, the search screen shows "La Moto Deportiva no respondió. ¿Cambiar a Moto?" with the regular moto price. The tap calls `switch_my_ride_to_moto(p_ride_id)` (SECURITY DEFINER, `authenticated`): only the ride's customer, only while `searching`, only from `moto_deportiva` to `moto_standard`; it reuses `_apply_ride_service_change`, so the price, snapshot and offers are recomputed on the server. The passenger can also cancel, as today.

### Apps

- **Client and web:** new card in the service selector (position after "Moto"), the four states above, "Avísame", the fallback banner, and Moto Deportiva in history, receipts and the active ride view (label + image). i18n es/en/pt for real copy.
- **Driver:** the offer card and the active trip show a "Moto Deportiva" badge so the pilot knows.
- **Admin:** a "Moto Deportiva" section (super admin): the switch with its current state, the list of pilots (add/remove a driver), and the waitlist count. `rideType.ts` and ride filters learn the new label.

## Testing

- Migration rehearsal in `supabase/tests/00679/run.sh` (RED without the migration, GREEN applied twice, CRLF copy, negative tests of every self-check): a `moto_deportiva` ride is offered only to pilots; regular moto drivers never get it; a pilot gets no regular offers while it is on and does again when it is off; status values; insert rejected when not available; `switch_my_ride_to_moto` rules; only super admins can switch; waitlist push enqueued once.
- A rehearsal in prod inside a rolled-back block before applying, with the demo accounts.
- vitest for the status → card mapping and the 120 s fallback timer; `pnpm check-types`.

## Open items (block the launch, not the build)

1. **Price** (team): base, per km, per minute and minimum in USD for the 4 bands. Until then the migration carries placeholder values and the switch stays off.
2. **Marketing metrics** (team): which numbers they want (views of the card, "Avísame" taps, requests, completed rides). Not in this design until decided.
3. **Bike image** for the selection card (team).
4. **Pilot account:** the influencer must have an approved driver account with his bike registered as a moto.

## Rejected

- A new `vehicle_type` enum value for sports bikes: touches onboarding, documents, dispatch and several screens, for one pilot.
- Broadcasting a push to every user on activation: one pilot cannot serve that demand.
- Automatic switch-off at a chosen time: the owner prefers to switch it off by hand.
- In-app filming consent: the pilot asks in person.
