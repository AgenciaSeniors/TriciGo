# Link fleet invitations to drivers who already have an account — design

**Date:** 2026-09-25 · **Status:** approved by the owner (3 decisions, then 3 more after code review, see § 2 and § 6)
**Scope:** migration 00598 (linking at approval, at signup and at phone confirmation, all on the OTP-confirmed number), its rehearsal and mutation check, doc comments in `fleet.service.ts`, a CLAUDE.md section.
**Out of scope (flagged separately):** `users.phone` writable without an OTP; the owner editing `fleet_members.driver_phone` after review (another session: 00600); `corporate_accounts.is_fleet_owner` never sticking for owner-created accounts (PR #1027 and a follow-up); the corporate fleet gate counting members that cannot drive (chip).

---

## 1. Context — what production says (read-only, 2026-09-25)

| Signal | Value |
|---|---|
| `fleet_members` / `driver_fleets` / `corporate_accounts` rows | 0 / 0 / 0 — nobody affected yet |
| Triggers on `fleet_members` | only `trg_fleet_members_protect` (BEFORE INSERT OR UPDATE) |
| Triggers on `public.users` that link fleet invitations | only `auto_link_fleet_member_on_signup`, **AFTER INSERT** |
| `relink_fleet_member_for_existing_driver` callers | `fleetService.relinkExistingDriver()`, which nothing in `apps/` calls |
| `fleetService.approveMember()` | sets `status = 'approved'`, `reviewed_*`; nothing else |
| `public.users.phone` | **writable by its owner without an OTP**: `authenticated` has column UPDATE, `users_update_own` allows it, `tg_users_protect_admin_fields` does not cover `phone`; no unique index (1 number shared by 2 accounts) |
| `auth.users.phone` | unique index `users_phone_key`; 544 rows, all `53XXXXXXXX` (E.164 without `+`), all with `phone_confirmed_at`; owned by `supabase_auth_admin`, `postgres` has TRIGGER on it |
| `public.users` with a phone | 546: **544 equal (normalized) to their confirmed auth phone**, 0 different, 2 with no auth phone (a super_admin and an admin seeded in March) |
| The one shared number | an admin (no auth phone) and an approved driver (confirmed) |
| `handle_new_user` | copies `NULLIF(auth.users.phone, '')` into `public.users.phone` whether or not the number is confirmed |
| GoTrue settings (`/auth/v1/settings`) | phone provider **on**, `phone_autoconfirm` **false**, SMS provider Twilio (does not reach Cuba) |
| Existing triggers on `auth.users` | `on_auth_user_created` (→ `handle_new_user`), `on_auth_user_email_change` (AFTER UPDATE OF email) |
| Postgres | 17.6 |

Reproduction (local Postgres 16, live bodies, RLS on, each step as `authenticated` with the caller's JWT): the admin approves an invitation for an existing driver → `approved`, `driver_id NULL`; the driver's `getMembershipsForDriver()` query returns 0 rows; saving the profile or approving again changes nothing. Controls: the relink RPC links when called; a signup after the approval links.

**Root cause.** Linking is evaluated from one side of the join only. The link condition is *invitation linkable* (`status IN ('approved','pending_signup') AND driver_id IS NULL`) ∧ *same normalized number as an account that owns it*. Only one of the events that can make it true runs the check: an account being created. The invitation becoming approved, and an existing account getting its number confirmed, never do. The admin RPC meant for the first case has no caller.

## 2. Decisions (owner, 2026-09-25)

1. **Where:** a database trigger at approval time, not the admin UI. It works for any approval path (panel, SQL editor, future tools) and is atomic with the approval. The admin panel cannot even show `FleetReview` today, so a UI-only fix could not be exercised.
2. **Who qualifies:** the one **active** account whose number is **confirmed by OTP in `auth.users`** (`phone_confirmed_at`). `public.users.phone` is not trusted. No driver-profile requirement, same as signup: a passenger-only account is linked now and is already in the fleet when it registers as a driver.
3. **Phone confirmed later:** also covered.

After code review (§ 6):

4. The "confirmed later" trigger lives on **`auth.users`**, not `public.users`.
5. The **signup** path applies the same rule: it links only a confirmed number.
6. Passenger-only accounts keep being linked; the corporate fleet gate that treats any linked member as "the fleet has drivers" is fixed separately (chip).

## 3. Design

### Units

**`public._user_id_by_verified_phone(p_phone text) → uuid`** — the id of the one active account whose OTP-confirmed number is `p_phone`, else NULL.
- Normalizes with `_normalize_cuban_phone`; anything that is not `+` and 8–15 digits after that returns NULL.
- Looks up `auth.users.phone IN (v_norm, substr(v_norm, 2))` (E.164 with or without `+`, which uses the unique index) with `phone_confirmed_at IS NOT NULL`, joined to `public.users` with `is_active`.
- Returns NULL unless exactly one row matches (never guesses).
- `SECURITY DEFINER` (reads `auth.users`), `STABLE`, pinned `search_path`. **EXECUTE revoked from PUBLIC, anon and authenticated**: it maps a number to an account.

**Approval — `trg_fleet_members_set_driver_on_approval`**, `BEFORE INSERT OR UPDATE OF status ON fleet_members`.
- Acts only when the write makes the invitation linkable: an INSERT with `status IN ('approved','pending_signup')` and no `driver_id`, or an UPDATE from any other status into those. A NULL status returns early, so the NOT NULL constraint rejects the write instead of the trigger turning it into a link.
- A row that was already linkable is not re-evaluated: a later edit of an approved invitation (possible for the owner until 00600 freezes the reviewed identity) links nobody here.
- On a match it sets `driver_id`, `status = 'active'`, `signed_up_at = COALESCE(signed_up_at, now())` on `NEW`; no second write, no trusted flag.
- Fires after `trg_fleet_members_protect` (same event and timing fire in trigger-name order). That is defence in depth: the protect trigger reverts every field this one sets for a non-admin, non-trusted write, whichever runs first.

**Signup — `auto_link_fleet_member_on_signup`** (same trigger, AFTER INSERT ON `public.users`).
- Adds the check `_user_id_by_verified_phone(NEW.phone) = NEW.id`. `verify-otp` creates accounts already confirmed, so the real flow is unchanged; GoTrue's own phone signup inserts the account before its OTP and is linked at confirmation instead.
- The link runs in a block that turns any error into a WARNING: it runs inside GoTrue's signup transaction (the 00595 incident class).

**Confirmation — `on_auth_user_phone_confirmed`** → `auto_link_fleet_member_on_phone_confirmed()`, `AFTER UPDATE OF phone, phone_confirmed_at ON auth.users`, `WHEN (NEW.phone IS NOT NULL AND NEW.phone <> '' AND NEW.phone_confirmed_at IS NOT NULL AND (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone))`.
- Fires only when a number becomes confirmed for the account (link-phone, verify-otp's heal, GoTrue's own OTP); re-confirming the same number does not count. Users cannot write `auth.users`.
- Links the account's approved invitations for that number, if `_user_id_by_verified_phone(NEW.phone) = NEW.id` (active, unambiguous).
- No trusted flag: GoTrue's connection carries no JWT, so the protect trigger lets it through.
- Error-contained like the signup path: it runs inside GoTrue's transaction, and a failure must never fail a login or a confirmation.

**Backfill** (same migration, idempotent): invitations already approved and unlinked whose number an active account has confirmed are linked once. 0 rows in prod.

**Migration mechanics:** `SET lock_timeout = '5s'`; `CREATE OR REPLACE TRIGGER` (no DROP, which would take ACCESS EXCLUSIVE); the trigger on `auth.users` is created last, after the self-test, so the lock it takes on that table lasts the shortest time. No trigger is created on `public.users`.

### Data flow

| Event | Before | After 00598 |
|---|---|---|
| verify-otp signup (account created confirmed) | linked | linked |
| GoTrue's own phone signup, before the OTP | **linked to an unconfirmed number** | nothing |
| …then the OTP confirms it | — | linked by `on_auth_user_phone_confirmed` |
| Admin approves an invitation for an existing confirmed account | stays `approved`, unlinked | linked in the same UPDATE |
| Admin/service inserts an invitation already `approved` | unlinked | linked on INSERT |
| An account confirms (or changes) its number via link-phone | nothing | its approved invitations are linked |
| Someone writes a number into their own `users.phone` without OTP, even away and back | nothing | nothing |
| Owner self-approves or re-points an approved invitation | reverted / no link | reverted / no link at approval (a later signup or confirmation of the new number still links: 00600) |
| An account that only has the number in `users.phone` (prod: 2 seeded admins) | — | not linked; the admin RPC remains the manual path |

Downstream nothing else changes: `find_best_drivers` / `accept_ride_v2` already treat `status = 'active' AND driver_id = user` as membership, and the driver app lists every fleet (#1022). The one downstream effect (a linked member who cannot drive switches the corporate fleet gate on) already existed through signup and is fixed separately (§ 5).

### Error handling

Linking never raises on a no-match: the helper returns NULL and the write goes through as before. The signup and confirmation paths swallow any error as a WARNING because they run inside GoTrue's transactions. The approval path stays loud: it is an admin write. The migration asserts its result instead of trusting `CREATE` (plpgsql bodies are only checked when they run): a rolled-back self-test against a real verified account checks that approval, signup and confirmation each link it, and `anon`/`authenticated` must not be able to execute the four functions, or the migration aborts. The negative cases (unverified, inactive, ambiguous numbers) are covered by the rehearsal, not by the self-test.

## 4. Testing

`supabase/tests/00598/run.sh` (local Postgres 16, live shapes and bodies including `handle_new_user`, RLS on, flows run as `authenticated` with a JWT like PostgREST, signup through an INSERT into `auth.users`):
- RED (`run.sh none`): 21 of 62 checks fail, each for its reason (approval does not link, confirmation does not link, signup links an unconfirmed number, a link failure breaks the signup, new objects missing); the controls pass.
- GREEN (`run.sh <migration>`): 68/68, applied twice (one transaction, then autocommit); the self-test leaves every row as it was; the backfill links only the row it should.
- Cases: A (approval: formats, two fleets, insert-approved, rejected→approved, the prod duplicate, unverified/inactive/unconfirmed/ambiguous not linked, re-approval of a row that lost its account, NULL status rejected), B (the owner cannot self-approve or re-point into a link), C (confirmation: link-phone, the app's mirror, a number written without OTP, someone else's number, the review's away-and-back toggle, GoTrue's own signup then OTP, re-confirmation, error containment, inactive), X (signup: confirmed links, unconfirmed does not, error containment), D (contract: ACLs, `SECURITY DEFINER`, pinned `search_path`, trigger order and definitions, no linking trigger on `public.users`, unchanged md5 of ten functions), N1–N4 (a defective copy is aborted by the migration's own assertions).
- `supabase/tests/00598/mutants.py`: 11 guards the self-test does not cover, removed one at a time; each must make its own test fail.

## 5. Out of scope, flagged

- **`public.users.phone` is writable without an OTP** (chip, running in another session). This design does not rely on it.
- **The owner can edit `driver_phone` after approval.** The approval trigger does not link a re-pointed row, but a later OTP-confirmed signup or confirmation of the new number does. Another session is freezing the reviewed identity in `tg_fleet_members_protect` (00600).
- **`is_fleet_owner` never becomes true for owner-created accounts** (00434 forces false on INSERT, 00418 reverts the owner's UPDATE), so `FleetReview` never renders. PR #1027 stops relying on the flag for the owner; the admin side is a follow-up.
- **The corporate fleet gate** (`find_best_drivers` / `accept_ride_v2`) switches on with any linked member, including one without an approved driver profile (chip).

## 6. Changes after code review (2026-09-25)

The first version put the "confirmed later" trigger on `public.users` (AFTER UPDATE OF phone, linking when `auth.users` confirmed the new value for that account). Review found, and the rehearsal reproduced, that it could be fired without any new confirmation: an account that has number X confirmed sets its `users.phone` to something else and back, and the trigger runs again. Combined with an owner re-pointing an approved invitation at X, that linked the account with no admin review. The owner chose to move the trigger to `auth.users`, which users cannot write (decision 4). Review also found:
- the signup path linked whatever number GoTrue copied, confirmed or not (decision 5);
- both GoTrue-side paths could fail a login or a signup on a linking error (now contained);
- a NULL status slipped through the approval gate (now rejected);
- the self-test's account filter could pick a number the normalizer does not accept (`^53[56]`);
- DROP + CREATE TRIGGER took ACCESS EXCLUSIVE locks (now `CREATE OR REPLACE TRIGGER`, `lock_timeout`, auth trigger last);
- passenger-only links switch the corporate gate on (decision 6, chip).

Checked and kept: `phone_autoconfirm` is false in prod, so `phone_confirmed_at` does prove possession.
