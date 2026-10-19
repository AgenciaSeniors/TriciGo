# Marketing runs promotions and referral amounts, and a signup code can pay new drivers

Date: 2026-10-19. Status: approved by the owner; migration 00666 written and rehearsed, not applied. The review round 1 changes are folded in below.

## Problem

The marketing agency creates signup codes for influencers (VIGO) and asked three things the panel does not allow:

1. **Promotions need an admin.** Since 00642 marketing creates promotions only as drafts (`pending_approval`); an admin activates them. Marketing cannot edit a live promotion (only pause it) or delete one that was used. The owner wants marketing to run promotions on its own.
2. **Referral amounts are super-admin only.** The four amounts (`referral_bonus_cup` 500, `referral_bonus_driver_cup` 1000, `referral_welcome_bonus_cup` 0, `referral_welcome_bonus_driver_cup` 0) live in `platform_config`, which only a super admin writes (`pc_super_admin_update`), from Settings → Platform config.
3. **A signup code gives drivers nothing.** A promotion is a discount on a passenger ride, so a driver who registers with VIGO gets nothing as a driver. Marketing wants new drivers to get a balance in their wallet instead.

## Decisions (owner, 2026-10-19)

- **Promotions:** marketing does everything an admin does, with no approval: create a promotion already active, activate, pause, edit while active, send "Notificar ahora". A promotion that was used (rides, uses, campaigns or codes point at it, or `current_uses > 0`) can only be paused, never deleted (00666 adds signup codes to `promotion_is_referenced`, which only looked at rides, uses and campaigns), so the history of which discount each ride had stays. Admins are not changed.
- **Referral amounts:** marketing edits the four amounts from the Referidos page. Every change is audited with who made it. Regular admins can also edit them there.
- **Driver balance:** each signup code gets an amount in CUP, 0 = off. A driver registered with the code gets that amount in their wallet when they complete their first ride.
- **No cap** on any amount (owner: "sin tope"). Amounts are integers ≥ 0.

## Current behaviour this builds on

- `tg_promotions_marketing_guard` (00642, live md5 `2b4dd44a23aaf0c01a47b28d6b09cae4`), BEFORE INSERT OR UPDATE OR DELETE on `promotions`. `v_marketing := current_user IN ('anon','authenticated') AND is_marketing()`. For marketing it forces drafts on insert, refuses activation (`promo_activation_requires_admin`), refuses any change but pause or `notified_at` on a live one (`promo_active_locked`), keeps approval fields and counters, and sets `pending_approval` on every content change. It refuses a delete unless the promotion is paused, has `current_uses = 0` and `promotion_is_referenced(id)` is false (`promo_delete_blocked`). For everyone: `revision` counts content changes, and turning a promotion on clears `pending_approval` and, for an admin, stamps `approved_by`/`approved_at`.
- Policies on `promotions`: `promo_admin` (ALL, `is_admin()`) and `promotions_{select,insert,update,delete}_marketing` (`is_marketing()`).
- `platform_config` is written only by a super admin (RLS). `tg_platform_config_audit` writes an `admin_actions` row with `auth.uid()` for every UPDATE that changes the value (00606 skips only automated telemetry writes).
- The referral triggers (`trg_referral_reward_on_complete`, `trg_referral_reward_on_driver_first_ride`) read the four amounts at payment time with `get_platform_config_numeric`.
- `acquisition_codes` (00619, 00665): `code` PK, `label`, `channel`, `audience`, `is_active`, `notes`, `created_at`, `created_by`, `promotion_id`. Admins and marketing have full access (`acquisition_codes_admin_all`, `acquisition_codes_all_marketing`). `users.signup_code` names the code a person registered with; only `apply_signup_code` writes it.
- `admin_signup_code_stats()` (00665, live md5 `22b65e286149e554225824d766ba81f5`) returns one row per code: signups, riders/drivers, drivers approved, first rides, `promotion_id`, `promotion_code`, `promo_rides`.
- `_claim_reward(user, claim, ride, referral)` (00658) records a reward once per confirmed phone and returns `claimed` or a refusal; `_reward_claim_status(user, claim)` reads it.
- The driver referral path pays from the platform's `platform_promotions` account to the driver's wallet as a `promo_credit` ledger transaction with an idempotency key, inside a block that never rolls back the ride completion.

## Design

### A. Promotions without approval

Rewrite `tg_promotions_marketing_guard` from its live body (refuse any other body by md5):

