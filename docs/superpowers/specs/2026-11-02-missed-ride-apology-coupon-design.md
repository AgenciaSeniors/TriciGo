# Missed-ride outreach: an apology coupon for people who got no driver

Date: 2026-11-02. Status: design approved by the owner; not implemented. Migration number 00674 (next free on 2026-11-02: master ends at 00673, open PRs hold 00569 and 00662). Check master and every open PR again before writing it.

## Problem

Many requests die without a driver. Measured in prod on 2026-11-02: 225 passenger rides were canceled with no driver assigned, from 96 people. 155 of those rides had waited 60 s or more, from 71 people, 30 of them in the last 30 days. Almost nobody in that group completed a ride afterwards.

Support wants to write to each of these people, apologise and give them a discount on their next ride. Push reaches only 32 people and e-mail 14, so the channel is WhatsApp, one person at a time, from the operator's own phone.

## Decisions (owner, 2026-11-02)

- **Channel:** operators write one by one by WhatsApp, from a list in the panel with a prefilled message, and the panel records who was contacted.
- **Coupon:** personal. It applies on its own on the next ride, and nobody else can use it, not even by typing its code. It must work with the apps already installed.
- **Who is listed:** people with a ride canceled without a driver and no completed ride since, with a 30 days / 90 days / everything filter.
- **How many:** one apology coupon per confirmed phone, ever (the 00658 rule for one-time bonuses).

## Approach

One shared "apology" promotion, created by an admin or marketing in Promociones and marked as grant-only, plus one grant row per person. Rejected: a promotion row per person (fills Promociones with dozens of rows and still needs a new column to stop strangers from typing the code).

## Current behaviour this builds on

- `tg_rides_validate_promo_discount` (trigger `rides_validate_promo_discount`, BEFORE INSERT OR UPDATE on `rides`, SECURITY DEFINER, live md5 `cad4cf62…`, 9664 chars) checks an attached promotion (active, dates, `first_ride_only`), claims the phone with `_claim_reward(customer, 'promo:<id>', ride)`, inserts `promotion_uses` and takes a use. Any failure drops the promotion without an error. Since 00631 a client UPDATE cannot change `promo_code_id`.
- `tg_rides_signup_promo` (00665, SECURITY INVOKER) fills in the signup-code promotion when the client sent no code; `get_my_signup_promotion()` (md5 `b4209984…`) lets the apps prefill and auto-validate it. Installed apps (client 1.8.0 by OTA, the web) already call it.
- `validate_promo_code(code, user, fare)` (md5 `95280581…`) is what the apps call to preview a typed code.
- BEFORE INSERT triggers on `rides`, in name order: `rides_enforce_active_city`, `rides_normalize_scheduling`, `rides_scheduled_limit`, `rides_signup_promo`, `rides_sync_coords_trg`, `rides_validate_promo_discount`, then the `trg_…` ones.
- `_claim_reward(user, claim, ride, referral)` returns `claimed`, `taken` or `no_phone`; rows in `reward_claims` survive account deletion.
- `get_active_promotions` only lists `is_public` promotions. `tg_promotions_marketing_guard` lets marketing create and pause promotions without approval (00666). `promotion_is_referenced` (md5 `c0a5cd8f…`) blocks deleting a used promotion.
- The operator role (00668–00673): `is_ops_staff()`, `self_action` refusals, state-bound actions, one `admin_actions` row per action, capabilities in `packages/utils/src/adminPanelAccess.ts`.

## Design

### 1. Data

