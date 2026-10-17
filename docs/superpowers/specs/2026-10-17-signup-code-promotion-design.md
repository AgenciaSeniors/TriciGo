# Signup code promotions: a discount that comes with the invite code

Date: 2026-10-17. Status: approved design, not implemented.

## Problem

Marketing gives each influencer and channel a signup code (MOTORENKO, BOLSAS-VEDADO). People type it in "Código de invitación (opcional)" when they register, and the code only records where they came from (`users.signup_code`, migration 00619). It pays nothing.

To also give the new user a discount, today marketing needs a promotion with the same name, and the person has to type the code a second time when booking a ride (or open `tricigo.com/promo/<code>`). Many people will not do the second step.

Goal: a person who registered with a code that has a promotion linked gets that promotion on their next ride without typing anything.

## Decisions (owner, 2026-10-17)

- **Delivery:** the server applies the promotion now, for every app version and the web. The apps show it before booking in a later step (an OTA for the passenger app).
- **Who links:** marketing (and admins) link a promotion when creating or editing a code. The discount applies only while that promotion is active, and activating a promotion is still an admin decision. Linking an already active promotion takes effect immediately.
- **People who registered before the link:** they get it too. The server looks the link up when the ride is created, not at signup.
- **Approach:** a small trigger that only fills in the promotion, before the existing validator. The discount function itself is not changed.

## Current behaviour this builds on

- `acquisition_codes` (00619): `code` (PK), `label`, `channel`, `audience`, `is_active`, `notes`, `created_by`. Marketing has full access through `acquisition_codes_all_marketing` (00642). `users.signup_code` references `acquisition_codes(code)` and only `apply_signup_code` writes it.
- `promotions`: `is_active`, `valid_from`, `valid_until`, `max_uses`, `current_uses`, `first_ride_only`, `pending_approval`. A promotion marketing creates is inactive until an admin approves it (00642).
- `tg_rides_validate_promo_discount` (trigger `rides_validate_promo_discount`, BEFORE INSERT OR UPDATE on `rides`, live md5 `cad4cf62…`, 9664 chars): on INSERT with `promo_code_id` it re-checks that the promotion is active, inside its dates and, if `first_ride_only`, that the customer has no completed ride. It then claims the phone (`_claim_reward`, 00658), inserts `promotion_uses` and takes a use from `current_uses`. Any failure clears `promo_code_id` without an error. It recomputes `discount_amount_cup` itself. It does not look at `ride_mode` or `corporate_account_id` for promotions.
- BEFORE INSERT triggers on `rides` fire in name order: `rides_enforce_active_city`, `rides_normalize_scheduling`, `rides_scheduled_limit`, `rides_sync_coords_trg`, `rides_validate_promo_discount`, then the `trg_…` ones.
- `_reward_claim_status(user, claim)` returns `no_phone`, `taken` or `free`.
- The passenger apps show "Descuento aplicado: −X" on the ride-complete screen and in the ride detail when `discount_amount_cup > 0`.

## Design

### 1. Data

`acquisition_codes.promotion_id uuid NULL REFERENCES promotions(id) ON DELETE SET NULL`.

A code links to at most one promotion. A promotion can be linked to many codes. No new table, so no new GRANT is needed for a table; the column inherits the table's policies.

### 2. Applying it when a ride is created

New function `tg_rides_signup_promo()` (SECURITY DEFINER, `search_path = public, pg_catalog`), trigger `rides_signup_promo` BEFORE INSERT on `rides`. Its name sorts before `rides_validate_promo_discount`, so it runs first.

It sets `NEW.promo_code_id` to the linked promotion only when all of these hold:

1. The insert comes from a client: `current_user IN ('anon', 'authenticated')`, `auth.uid() IS NOT NULL`, and the caller is not an admin. Inserts by SECURITY DEFINER functions (recurring rides, support), the cron and the service role are left alone.
2. `NEW.customer_id = auth.uid()`.
3. `NEW.promo_code_id IS NULL`: a code the person typed always wins.
4. `COALESCE(NEW.ride_mode, 'passenger') = 'passenger'` and `NEW.corporate_account_id IS NULL`: deliveries and rides a company pays do not spend the welcome discount.
5. The customer's `users.signup_code` points to a code with a non-null `promotion_id`. The code's own `is_active` does not matter: it only controls whether new people can register with it.

It does nothing else. Every eligibility rule stays in the validator, which runs next: active, dates, `first_ride_only`, once per confirmed phone, `max_uses`. When a rule fails, the ride is created without a discount, as with a typed code.

The function never raises. A failure to look up the link leaves the ride as it was.

Price: the ride keeps the fare the passenger agreed to (`estimated_fare_cup`); the discount is subtracted at completion, as with any promotion. It can only lower what the person pays.

