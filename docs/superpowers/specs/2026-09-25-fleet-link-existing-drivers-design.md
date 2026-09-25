# Link fleet invitations to drivers who already have an account — design

**Date:** 2026-09-25 · **Status:** approved by the owner (3 decisions, see § 2)
**Scope:** migration 00598 (linking on approval and on a phone verified later), its rehearsal, doc comments in `fleet.service.ts`.
**Out of scope (flagged separately):** `users.phone` writable without an OTP; the owner editing `fleet_members.driver_phone` after review; `corporate_accounts.is_fleet_owner` never sticking for owner-created accounts (told to the session working on the owner form).

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
| `auth.users.phone` | unique index `users_phone_key`; 544 rows, all `53XXXXXXXX` (E.164 without `+`), all with `phone_confirmed_at` |
| `public.users` with a phone | 546: **544 equal (normalized) to their confirmed auth phone**, 0 different, 2 with no auth phone (a super_admin and an admin seeded in March) |
| The one shared number | an admin (no auth phone) and an approved driver (confirmed) |
| `handle_new_user` | copies `NULLIF(auth.users.phone, '')` into `public.users.phone`, so the signup link already runs on the OTP-verified number |

Reproduction (local Postgres 16, live bodies, RLS on, each step as `authenticated` with the caller's JWT): the admin approves an invitation for an existing driver → `approved`, `driver_id NULL`; the driver's `getMembershipsForDriver()` query returns 0 rows; saving the profile or approving again changes nothing. Controls: the relink RPC links when called; a signup after the approval links.

**Root cause.** Linking is evaluated from one side of the join only. The link condition is *invitation linkable* (`status IN ('approved','pending_signup') AND driver_id IS NULL`) ∧ *same normalized phone as an account*. Only one of the events that can make it true runs the check: an account being created. The invitation becoming approved, and an existing account getting its phone later, never do. The admin RPC meant for the first case has no caller.

## 2. Decisions (owner, 2026-09-25)

1. **Where:** a database trigger at approval time (not the admin UI): it works for any approval path (panel, SQL editor, future tools) and is atomic with the approval. The admin panel cannot even show `FleetReview` today, so a UI-only fix could not be exercised.
2. **Who qualifies:** the one **active** account whose number is **confirmed by OTP in `auth.users`** (`phone_confirmed_at`). `public.users.phone` is not trusted (writable without OTP). No driver-profile requirement, same as signup: a passenger-only account is linked now and is already in the fleet when it registers as a driver.
3. **Phone verified later:** also covered. When an account's phone changes and `auth.users` holds that number confirmed for the same account (what `link-phone` does), its approved invitations are linked.

## 3. Design

### Units

**`public._user_id_by_verified_phone(p_phone text) → uuid`** — the id of the one active account whose OTP-confirmed number is `p_phone`, else NULL.
- Normalizes with `_normalize_cuban_phone`; anything that is not `+` and 8–15 digits after that returns NULL.
- Looks up `auth.users.phone IN (v_norm, substr(v_norm, 2))` — E.164 with or without `+`, which uses the unique index — with `phone_confirmed_at IS NOT NULL`, joined to `public.users` with `is_active`.
- Returns NULL unless exactly one row matches (never guesses).
- `SECURITY DEFINER` (reads `auth.users`), `STABLE`, pinned `search_path`. **EXECUTE revoked from PUBLIC, anon and authenticated**: it maps a phone to an account id, an enumeration oracle.

**`tg_fleet_members_set_driver_on_approval()` + `trg_fleet_members_set_driver_on_approval`** — `BEFORE INSERT OR UPDATE OF status ON fleet_members`.
- Acts only when the write makes the invitation linkable: an INSERT with `status IN ('approved','pending_signup')` and no `driver_id`, or an UPDATE from any other status into those. A row that was already linkable is not re-evaluated, so an owner who re-points an approved invitation at another number (possible today, see § 5) does not get that account linked by this trigger.
- On a match it sets `driver_id`, `status = 'active'`, `signed_up_at = COALESCE(signed_up_at, now())` on `NEW` (the relink RPC's values); no second write, no trusted flag.
- Fires after `trg_fleet_members_protect` (same event and timing fire in trigger-name order; `set_…` sorts after `protect`), so it sees the row after an owner's changes to `status`/`driver_id` were reverted. An owner cannot produce the transition: the protect trigger reverts `status` for any non-admin, non-trusted write, and it reverts every field this trigger sets.

**`auto_link_fleet_member_on_phone_verified()` + trigger of the same name** — `AFTER UPDATE OF phone ON public.users`, `WHEN (NEW.phone IS NOT NULL AND NEW.phone IS DISTINCT FROM OLD.phone)`.
- Does nothing unless `_user_id_by_verified_phone(NEW.phone) = NEW.id`: a number typed into `users.phone` without an OTP links nothing.
- Otherwise runs the relink UPDATE for that account (normalized phone, linkable rows, `signed_up_at = COALESCE(…, now())`) under `app.trusted_fleet_update = '1'`, then restores the flag's previous value so it does not stay on for the rest of the caller's transaction. The flag is needed here: the update can run under the user's own JWT (the client mirrors the phone after `link-phone`).

**Backfill** (same migration, idempotent): invitations already approved and unlinked whose number an active account has confirmed are linked once. 0 rows in prod; it keeps the invariant true in any database regardless of history.

### Data flow

| Event | Before | After 00598 |
|---|---|---|
| New account with a phone (`handle_new_user` → INSERT `public.users`) | linked (00595) | unchanged |
| Admin approves an invitation for an existing verified account | stays `approved`, unlinked | linked in the same UPDATE |
| Admin/service inserts an invitation already `approved` | unlinked | linked on INSERT |
| Account verifies (or changes) its phone via `link-phone`, then the mirror/`updateProfile` writes `public.users.phone` | nothing | its approved invitations are linked |
| Someone writes a number into their own `users.phone` without OTP | nothing | nothing (`auth.users` does not confirm it) |
| Owner self-approves or re-points an approved invitation | reverted / no link | reverted / no link |
| Two accounts claim the number but none has it confirmed (prod: the 2 seeded admins) | — | not linked; the admin RPC remains the manual path |

Downstream nothing changes: `find_best_drivers` / `accept_ride_v2` already treat `status = 'active' AND driver_id = user` as membership, and the driver app lists every fleet (#1022).

### Error handling

Linking never raises on a no-match: the helper returns NULL and the approval goes through as before. The migration asserts its result instead of trusting `CREATE` (plpgsql bodies are only checked when they run): a rolled-back self-test against a real verified account links on approval, links on phone verification, leaves an unverified number unlinked; and `anon`/`authenticated` must not be able to execute the three new functions, or the migration aborts.

## 4. Testing

`supabase/tests/00598/` (local Postgres 16, live shapes and bodies, RLS on, flows run as `authenticated` with a JWT like PostgREST):
- RED (`run.sh none`): the approval and phone-verified cases fail, the controls pass.
- GREEN (`run.sh <migration>`): applied twice (one transaction, then autocommit), every case passes, the self-test leaves every row as it was.
- Cases: verified account linked on approval (as admin, RLS on), stored in another format, two fleets, insert already approved, rejected → approved; not linked: pending_review, unverified number, inactive account, the prod duplicate shape resolves to the verified driver; owner self-approval and owner re-point do not link; phone verified later links, a number written without OTP does not, the trusted flag does not outlive the statement; signup (00595) unchanged; contract: ACLs, `SECURITY DEFINER`, pinned `search_path`, trigger order on `fleet_members`, unchanged md5 of the functions it must not touch.
- Negative proof: a copy of the migration with the link removed must be aborted by its own self-test.

## 5. Out of scope, flagged

- **`public.users.phone` is writable without an OTP** (security chip). This design does not rely on it; other readers (gift lookup, signup) are for that fix.
- **The owner can edit `driver_phone` (and the rest of the reviewed identity) after approval**: a later signup or phone verification of the new number links it with no review. The approval trigger does not, by design (§ 3). Chip filed.
- **`is_fleet_owner` never becomes true for owner-created accounts** (00434 forces false on INSERT, 00418 reverts the owner's UPDATE), so `FleetReview` never renders and `getFleetByOwner` returns null. Told to the session fixing the owner form; the DB fix here works whichever way approvals end up happening.