- `promotions.grant_only boolean NOT NULL DEFAULT false`, with `CHECK (NOT (grant_only AND COALESCE(is_public, true)))`: a grant-only promotion is never public. Existing rows pass (all `false`).
- `promotion_grants` (lock table: RLS on, no policies, GRANT only to `service_role`):
  - `id uuid PK DEFAULT gen_random_uuid()`, `promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT`, `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `granted_by uuid NOT NULL`, `granted_at timestamptz NOT NULL DEFAULT now()`, `source text NOT NULL CHECK (source = 'missed_ride')`.
  - `UNIQUE (user_id, source)`: one apology coupon per account. The phone rule is the claim below.
- `missed_ride_contacts` (lock table, same grants): `id uuid PK`, `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `contacted_by uuid NOT NULL`, `contacted_at timestamptz NOT NULL DEFAULT now()`, `last_failed_ride_id uuid`, `grant_id uuid REFERENCES promotion_grants(id) ON DELETE SET NULL`. Index on `(user_id, contacted_at DESC)`.
- `granted_by` and `contacted_by` have no foreign key, like `ride_dispute_escalations` (00673), so deleting a team account is never blocked. `user_id` cascades: a deleted account loses its grant, and its phone keeps the `reward_claims` row, so it cannot get a second coupon.
- A promotion someone holds cannot be deleted: `ON DELETE RESTRICT` refuses (23503). It is retired by pausing it. `promotion_is_referenced` is not patched, so marketing sees the database error instead of the 00666 message; deleting a held coupon is rare enough.

### 2. Who counts as "no driver"

A failed request is a ride with `status = 'canceled'`, `driver_id IS NULL`, `COALESCE(ride_mode, 'passenger') = 'passenger'`, that waited at least `support_alert_after_s` (60 s): `canceled_at − GREATEST(created_at, COALESCE(scheduled_at, created_at))`. The 60 s keep out people who canceled seconds after asking because they picked the wrong place.

A person is in the segment when their latest failed request has no completed ride (as customer) after it, their account is active, it is not a test account, not a team account (`admin`, `super_admin`, `marketing`, `operator`) and not a system account (`…0001`, `…0099`). Drivers who also ride as passengers count.

### 3. The list: `admin_missed_riders(p_view text, p_days int)`

Read functions of the panel are named `admin_*`; the 00673 self-check requires every `ops_*` function to write `admin_actions`, and a list writes nothing. The segment and the last failure come from one helper, `_missed_rider_summary(p_user_id uuid DEFAULT NULL)` (SECURITY DEFINER, no EXECUTE for clients), that the contact function also uses.

SECURITY DEFINER, `search_path = public, pg_catalog`, EXECUTE for `authenticated` and `service_role`. A caller who is not ops staff gets `42501` with a Spanish MESSAGE and DETAIL `forbidden` (a set-returning function cannot answer with an `{error}` object).

- `p_view = 'pending'`: people in the segment never contacted, whose latest failure is within `p_days` (NULL = everything), newest first.
- `p_view = 'contacted'`: everyone with a contact row whose latest contact is within `p_days`, newest contact first, whether or not they are still in the segment. This is where results show.
- Columns: `user_id`, `full_name`, `phone` (the confirmed phone from `auth.users`, digits without `+`, or NULL), `failed_requests` (all time), `in_segment`, `last_failed_at`, `last_failed_ride_id`, `last_pickup`, `last_dropoff`, `last_contacted_at`, `last_contacted_by` (name), `contacts` (count), `coupon_status` (`none`, `granted`, `used`, `unusable`), `coupon_code`, `phone_already_rewarded` (the phone holds an apology claim from another account), `rode_after_contact` (a completed ride after the first contact).
- `coupon_status`: `used` when `promotion_uses` has the grant's promotion for that user; `unusable` when the promotion is paused, expired or out of uses; otherwise `granted`.
- At most 500 rows.

The coupon in use comes from `_missed_ride_current_coupon()` (the newest active grant-only promotion inside its dates with uses left). `admin_missed_ride_coupon()` (ops staff, SECURITY DEFINER) returns it as jsonb for the page header, so the header and the grant always pick the same one.

### 4. Contacting someone: `ops_contact_missed_rider(p_user_id uuid, p_expected_last_failed_at timestamptz)`

SECURITY DEFINER, same grants. In order:

