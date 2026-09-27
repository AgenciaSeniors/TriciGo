# Link fleet invitations to drivers who already have an account — design

**Date:** 2026-09-25 · **Status:** approved by the owner (3 decisions, then 3 more after the first code review, see § 2 and § 6)
**Scope:** migration 00598 (linking at approval, at signup and at phone confirmation, all on the OTP-confirmed number), its rehearsal and mutation check, doc comments in `fleet.service.ts`, a CLAUDE.md section.
**Out of scope (flagged separately):**
- `users.phone` writable without an OTP.
- The owner editing `fleet_members.driver_phone` after review (another session: 00600).
- `corporate_accounts.is_fleet_owner` never sticking for owner-created accounts (PR #1027 and a follow-up).
- The corporate fleet gate counting members that cannot drive (chip).
- Watching `phone_autoconfirm` (chip).

---

## 1. Context — what production says (read-only, 2026-09-25)

| Signal | Value |
|---|---|
| `fleet_members` / `driver_fleets` / `corporate_accounts` rows | 0 / 0 / 0 — nobody affected yet |
| Triggers on `fleet_members` | only `trg_fleet_members_protect` (BEFORE INSERT OR UPDATE) |
| Triggers on `public.users` that link fleet invitations | only `auto_link_fleet_member_on_signup`, **AFTER INSERT** |
| `relink_fleet_member_for_existing_driver` callers | `fleetService.relinkExistingDriver()`, which nothing in `apps/` calls |
| `fleetService.approveMember()` | sets `status = 'approved'`, `reviewed_*`; nothing else |
| `public.users.phone` | **writable by its owner without an OTP**: `authenticated` has column UPDATE, `users_update_own` allows it, `tg_users_protect_admin_fields` does not cover `phone`. No unique index (1 number shared by 2 accounts). |
| `auth.users.phone` | unique index `users_phone_key`; 544 rows, all `53XXXXXXXX` (E.164 without `+`), all with `phone_confirmed_at`. Owned by `supabase_auth_admin`; `postgres` has TRIGGER on it. |
| `public.users` with a phone | 546: **544 equal (normalized) to their confirmed auth phone**, 0 different, 2 with no auth phone (a super_admin and an admin seeded in March) |
| The one shared number | an admin (no auth phone) and an approved driver (confirmed) |
| `handle_new_user` | copies `NULLIF(auth.users.phone, '')` into `public.users.phone` whether or not the number is confirmed |
| GoTrue settings (`/auth/v1/settings`) | phone provider **on**, `phone_autoconfirm` **false**, SMS provider Twilio (does not reach Cuba) |
| GoTrue admin API (`supabase/auth` master, `internal/api/admin.go`) | `createUser` INSERTs the account, then `ConfirmPhone` UPDATEs `phone_confirmed_at`. `updateUserById` runs `ConfirmPhone` before `SetPhone`. |
| Existing triggers on `auth.users` | `on_auth_user_created` (→ `handle_new_user`), `on_auth_user_email_change` (AFTER UPDATE OF email) |
| `log_rpc_attempt` / `rpc_attempt_log` | forensic log, `log_rpc_attempt` never raises |
| Postgres | 17.6 |

Reproduction (local Postgres 16, live bodies, RLS on, each step as `authenticated` with the caller's JWT):
- The admin approves an invitation for an existing driver → `approved`, `driver_id NULL`.
- The driver's `getMembershipsForDriver()` query returns 0 rows.
- Saving the profile or approving again changes nothing.
- Controls: the relink RPC links when called, and a signup after the approval links.

**Root cause.** Linking is evaluated from one side of the join only. The link condition is *invitation linkable* (`status IN ('approved','pending_signup') AND driver_id IS NULL`) ∧ *same normalized number as an account that owns it*. Only one of the events that can make it true runs the check: an account being created. Two others never do: the invitation becoming approved, and an existing account getting its number confirmed. The admin RPC meant for the first case has no caller.

## 2. Decisions (owner, 2026-09-25)

1. **Where:** a database trigger at approval time, not the admin UI. It works for any approval path (panel, SQL editor, future tools) and is atomic with the approval. The admin panel cannot even show `FleetReview` today, so a UI-only fix could not be exercised.
2. **Who qualifies:** the one **active** account whose number is **confirmed by OTP in `auth.users`** (`phone_confirmed_at`). `public.users.phone` is not trusted. No driver-profile requirement, same as signup: a passenger-only account is linked now, and it is already in the fleet when it registers as a driver.
3. **Phone confirmed later:** also covered.

After the first code review (§ 6):

4. The "confirmed later" trigger lives on **`auth.users`**, not `public.users`.
5. The **signup** path applies the same rule: it links only a confirmed number.
6. Passenger-only accounts keep being linked. The corporate fleet gate treats any linked member as "the fleet has drivers"; that is fixed separately (chip).

## 3. Design

### Units

**`public._user_id_by_verified_phone(p_phone text) → uuid`** — the id of the one active account whose OTP-confirmed number is `p_phone`, else NULL.
- Normalizes with `_normalize_cuban_phone`. Anything that is not `+` followed by 8–15 digits after that returns NULL.
- Looks up `auth.users.phone IN (v_norm, substr(v_norm, 2))`, E.164 with or without `+`, which uses the unique index. Requires `phone_confirmed_at IS NOT NULL`, and joins to `public.users` with `is_active`.
- Returns NULL unless exactly one row matches (never guesses).
- `SECURITY DEFINER` (it reads `auth.users`), `STABLE`, pinned `search_path`. **EXECUTE is revoked from PUBLIC, anon and authenticated**, because it maps a number to an account.

**Confirmation — `on_auth_user_phone_confirmed`** → `auto_link_fleet_member_on_phone_confirmed()`, `AFTER UPDATE ON auth.users`.
- **Where accounts get linked in practice.** `createUser` inserts first and confirms in a second UPDATE. `updateUserById` confirms first and sets the phone after (`link-phone`, `verify-otp`'s heal).
- **When it acts.** Only when a number becomes confirmed for the account: its first confirmation, or a new number on an account already confirmed. The check is `NEW.phone` present, `NEW.phone_confirmed_at` set, and `OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone`. It is written inside the function, and no part of it can be NULL. Re-confirming the same number does not count.
- **No column list, no WHEN.** Those would stop GoTrue from altering `phone` or `phone_confirmed_at`. The function returns at once for any other update of `auth.users`.
- **What it links.** The account's `approved`/`pending_signup` invitations without a `driver_id` for that number, when `_user_id_by_verified_phone` says the number is this account's (active, unambiguous). It restores the `+` GoTrue drops (numbers outside Cuba).
- **No trusted flag.** GoTrue's connection carries no JWT, so the protect trigger lets the write through. If a JWT were ever present, the protect trigger would revert the link: it fails closed.
- **Errors contained.** It runs inside GoTrue's transaction, so a failure to link must never fail a login or a confirmation. `SET lock_timeout TO '2s'` in the definition turns a lock wait into a caught error; `query_canceled` is not caught by `WHEN OTHERS`. A failure becomes a WARNING plus a `rpc_attempt_log` row (`outcome = 'link_failed'`).
- **Kill switch.** `postgres` does not own `auth.users` and cannot drop or disable a trigger on it. To switch it off, replace the function body with `RETURN NEW`.

**Signup — `auto_link_fleet_member_on_signup`** (same trigger, AFTER INSERT ON `public.users`).
- Adds the check `_user_id_by_verified_phone('+' || ltrim(NEW.phone, '+')) = NEW.id`.
- Since GoTrue inserts before it confirms, it only links an account inserted already confirmed. Its job is to stop a signup from linking a number that is not confirmed yet: GoTrue's own phone signup inserts the number before its OTP.
- Errors are contained the same way (lock timeout, WARNING, `rpc_attempt_log`). This is the 00595 incident class.

**Approval — `trg_fleet_members_set_driver_on_approval`**, `BEFORE INSERT OR UPDATE OF status ON fleet_members`.
- Acts only when the write makes the invitation linkable: an INSERT with `status IN ('approved','pending_signup')` and no `driver_id`, or an UPDATE from any other status into those.
- A NULL status returns early, so the NOT NULL constraint rejects the write instead of the trigger turning it into a link.
- A row that was already linkable is not re-evaluated. A later edit of an approved invitation links nobody here; the owner can make such edits until 00600 freezes the reviewed identity.
- On a match it sets `driver_id`, `status = 'active'` and `signed_up_at = COALESCE(signed_up_at, now())` on `NEW`. No second write, no trusted flag.
- It fires after `trg_fleet_members_protect`, because triggers with the same event and timing fire in trigger-name order. That is defence in depth: for a non-admin, non-trusted write, the protect trigger reverts every field this one sets, whichever runs first.

**Backfill** (same migration, idempotent): invitations already approved and unlinked whose number an active account has confirmed are linked once. There are 0 such rows in prod.

**Migration mechanics:**
- `SET lock_timeout = '5s'` at the top and `RESET` at the end.
- `CREATE OR REPLACE TRIGGER`, with no DROP, which would take ACCESS EXCLUSIVE.
- The trigger on `auth.users` is created last, after the self-test, so its lock lasts the shortest time.
- No trigger is created on `public.users`.

### Data flow

| Event | Before | After 00598 |
|---|---|---|
| verify-otp signup: `createUser` INSERT, then its confirmation UPDATE | linked at the INSERT | linked at the confirmation |
| GoTrue's own phone signup, before the OTP | **linked to an unconfirmed number** | nothing |
| …then the OTP confirms it | — | linked by `on_auth_user_phone_confirmed` |
| Admin approves an invitation for an existing confirmed account | stays `approved`, unlinked | linked in the same UPDATE |
| Admin/service inserts an invitation already `approved` | unlinked | linked on INSERT |
| An account confirms a number via link-phone (first number or a new one) | nothing | its approved invitations for that number are linked |
| Someone writes a number into their own `users.phone` without OTP, even away and back | nothing | nothing |
| An unreviewed, rejected or already-named invitation for the confirmed number | — | untouched on every path |
| Owner self-approves or re-points an approved invitation | reverted / no link | reverted / no link at approval (a later OTP-confirmed signup or confirmation of the new number still links: 00600) |
| An account that has the number only in `users.phone` (prod: 2 seeded admins) | — | not linked; the admin RPC remains the manual path |

Nothing else downstream changes. `find_best_drivers` and `accept_ride_v2` already treat `status = 'active' AND driver_id = user` as membership, and the driver app lists every fleet (#1022). There is one downstream effect: a linked member who cannot drive switches the corporate fleet gate on. That could already happen through signup, and it is fixed separately (§ 5).

### Error handling

- **No match:** linking never raises. The helper returns NULL and the write goes through as before.
- **Signup and confirmation paths:** they contain any error (WARNING plus `rpc_attempt_log`) and never wait more than 2 s for a lock, because they run inside GoTrue's transactions.
- **Approval path:** stays loud, because it is an admin write.
- **The migration asserts its result** instead of trusting `CREATE` (plpgsql bodies are only checked when they run):
  - A rolled-back self-test against a real verified account checks that approval, signup and confirmation each link it.
  - If `anon` or `authenticated` can execute any of the four functions, the migration aborts.
  - The negative cases (unverified, inactive, ambiguous, unreviewed) are covered by the rehearsal, not by the self-test.

## 4. Testing

`supabase/tests/00598/run.sh`, local Postgres 16:
- **Scaffold:** the live shapes and bodies, including `handle_new_user` and `log_rpc_attempt`, with RLS on. Flows run as `authenticated` with a JWT, like PostgREST.
- **GoTrue's writes are replayed statement by statement:** `createUser` INSERTs then confirms; `updateUserById` confirms then sets the phone. A separate one-statement fixture covers the signup trigger's own link.
- **RED** (`run.sh none`): 27 of 70 checks fail, each for its reason: approval does not link, confirmation does not link, signup links an unconfirmed number, a link failure breaks the signup, and the new objects are missing. The controls pass.
- **GREEN** (`run.sh <migration>`): 76/76, applied twice (one transaction, then autocommit). The self-test leaves every row as it was, and the backfill links only the approved, unlinked invitation for a confirmed number.
- **Cases:**
  - A — approval: number formats, two fleets, inserted already approved, rejected→approved, the prod duplicate, a number outside Cuba, re-approval of a row that lost its account. Not linked: unverified, inactive, unconfirmed and ambiguous numbers. A NULL status is rejected.
  - B — the owner cannot self-approve or re-point into a link.
  - C — confirmation: link-phone, the app's mirror, a number written without OTP, someone else's number, the review's away-and-back toggle, an account inserted before its confirmation, re-confirmation, error containment plus its `rpc_attempt_log` row, inactive, a profile change to a new number, the status and `driver_id` filters, a number outside Cuba.
  - X — signup: two fleets, unconfirmed, error containment plus its log row, the signup trigger's own link with its filters, a number outside Cuba.
  - D — contract: ACLs, `SECURITY DEFINER`, pinned `search_path` and lock timeouts, trigger order and definitions, no linking trigger on `public.users`, unchanged md5 of eleven functions.
  - N1–N4 — a defective copy of the migration is aborted by its own assertions.
- **`supabase/tests/00598/mutants.py`:** 22 guards the self-test does not cover, removed one at a time. Each must make its own test fail.

## 5. Out of scope, flagged

- **`public.users.phone` is writable without an OTP** (chip, running in another session). This design does not rely on it.
- **The owner can edit `driver_phone` after approval.** The approval trigger does not link a re-pointed row, but a later OTP-confirmed signup or confirmation of the new number does. Another session is freezing the reviewed identity in `tg_fleet_members_protect` (00600).
- **`is_fleet_owner` never becomes true for owner-created accounts** (00434 forces it false on INSERT, 00418 reverts the owner's UPDATE), so `FleetReview` never renders. PR #1027 stops relying on the flag for the owner; the admin side is a follow-up.
- **The corporate fleet gate** (`find_best_drivers` / `accept_ride_v2`) switches on with any linked member, including one without an approved driver profile (chip).
- **Nothing watches `phone_autoconfirm`**, and the trust model rests on it (chip).

## 6. Changes after code review (2026-09-25)

**First review.** The first version put the "confirmed later" trigger on `public.users` (AFTER UPDATE OF phone, linking when `auth.users` confirmed the new value for that account). The rehearsal reproduced the hole: it could be fired with no new confirmation. An account that has number X confirmed sets its `users.phone` to something else and back, and the trigger runs again. Combined with an owner re-pointing an approved invitation at X, that linked the account with no admin review. The owner chose to move the trigger to `auth.users`, which end users cannot write (decision 4).

That review also found:
- The signup path linked whatever number GoTrue copied, confirmed or not (decision 5).
- Both GoTrue-side paths could fail a login or a signup on a linking error. Now contained.
- A NULL status slipped through the approval gate. Now rejected.
- The self-test's account filter could pick a number the normalizer does not accept. Now `^53[56]`.
- DROP + CREATE TRIGGER took ACCESS EXCLUSIVE locks. Now `CREATE OR REPLACE TRIGGER`, `lock_timeout`, and the auth trigger created last.
- Passenger-only links switch the corporate gate on (decision 6, chip).

It also checked, and the design keeps, that `phone_autoconfirm` is false in prod, so `phone_confirmed_at` does prove possession.

**Second review.** It found no defect in the SQL's behaviour for any real GoTrue sequence. It found:
- **The rehearsal modelled GoTrue's writes as one statement.** Real signups are linked by the confirmation trigger, not the signup trigger, and `link-phone` depends on the "new number" half of the condition, which a one-statement UPDATE never exercised. The tests now replay GoTrue statement by statement, and the docs name the path that actually links.
- **The status and `driver_id` filters that enforce admin review were untested** on the confirmation and signup paths and in the backfill. They now have tests and mutants.
- **Numbers outside Cuba never linked through the GoTrue-side paths.** The `+` is now restored.
- **Lock waits inside GoTrue's transaction were unbounded.** Now 2 s.
- **Swallowed failures were only a WARNING.** They are now logged in `rpc_attempt_log`.
- **The trigger's column list and WHEN** would block GoTrue from altering those columns. Removed; the filter now lives in the function.
- **The session-level `lock_timeout`** is now reset at the end of the migration.
- **Documented rather than changed:** the admin-API invariant (every `phone_confirm` must follow an OTP of that number), and the kill switch.
