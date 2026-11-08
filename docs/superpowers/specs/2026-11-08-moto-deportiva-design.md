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
- **Visibility while off:** not decided yet by the team (always shown greyed out with "Avísame", or hidden until it is switched on). Built as a server setting, `platform_config.moto_deportiva_show_when_off` (default `true`), so the team can choose and change it without a release.
- **Image:** an illustration in the same style and colours as the current selection images (`apps/client/assets/vehicles/selection/*.png`, `apps/web/public/images/vehicles/*.png`), showing a generic sports bike in the Yamaha / Honda / Ducati style. No brand, logo or model name on it.

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
2. `moto_deportiva_pilots (driver_profile_id uuid PK → driver_profiles ON DELETE CASCADE, added_by, created_at)`. Lock table: RLS on, no policies, GRANT to `service_role` only. Super admins add a pilot by phone (`admin_add_moto_deportiva_pilot`, an approved driver with an active moto) and remove one (`admin_remove_moto_deportiva_pilot`); `admin_moto_deportiva_overview()` lists them.
3. `moto_deportiva_waitlist (user_id uuid PK → users ON DELETE CASCADE, created_at, notified_at)`. Lock table too; a user joins or leaves with `set_moto_deportiva_waitlist(p_join)`. Joining again resets `notified_at`. Both FKs cascade, so account deletion needs no change.
4. The switch is `service_type_configs.is_active` of `moto_deportiva`. The panel changes it through `admin_set_moto_deportiva(p_active boolean)` (SECURITY DEFINER, `is_super_admin()`, one `admin_actions` row per change). RLS already limits UPDATE of that table to super admins (`stc_super_admin_update`).
5. **Placeholder prices:** the migration copies the moto_standard config and its 4 bands with every USD column × 1.5, then runs `recompute_cup_from_usd_prices()`. When the team decides, a later migration writes the real USD values.

### Dispatch

- `_vehicle_types_for_service`, `find_best_drivers` and `notify_offline_drivers_for_searching_rides`: `moto_deportiva` is handled **before** the `moto%` branch and only matches drivers listed in `moto_deportiva_pilots`. The offline-driver push is skipped for this service (pilots are told by the team, not by push).
- While `moto_deportiva` is active, drivers in `moto_deportiva_pilots` are excluded from every other service in `find_best_drivers` and in the offline push.
- Each change is an in-place patch of the live body with an md5 guard, as in 00669/00671, so no feature is lost.

### Status for the apps

`get_moto_deportiva_status()` (SECURITY DEFINER, `authenticated`; `anon` for the web landing if needed) returns one of:

| Value | When | Card shows |
|---|---|---|
| `hidden` | switch off and `moto_deportiva_show_when_off = false` | no card at all |
| `off` | switch off and `moto_deportiva_show_when_off = true` | greyed out, "No disponible ahora", button "Avísame" / "Te avisaremos" |
| `offline` | switch on, no pilot online | "No disponible ahora" (cannot request) |
| `busy` | switch on, every online pilot has an active ride or is on a break, or a Moto Deportiva request is already searching (created in the last 150 s) | "Ocupada · en un viaje" (cannot request) |
| `available` | switch on, at least one pilot online and free | normal card, can request |

It never returns positions or ids. The client refreshes it on focus (`useRefreshOnFocus`) and every 30 s while the service selector is open.

A ride request for `moto_deportiva` when the status is not `available` is rejected by a BEFORE INSERT trigger with DETAIL `moto_deportiva_unavailable` and a Spanish MESSAGE, so a stale screen cannot create a ride nobody can take.

### "Avísame" push

Switching it on (an AFTER UPDATE trigger on `service_type_configs`, so it also fires when the switch is flipped from another screen) sends, in batches of 300 ids, through `cron_http_post` to `send-push` (label `moto-deportiva-waitlist`, category `promo`), one push to every waitlist row with `notified_at IS NULL`, then sets `notified_at`. Text: "¡La Moto Deportiva está activa! Pídela ahora." A failure never blocks the switch; it is logged in `rpc_attempt_log`.

### Fallback to regular moto (client + web)

After 120 s searching with no driver on a `moto_deportiva` ride, the search screen shows "La Moto Deportiva no respondió" with a "Cambiar a Moto" button. The tap cancels the ride (free while searching: no reputation event) and returns to the selection screen with the same addresses and Moto selected; the app estimates the moto price and the rider confirms it. Rejected: a server RPC that changes the ride's type in place, because the server has no fare calculator and would have to trust a fare sent by the client.

### Apps

- **Client and web:** new card in the service selector (position after "Moto"), the four states above, "Avísame", the fallback banner, and Moto Deportiva in history, receipts and the active ride view (label + image). i18n es/en/pt for real copy.
- **Driver:** the offer card and the active trip show a "Moto Deportiva" badge so the pilot knows.
- **Admin:** a "Moto Deportiva" section (super admin): the switch with its current state, the list of pilots (add/remove a driver), and the waitlist count. `rideType.ts` and ride filters learn the new label.

## Testing

- Migration rehearsal in `supabase/tests/00679/run.sh` (RED without the migration, GREEN applied twice, CRLF copy, negative tests of every self-check): a `moto_deportiva` ride is offered only to pilots; regular moto drivers never get it; a pilot gets no regular offers while it is on and does again when it is off; status values; insert rejected when not available; only super admins can switch; waitlist push enqueued once.
- A rehearsal in prod inside a rolled-back block before applying, with the demo accounts.
- vitest for the status → card mapping and the 120 s fallback timer; `pnpm check-types`.

Implementation plan: `docs/superpowers/plans/2026-11-08-moto-deportiva.md`.

## Open items (block the launch, not the build)

1. **Price** (team): base, per km, per minute and minimum in USD for the 4 bands. Until then the migration carries placeholder values and the switch stays off.
2. **Marketing metrics** (team): which numbers they want (views of the card, "Avísame" taps, requests, completed rides). Not in this design until decided.
3. **Visibility while off** (team): set `moto_deportiva_show_when_off` before the launch.
4. **Pilot account:** the influencer must have an approved driver account with his bike registered as a moto.

## Rejected

- A new `vehicle_type` enum value for sports bikes: touches onboarding, documents, dispatch and several screens, for one pilot.
- Broadcasting a push to every user on activation: one pilot cannot serve that demand.
- Automatic switch-off at a chosen time: the owner prefers to switch it off by hand.
- In-app filming consent: the pilot asks in person.