- **Insert by marketing:** keep what the request sends for `is_active`; set `pending_approval = false`, `created_by = auth.uid()`, `current_uses = 0`, `notified_at = NULL`, `approved_by/approved_at = NULL` (the shared block below stamps them when the row is born active). `revision = 0` as today.
- **Update by marketing:** any column may change except `current_uses`, `created_by`, `approved_by`, `approved_at` and `revision`, which keep their old values (approval stamps come only from the shared block). `pending_approval` becomes false. `revision` still goes up on a content change.
- **Delete by marketing:** unchanged (paused, `current_uses = 0`, not referenced).
- **Turning a promotion on, shared block:** clears `pending_approval`, and stamps `approved_by = auth.uid()`, `approved_at = now()` when the writer is an admin **or marketing**. So the row records who turned it on.
- Admin, service role and SQL without a JWT behave exactly as today.
- The DETAIL codes `promo_activation_requires_admin` and `promo_active_locked` are no longer raised. The panel keeps their Spanish messages (an old tab may still see one until it reloads); they cost nothing.

Panel (`apps/admin/src/app/promotions/page.tsx`): marketing sees what an admin sees (activation switch, "Activa" in the form, edit while live, "Notificar ahora", delete with the same server rule). The "Se guarda apagada. Un administrador la revisa…" notes and similar texts go. The pending-approval banner stays admin-only and harmless. In `/code-performance`, the sentence "Activar una promoción lo decide un administrador" goes.

### B. Referral amounts from the Referidos page

New function `set_referral_amounts(p_amounts jsonb) RETURNS jsonb`, SECURITY DEFINER, `search_path = public, pg_catalog`, EXECUTE for `authenticated` and `service_role` only.

- Refuses unless `is_admin() OR is_marketing()` (`{error: 'forbidden'}`).
- `p_amounts` is an object whose keys are among the four referral keys; any other key → `{error: 'unknown_key', key}`. Each value must be a JSON integer ≥ 0 (no decimals, no strings) → otherwise `{error: 'invalid_amount', key}`. An empty object → `{error: 'nothing_to_save'}`.
- Validates everything first, then writes each key with `INSERT … ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value` (the value stored as a JSON number, like today). Unchanged values write nothing new to the audit (the audit trigger skips equal values).
- Returns `{success: true, amounts: {all four keys with their current values}}`.
- Audit: `tg_platform_config_audit` already writes `update_platform_config` with `auth.uid()`; the function runs with the caller's JWT, so the row names the marketing user.

Service: `referralService.getReferralAmounts()` (reads the four keys from `platform_config`, which any signed-in user may read for non-secret keys) and `referralService.setReferralAmounts(changes)` (calls the RPC, maps errors to `AppError`). Panel: a "Montos" card at the top of `/referrals`, for admins and marketing: four integer inputs in CUP with one line of help each, one "Guardar" that sends only the changed keys, a success toast, and the values reloaded from the response.

### C. Wallet balance for drivers who register with a signup code

**Data.** `acquisition_codes.driver_bonus_cup integer NOT NULL DEFAULT 0 CHECK (driver_bonus_cup >= 0)`. It inherits the table's policies (admins and marketing write it).

New table `signup_driver_bonuses` (one row per paid bonus): `user_id uuid PRIMARY KEY` (no foreign key), `code text NOT NULL`, `amount_cup integer NOT NULL CHECK (amount_cup > 0)`, `ride_id uuid`, `transaction_id uuid`, `paid_at timestamptz NOT NULL DEFAULT now()`. RLS on, no policies; `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role` (00587 rule); only SECURITY DEFINER functions read or write it. No foreign keys on purpose, like `reward_claims` (00658): the row is history and survives the deletion of the account, so `anonymize_user_references` and the 00657 deletion path are not touched. A second payment to the same person is stopped by the phone claim, not by this table.

**Payment.** New trigger function `trg_signup_driver_bonus()` (SECURITY DEFINER, `search_path = public, pg_catalog`), trigger `trg_signup_driver_bonus` AFTER UPDATE OF status ON `rides`, `WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')`. It does nothing unless all of these hold:

1. `NEW.driver_id` is set; the driver's user has a `signup_code` whose `driver_bonus_cup > 0`, and the code was applied **before the driver's approval** (`users.signup_code_at <= driver_profiles.approved_at`). Review round 1: `apply_signup_code` lets anyone without a code set one at any time, and on 2026-10-19 157 of the 167 approved drivers had never driven for anyone, so without this rule any of them could type an influencer's code and be paid for a signup the influencer did not bring.
   - **Review round 2: the comparison is against the FIRST approval.** `adminService.approveDriver` sets `approved_at = now()` on every approval, re-approvals included (the 00650 vehicle re-review, reinstating a suspension). An approved driver could apply a code, change vehicle, get re-approved and qualify. A lock table `driver_first_approvals` (`driver_profile_id` PK, `first_approved_at`) keeps the first one. It is filled by `trg_driver_profiles_first_approval` (AFTER INSERT OR UPDATE OF status, when the new status is `approved`, `ON CONFLICT DO NOTHING`, inside a block that never blocks the approval), and backfilled from today's `approved_at`. The backfill is safe: on 2026-10-19 there are 0 codes and 0 users with a signup code. The rule is `signup_code_at <= LEAST(first_approved_at, approved_at)`; a missing row falls back to `approved_at`.