1. `is_ops_staff()` or `forbidden`; the target is not the caller (`self_action`).
2. Lock the target's `users` row (`FOR NO KEY UPDATE`, the team-function order) so two operators clicking at once give one coupon.
3. The target is in the segment (§2) right now (`not_eligible` otherwise), so someone in "Contactados" who rode since cannot be written to again from this page. Its latest failure time equals `p_expected_last_failed_at` (`missed_rider_changed` otherwise, and the panel reloads).
4. A confirmed phone exists (`no_phone` otherwise; nothing is recorded).
5. Coupon, when the person has no grant yet: `_missed_ride_current_coupon()`. None → no coupon, reason `no_coupon_available`. Otherwise `_claim_reward(user, 'missed_ride_coupon', NULL, NULL)`: `claimed` → insert the grant; `taken` → no coupon, reason `already_given` (the phone got one before, from any account). A person who already has a grant gets it back when it still works, or reason `coupon_used` / `coupon_unusable`.
6. Insert the contact row (with the grant, new or existing) and one `admin_actions` row (`missed_rider_contacted`, target `user`, new values: grant id, promotion code, failed ride id).
7. Return `{success, phone, first_name, last_failed_at, coupon: {code, type, discount_percent, discount_fixed_cup, valid_until} | null, coupon_reason}`. A person who already holds a usable grant gets that coupon back, so a second message mentions it.

Refusals are `{error, …}` objects, as in 00671–00673.

### 5. Applying the coupon on the next ride

- `_my_granted_promotion_id()`: SECURITY DEFINER, no arguments, the `promotion_id` of `auth.uid()`'s grant, only while the validator would accept it now (active, dates, uses, not used by this account, the phone's `promo:<id>` claim free, `first_ride_only`). EXECUTE for `authenticated` and `service_role`. Returning a used coupon would make the trigger attach it, the validator drop it, and the signup promotion (whose trigger sees a code already set) never apply again.
- `tg_rides_promo_grant()`: SECURITY INVOKER, trigger `rides_promo_grant` BEFORE INSERT on `rides`. Its name sorts after `rides_normalize_scheduling` and before `rides_signup_promo` and `rides_validate_promo_discount`. It sets `NEW.promo_code_id` to the granted promotion under the same five conditions as `tg_rides_signup_promo` (client insert, own ride, no typed code, passenger ride, not paid by a company, caller not an admin). It never raises. The migration checks the trigger order and aborts if it is wrong.
- Validator patch (in place, from md5 `cad4cf62…`): a `grant_only` promotion is dropped, like an invalid one, when the customer has no grant for it. Everything else (once per phone through `promo:<id>`, uses, dates, partner discounts) stays as it is, so a used coupon cannot be used again and a canceled ride gives it back.
- `validate_promo_code` patch (from md5 `95280581…`): a `grant_only` promotion answers `invalid` to anyone without a grant, so the code reveals nothing.
- `get_my_signup_promotion` patch (from md5 `b4209984…`): returns the granted promotion first, when the validator would accept it now, with the same columns; `signup_code` carries the promotion's own code. The apps then prefill and auto-validate it exactly as they do the signup promotion, and show "Descuento de tu código PERDON: 500 CUP". When a person has both, the coupon goes first and the signup promotion stays for a later ride, in the trigger and in the prefill alike.

### 6. Panel

- **Promociones:** the create form gains the "Cupón de disculpa" checkbox ("Solo lo usa quien lo recibe de soporte desde Sin chofer. No se publica."), which also sends `is_public = false`. The list shows a "Disculpa" badge. `Promotion` gains `grant_only`, sent only on create and only when set; `promotionService.create` never strips it on its column-missing retry. The checkbox can't be changed after creation.
- **New page `/missed-rides`** ("Sin chofer" in the menu), for ops staff: new capability `riders.outreach` (admins have it implicitly; added to `OPERATOR_CAPABILITIES`) and `/missed-rides` added to `OPERATOR_ROUTES`. Marketing does not get it.
  - Header: the coupon in use (code, amount, expiry, uses left), or "No hay cupón de disculpa activo: créalo en Promociones" with a link.
  - Tabs "Por contactar" and "Contactados", filter 30 / 90 días / todo.
  - Each row: name, phone, failed requests, last failure (Havana time, with pickup and drop-off), status. "Escribir por WhatsApp" opens the tab on the click itself (so the browser does not block it), calls `ops_contact_missed_rider` and then loads `https://wa.me/<phone>?text=<message>`; on a refusal it closes the tab and shows the reason. Without a confirmed phone the button is disabled and says why.