The migration checks that `rides_signup_promo` fires before `rides_validate_promo_discount` (both BEFORE INSERT, row level, enabled) and aborts otherwise.

### 3. `get_my_signup_promotion()`

SECURITY DEFINER, `STABLE`, no arguments, EXECUTE for `authenticated` and `service_role` only. Returns one row or none for `auth.uid()`:

`code text, type text, discount_percent numeric, discount_fixed_cup int, first_ride_only boolean, valid_until timestamptz, signup_code text`

It returns the linked promotion only if the validator would accept it now:

- active, `valid_from` passed (or null), `valid_until` not passed (or null);
- `current_uses < max_uses` when `max_uses` is set;
- no `promotion_uses` row for this user and promotion;
- `_reward_claim_status(user, 'promo:' || id)` is `free`;
- if `first_ride_only`, no completed ride as customer.

The apps use it to show the discount before booking. It reveals nothing beyond what the person can already learn by typing the code.

### 4. Measuring it

`admin_signup_code_stats()` gains two columns at the end:

- `promotion_code text`: the code of the linked promotion, or null.
- `promo_rides bigint`: completed rides with `promo_code_id` = the linked promotion by users registered with that code.

Adding columns changes the return type, so the migration does `DROP FUNCTION` and `CREATE FUNCTION` in the same transaction. It starts from the live body (which has the 00642 admin-or-marketing gate) and restores the same EXECUTE grants.

### 5. Admin panel (`/code-performance`)

- Create form: an optional "Promoción" select listing promotions with their discount and status (activa, pendiente de aprobación, pausada).
- Each row: a "Promoción" column with the linked code and a way to link, change or unlink it. When the linked promotion is not active, the cell says it does not apply yet.
- A "Usaron el descuento" column from `promo_rides`.
- `acquisitionCodeService.create` accepts `promotionId`; a new `setPromotion(code, promotionId | null)` updates the link. Both convert database errors to `AppError` with a Spanish message, as `create` does today.
- No new permissions: marketing already writes `acquisition_codes` and reads `promotions`.

### 6. Passenger app and web (later step)

- `rideService.getMySignupPromotion()` calls the RPC and returns null on any error, including `PGRST202` (function missing).
- Client app booking: when the store has no promo code, it loads the signup promotion once per session, puts the code in `useRideStore.promoCode` and validates it automatically as soon as there is a fare, so the discounted price shows before "Pedir". The label names the code ("Descuento de tu código MOTORENKO").
- There is no button to remove it: the server would apply it again. Typing another code replaces it.
- Web `/book`: the same, after its existing `?promo=` and sessionStorage prefills (a code from a link wins).
- JavaScript only, so the client part can ship by OTA to runtime 1.8.0.
- The driver app does not change.

## Testing

Migration 00665 (the next free number on 2026-10-17: 00662 is reserved by #1160; check master and the open PRs again before writing it). SQL rehearsal `supabase/tests/00665/run.sh`, RED without the migration and GREEN with it applied twice and from a CRLF copy:

- applied: client insert, linked active promotion, no typed code → `promo_code_id` set, `discount_amount_cup > 0`, `promotion_uses` row, phone claimed;
- a typed promotion wins over the linked one;
- no link, or a code without `promotion_id` → nothing;
- promotion pending approval, paused, not started or expired → no discount, ride created;
- phone already used the promotion (also from a deleted account, 00658) → no discount;
- `first_ride_only` with a previous completed ride → no discount;
- delivery (`ride_mode` not passenger) and corporate ride → no discount;
- insert by an admin, by a SECURITY DEFINER function and with no JWT → no change;
- user registered before the link → gets it;
- deleting the promotion clears the link;
- `get_my_signup_promotion()` returns the row exactly when the trigger would apply it, and nothing for `anon`;
- `admin_signup_code_stats()` counts `promo_rides`, keeps its gate (admin or marketing; a passenger gets nothing);
- trigger order: passes, and a negative proof (rename so it fires after the validator) makes the migration abort.

Vitest: `acquisitionCodeService.create` / `setPromotion`, `rideService.getMySignupPromotion` (including the missing-function fallback), and the prefill logic as a pure function. Panel checked in the browser.

## Rollout (each step with the owner's OK)

1. Apply the migration. From then on the discount applies to every app version and the web, and the stats show the new columns.
2. Merge. The admin deploy lets marketing link promotions; the web deploy shows the discount before booking.
3. Client OTA to 1.8.0 so the app shows it before booking.
4. Update the marketing message (Promociones section) and CLAUDE.md.

## Out of scope

- A home banner like "Tienes 20 % en tu primer viaje". It can be added later.
- Linking more than one promotion to a code.
- Discounts for drivers.