2. `NEW.customer_id` is set and is not the driver's own user.
3. This is the driver's first qualifying ride: count of completed rides with that `driver_id`, a customer, and customer ≠ the driver's user, equals 1 (this one included; the trigger runs after the update). Same rule as the driver referral path.
4. No row in `signup_driver_bonuses` for that user (and the idempotency key below is free).
5. `_claim_reward(driver_user, 'signup_driver_bonus', NEW.id, NULL)` returns `claimed`: one bonus per confirmed phone, ever, whatever the code; a driver without a confirmed phone gets nothing.

Then, inside a block that never rolls back the ride (`EXCEPTION WHEN OTHERS THEN RAISE WARNING … ; RETURN NEW`, as in the referral triggers; the claim is taken inside the same block so a failed payment undoes it):

- Credit `driver_bonus_cup` (read now, at payment time) from `platform_promotions` (user `…0001`) to the driver's `tricicoin` wallet: `ledger_transactions` type `promo_credit`, idempotency key `signup_driver_bonus:<user_id>`, `reference_type 'signup_driver_bonus'` and `reference_id` the ride, description `Bono de bienvenida - código <CODE>`, two `ledger_entries`, two balance updates. Same shape as the driver referral credit.
- Insert the `signup_driver_bonuses` row.
- Push to the driver through `cron_http_post('signup-driver-bonus', …send-push…)`, category `system`, title "Recibiste un bono de bienvenida", body "Te acreditamos <N> CUP en tu billetera por tu primer viaje.", data `{event: 'signup_driver_bonus', amount_cup}` (no `ride_id`: the driver inbox opens `/trip/<ride_id>` when the data has one). A failed push is logged and does not undo the credit (its own inner block).

A failed payment leaves a WARNING and an `rpc_attempt_log` row (`rpc_name = 'trg_signup_driver_bonus'`, `outcome = 'payment_failed'`, with SQLSTATE, error, code and amount). It is not retried: the next ride is no longer the first.

Every change of `driver_bonus_cup` (and a new code born with an amount) writes an `admin_actions` row `update_signup_driver_bonus` with the old and new amount and who made it (`tg_acquisition_codes_bonus_audit`).

It does not depend on `referral_program_enabled`: the code's amount is the switch. A driver can get both this bonus and a referral welcome bonus (different claims).

**Stats.** `admin_signup_code_stats()` gains `driver_bonus_cup integer`, `drivers_bonus_paid bigint` and `driver_bonus_paid_cup bigint` (count and sum from `signup_driver_bonuses` for the code). Adding columns changes the return type, so DROP + CREATE with the same grants (EXECUTE for `authenticated` and `service_role`, the body refuses non admin/marketing). Refuse to run unless the live body has md5 `22b65e28…` or this migration's own (a re-run).

**Panel** (`/code-performance`, "Códigos de origen"): the create form gets "Saldo para choferes (CUP)" (integer, default 0). Each row shows the amount with an input and "Guardar" (same save-with-a-button pattern as the promotion selector), plus "Bonos pagados: N · X CUP". CSV export gets the three columns. Service: `acquisitionCodeService.create` accepts `driver_bonus_cup`; new `setDriverBonus(code, amount)` that throws if RLS changed 0 rows; stats type gets the three fields.

## Error handling

- `set_referral_amounts` returns `{error}` objects (no exceptions) for validation; the service maps them to Spanish messages.
- The bonus trigger never blocks a ride completion; failures leave a WARNING in the Postgres log and no credit, and the claim is rolled back with the failed block so a later fix can pay.
- The promotions guard keeps raising `promo_delete_blocked` for marketing.

## Testing

Rehearsal `supabase/tests/00666/run.sh` (local Postgres 16, the 00665 harness style, live prod bodies md5-checked):

- A: marketing inserts an active promotion (stays active, stamped with marketing's id, not pending); edits a live one (allowed, revision +1); activates a paused one (stamped); cannot change `current_uses`/`created_by`/approval stamps; delete of a used one still refused, of an unused paused one allowed; admin behaviour unchanged; a rider is still refused by RLS.
- B: marketing and admin save amounts; rider and anon refused; unknown key, negative, decimal and string refused with nothing written; one `admin_actions` row per changed key naming the caller; unchanged keys write no audit row.
- C: driver registered with a code with 1000 → paid once on the first qualifying ride (ledger, wallet, table row, push queued); a second ride pays nothing; a ride the driver requested for themselves does not count; amount 0 → nothing; no confirmed phone → nothing; a phone already paid (new account) → nothing; a failing payment does not block the completion; stats show the counts.
- Migration applied twice (idempotent), from a CRLF copy, with negative proofs of its self-checks.

Services: unit tests for `setReferralAmounts`, `getReferralAmounts`, `setDriverBonus`, and the new stats fields.