- `missedRideService` (`packages/api`) wraps the two functions through `callOpsRpc` and maps refusals to `AppError` with the server's code; texts in `ops_errors.*` (es/en/pt).
- The message is built by a pure function in `@tricigo/utils` (`missedRideApologyMessage`), with tuteo, the first name only, the date in Cuba's clock (`cubaTimeZone`) and the discount formatted with `formatCUP` or as a percentage, with unit tests. The URL is the existing `waMeLink` (`driverOutreach.ts`, used by `/incomplete-drivers`). Message:
  > Hola, {nombre}. Te escribimos de TriciGo. El {fecha} pediste un viaje y no conseguimos conductor. Lo sentimos mucho. Te dejamos {500 CUP / un 25 %} de descuento en tu próximo viaje. Ya está cargado en tu cuenta, no tienes que escribir ningún código.{ Vale hasta el {fecha}.}

  Without a coupon, the message stops after "Lo sentimos mucho." and ends with "Esperamos verte pronto en TriciGo."

## Error handling

- Every refusal comes back as `{error}`; the panel shows the Spanish text and reloads on `missed_rider_changed`.
- A grant whose promotion is paused or expired stays `unusable`, and that phone cannot get another apology coupon (known limitation, see below).
- The ride trigger never blocks a ride; any lookup error leaves the ride without the coupon.

## Testing

- Rehearsal `supabase/tests/00674/run.sh` with the live bodies of the three patched functions, `tg_rides_signup_promo`, `_claim_reward` and the promotions guard. RED without the migration; GREEN applied twice and from a CRLF copy, with a negative proof of every self-check (trigger order, md5 guards, grants on the new tables, the full list of functions allowed to call `is_ops_staff`). Cases:
  - the segment: 60 s threshold, passenger rides only, completed ride after the failure, test, team and blocked accounts;
  - contacting gives one coupon; a second contact gives none and returns the same coupon; a second grant row for the same account is refused by the unique key (the function also locks the person's `users` row);
  - same phone on a new account after deleting the first: no second coupon (`already_given`);
  - no active coupon, no phone, `self_action`, `forbidden` for a passenger and for marketing, `missed_rider_changed`;
  - the next ride gets the discount; a typed code wins; delivery and company rides do not get it; a canceled ride gives it back; a used coupon does not apply again;
  - another account typing the code: `validate_promo_code` says `invalid` and the ride gets no discount;
  - `get_my_signup_promotion` returns the coupon first, and nothing once used;
  - a grant-only promotion cannot be public; a held promotion cannot be deleted.
- Prod rehearsal in a block that rolls back, with the demo passenger as the person, the test passenger as operator and a coupon created in the block.
- Vitest: the message and the link, `missedRideService`, `promotionService.create` keeping `grant_only`, `panelCan` for the new capability.

## Rollout (each step with the owner's OK)

1. Apply 00674.
2. Merge (deploys the panel). No app build or OTA: installed apps already prefill through `get_my_signup_promotion`, and the server applies the coupon anyway.
3. An admin or marketing creates the coupon in Promociones. Recommended: a fixed amount (500 CUP) rather than a percentage, since the platform pays the discount and a percentage has no ceiling on a long ride, and `max_uses` as the budget (70 people × 500 CUP = 35 000 CUP at most).
4. Update the operator guide (Claude Docs `ecb6f3ab…`) and CLAUDE.md.

## Known limitations

- A coupon whose promotion is paused or expires before use is lost, and that phone cannot get another one.
- If the destination is a partner place with a larger discount, the partner discount wins and the coupon's use is still taken, as with any promotion (00559).
- The installed apps label it "Descuento de tu código …"; a later build can name it as an apology coupon.

## Out of scope

- Writing by push, SMS or e-mail, or to everyone at once.
- Coupons for other reasons (complaints, long waits).
- Measuring beyond `rode_after_contact` and `coupon_status`.
