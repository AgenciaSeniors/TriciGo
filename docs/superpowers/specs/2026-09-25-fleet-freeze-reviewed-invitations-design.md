# A reviewed fleet invitation stays as the admin reviewed it: design

**Date:** 2026-09-25 · **Status:** approved by the owner (2 decisions, see § 3)
**Scope:** migration 00600 (`tg_fleet_members_protect`), its rehearsal, the JSDoc of `fleetService.uploadMemberLicense`, a CLAUDE.md note.
**Out of scope (flagged separately):** the window *during* review (the owner edits between the admin loading the page and clicking approve), and replacing the licence file in Storage under the same path.

---

## 1. Context: what production says (read-only, 2026-09-25)

| Signal | Value |
|---|---|
| `fleet_members` / `driver_fleets` / `corporate_accounts` rows | 0 / 0 / 0: nobody affected yet |
| Triggers on `fleet_members` | only `trg_fleet_members_protect` (BEFORE INSERT OR UPDATE) |
| `tg_fleet_members_protect()` | md5(prosrc) `8b0d07aff7ab33142bfcec29304c01ed`, length 674, **no comments**. The 00435 file in git carries the same logic with comments (`9d34552c…`, 1090), so a database built from git has that text |
| Policy `fleet_members_owner_or_admin_update` | `UPDATE USING (is_admin() OR fleet_id IN <caller's fleets>)`, no `WITH CHECK` (so `USING` also checks the new row) |
| Grants | `authenticated` has UPDATE on every column |
| What the protect trigger reverts for the owner on UPDATE | `status`, `driver_id`, `signed_up_at`, `reviewed_at`, `reviewed_by`. Nothing else |
| Owner writes in app code | insert only (`submitFleetRequest`, `ON CONFLICT DO NOTHING` since #1027); `uploadMemberLicense` updates `license_doc_path` but nothing calls it |
| Admin writes | `approveMember` / `rejectMember`, only offered for `pending_review` rows (FleetReview) |

## 2. Reproduction and root cause

Local Postgres 16 with the live bodies (md5 checked) and RLS on, each call as `authenticated` with the caller's JWT:

1. The owner invites `+5355551111` → `pending_review`.
2. The admin approves → `approved`, `reviewed_by` = admin.
3. The owner updates the approved row: phone `+5355559999`, name, email, licence number, ID number, licence document path, `rejected_reason`, and moves it to their other fleet. **Every change sticks**; the row still reads `approved` by the admin.
4. The person who owns `+5355559999` signs up → the row turns `active` with their `driver_id`, in the fleet it was moved to, under the name and licence the owner typed.

With the 00598 draft applied, the same re-pointed row is also linked when that number is confirmed later. The 00598 approval trigger does not link it (by design: it only looks at rows moving into `approved`).

**Root cause.** The review is not bound to what was reviewed. `tg_fleet_members_protect` protects the outcome of the review (`status`, `reviewed_*`) and the link (`driver_id`, `signed_up_at`), but not its input. Every path that links an invitation (the signup trigger, the admin relink RPC, the 00598 triggers and backfill) reads `status IN ('approved', 'pending_signup') AND driver_id IS NULL` as "the admin approved this person, at this number", and the owner can change the number, the person and the fleet after the approval.

## 3. Decisions (owner, 2026-09-25)

1. **Freeze, silently.** Like `status` today, the database discards the owner's change and the write succeeds. To change a reviewed member, the owner deletes the row and invites again; the new row goes to review. (Rejected: sending the row back to `pending_review`, a re-review workflow no screen uses; raising an error, which the same trigger does not do for `status`.)
2. **The whole reviewed identity plus the fleet.** Once the invitation has left `pending_review`: `driver_phone`, `driver_name`, `driver_email`, `driver_license_number`, `driver_id_number`, `license_doc_path`, `fleet_id`. `rejected_reason` is the admin's text, so the owner cannot change it in any status (the INSERT branch already clears it).

## 4. Design

**One change:** `CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()`, transcribed from the live body, with one block added at the end of the owner's UPDATE branch:

```sql
    NEW.rejected_reason := OLD.rejected_reason;
    IF OLD.status IS DISTINCT FROM 'pending_review' THEN   -- fails closed, not open, on a NULL
      NEW.fleet_id              := OLD.fleet_id;
      NEW.driver_name           := OLD.driver_name;
      NEW.driver_phone          := OLD.driver_phone;
      NEW.driver_email          := OLD.driver_email;
      NEW.driver_license_number := OLD.driver_license_number;
      NEW.driver_id_number      := OLD.driver_id_number;
      NEW.license_doc_path      := OLD.license_doc_path;
    END IF;
```

- **Who it applies to:** the owner's path only, the same callers the trigger already restricts (a JWT, not an admin, no `app.trusted_fleet_update`). Admins (correcting a typo), the service role, migrations, GoTrue's triggers and the writers that set `app.trusted_fleet_update` (signup link, relink RPC, 00598's confirmation link) are unchanged, and none of them touches these columns. 00598's approval trigger is a separate trigger that fires after this one, on the admin's approval.
- **Unchanged:** the trigger (name, BEFORE INSERT OR UPDATE, per row), so its firing order relative to `trg_fleet_members_set_driver_on_approval` (00598) stays the same. The function's signature, `SECURITY DEFINER`, pinned `search_path` and ACL stay the same too (`CREATE OR REPLACE` keeps the ACL). The INSERT branch is unchanged.
- **Every UPDATE route is covered:** a PostgREST `PATCH`, and an upsert with `ON CONFLICT DO UPDATE` (it fires the BEFORE UPDATE trigger).
- **Order-independent with 00598 and 00599:** neither touches this function. 00598's self-test writes with no JWT.

### Guarding the transcription

- **Drift guard:** before replacing the function, the migration reads `md5(prosrc)` and proceeds only for the live body (`8b0d07af…`), 00435's text (`9d34552c…`, a database built from git) or the exact body this migration installs (`2b65b4b8…`, a re-run). Anything else raises: someone changed the function after 2026-09-25, and replacing it would drop that change.
- **Fidelity:** the rehearsal strips the 00600 block from the resulting `prosrc` and checks that what is left is byte for byte the live body (md5 and length).

### Error handling and self-assertion

Nothing raises at runtime: the owner's change is dropped, as with `status`. The migration asserts its result instead of trusting `CREATE`. It first checks, in the catalog, that the trigger is still attached, enabled, `BEFORE INSERT OR UPDATE`, per row and on every column. Then, in a rolled-back block, it acts as a real non-admin account, with `request.jwt.claims` set the way PostgREST sets it:
- it re-points an approved invitation (all seven fields), which must be kept;
- it rewrites a rejection reason, which must be kept;
- it edits a pending invitation, and that edit must go through.

Each write must hit exactly one row, and neither claim may outlive the block. A database with no non-admin account skips the behaviour check with a NOTICE.

## 5. Testing

`supabase/tests/00600/` (local Postgres 16, live shapes, bodies and ACLs, RLS on, calls as `authenticated` with JWT claims like PostgREST; the migration is applied as a `postgres` role that is not a superuser and has BYPASSRLS, like prod):
- **RED** (`run.sh none`): every reported case fails (the owner's changes stick, the signup links the new number); the controls pass.
- **GREEN** (`run.sh <migration>`): applied twice (one transaction, then autocommit, `search_path = ''`), every case passes. The self-test runs (it doesn't skip), it leaves every row as it was, and it leaves no JWT claim behind.
- **Cases:**
  - Owner after review, through RLS: phone, then the signup of the new number (not linked) and of the reviewed one (linked); the rest of the identity; moving the row to another fleet; `pending_signup`, `rejected`, `active` and `inactive` rows; `rejected_reason`; status sent along with the phone; an upsert with `ON CONFLICT DO UPDATE`.
  - Must keep working: owner edits while `pending_review`; admin edits; no-JWT edits; signup link and admin relink; delete and invite again; owner insert forced to review; admin approve and reject; an owner no-op update.
  - Contract: trigger definition, `SECURITY DEFINER`, `search_path` and owner, prod's ACL, fidelity to the live body, and a database built from git (00435's text) accepting the migration.
  - With 00598, in both orders, when it is in the checkout (or `M598=<path>`): an owner's re-point is not linked when the new number is confirmed later; an approved invitation for that number is linked when it is confirmed (control); the reviewed number's signup still links.
- **Negative proofs:**
  - A copy of the migration with any of these defects must be aborted by its own self-test: the phone freeze missing, the fleet freeze missing, `pending_review` frozen too, or the `rejected_reason` line missing.
  - A drifted function body must be refused by the guard.
  - The attachment check must refuse a trigger that lost its INSERT event, one that fires on a column list, and one that is disabled.

## 6. Out of scope, flagged

- **The window during review.** The owner can still edit a `pending_review` row after the admin opened FleetReview and before they click approve; the approval then covers values the admin never saw. The fix belongs in `approveMember` (the approve must match the values shown). Chip filed.
- **The licence file itself.** The `storage-upload` Edge Function lets the owner overwrite `fleet-docs/<corp>/<member>/<file>` in any status (`upsert: true`). Freezing `license_doc_path` keeps the path, but not the bytes behind it. Chip filed.
- **Moving a whole fleet to another company of the same owner.** `driver_fleets_owner_update` has no `WITH CHECK` and `driver_fleets` has no protect trigger, so the owner can set `corporate_account_id` to another company they own, and every reviewed member moves with it while `fleet_id` stays the same. It does not let an unreviewed person in. Found in code review, chip filed.
- **No way to delete a member in the app yet.** `fleetService` has no delete method, and `submitFleetRequest` ignores a phone the fleet already has. The documented remedy, deleting and inviting again, needs a screen; so does editing, which today does not exist either.
- **Behaviour change to know about.** Moving a reviewed row to a fleet the owner does not own used to fail RLS; now the trigger reverts `fleet_id` first and the write succeeds with nothing changed. This is consistent with decision 1.
