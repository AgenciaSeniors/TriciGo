# One owner per assisted ride — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each ride that needs support gets one operator on shift as its owner; riders and drivers reach that operator's WhatsApp (or the one on shift) instead of the founder's hardcoded number.

**Architecture:** One migration (00681) adds `support_staff` (shift and WhatsApp per staff member), ownership columns on `ride_assist`, the assignment/handover logic inside the existing alert path, a 20 s cron tick, and an ownership guard in every assist action. Pure helpers in `@tricigo/utils`, thin services in `@tricigo/api`, then the admin panel (switch, chips, owner strip), and the apps and web read the number from `get_support_contact` / `request_ride_help`.

**Tech Stack:** Postgres 17 (Supabase, pg_cron 1.6.4), plpgsql; TypeScript, vitest; Next.js 14 admin and web; Expo client and driver 1.8.0 (OTA).

**Spec:** `docs/superpowers/specs/2026-11-07-support-ride-owner-design.md`

## Global Constraints

- Migration number **00681**. On 2026-11-07 the next free number was 00679; 00679 and 00680 went to Moto Deportiva (#1196), which reached master first, and this migration was renumbered to 00681 on 2026-11-14 (commits before that date say 00679). Re-check `supabase/migrations` on master and every open PR right before applying it.
- Every new or patched function: `SECURITY DEFINER`, `SET search_path` (`public, pg_catalog`, as the 00628 functions), EXECUTE revoked from `PUBLIC` and `anon`, granted to `authenticated` only for RPCs the panel or apps call. Exception: `get_support_contact()` is granted to `anon` and `authenticated`.
- Gate for staff RPCs: `public.is_ops_staff()`. Refusals return `jsonb_build_object('error', <code>)` like the functions they sit next to.
- Patches of live bodies go through a `pg_temp.m00681_patch(fn, old_md5, new_md5, olds[], news[])` helper identical to `pg_temp.m00673_patch` (`supabase/migrations/00673_operator_support_and_moderation.sql:44`): `md5(prosrc)`, each replaced text present exactly once, re-run is a no-op.
- `md5(prosrc)` of the bodies in prod on 2026-11-07 (00676-00678 applied): `_support_alert` `992c2ce11b664d72e437a683170abb97`, `request_ride_help` `0568a44a41e6b9ef925ae1b2b2799cb1`, `admin_ride_assist_context` `2b7a2a9cb6ca0566c3fde8614220e91a`, `admin_active_ride_context` `62031d5be71f09241122be3e64bb3957`, `admin_offer_ride_to_driver` `0085408045cc5fbf2dbc3e2eb0da92f5`, `admin_assign_ride_to_driver` `96a14f1ef39f9d397884457278efd699`, `admin_change_ride_service` `06b0af6654384570c38a76389681d43a`, `admin_release_active_ride` `8f18bf4984f52e41c93cdb16b062eeff`, `admin_advance_active_ride` `bc7187cb8d4dbde6c64886e2ee9e3ff8`, `admin_complete_active_ride` `149e13089c12d43458a75ee58dd2a9d3`, `admin_cancel_ride` `21b4dfa6427e7c8976ef1324ddfa732b`. Re-capture them before writing; any difference means another migration landed.
- No `DELETE`, `DROP` or `TRUNCATE` in the migration (MCP apply waits for approval on them, CLAUDE.md). That is why the banner gets a new `admin_support_waiting_rides_v2` instead of changing the old signature.
- New table: RLS on, explicit GRANTs including `service_role`; `pnpm check:migration-grants` passes.
- Lock order: `rides` before `ride_assist` before `support_staff`. The cron tick takes `ride_assist` rows with `FOR UPDATE OF ra SKIP LOCKED`.
- Config: `support_handoff_after_s` = 60 (floor 30), `support_auto_offshift_misses` = 2 (floor 1).
- WhatsApp numbers are stored in E.164: `^\+[1-9][0-9]{7,14}$`. An 8-digit Cuban mobile starting with 5 typed without prefix gets `+53`.
- Push copy (Spanish, exact): owner alert title `'Te toca · ' || <today's title>`; handover title `'Te pasamos un viaje · ' || <today's title>`; nobody opened it (to every ops staff) title `'Nadie abrió el viaje · ' || <today's title>`; take-over to the previous owner title `<name> || ' tomó el viaje #' || <code>`; auto off-shift title `'Te sacamos de turno'`, body `'No abriste 2 viajes seguidos. Actívalo de nuevo cuando puedas.'` (the 2 is the config value). Push labels: `support-owner-alert`, `support-handoff`, `support-all-missed`, `support-take`, `support-auto-offshift`; `data.event`: `support_owner`, `support_handoff`, `support_all_missed`, `support_take`, `support_offshift`.
- `ops_set_support_shift` (Ruling 15): only a transition does more than store the number. On to off hands her open rides over; off to on resets `missed_in_a_row` and runs the pickup. A call that keeps the state (the panel's "Cambiar número") only stores the number, resets no misses and returns `handed_over`, `kept` and `picked_up` as 0; it logs `support_shift_number` when the number changed and nothing when nothing changed.
- `admin_actions.action` values: `support_shift_on`, `support_shift_off`, `support_shift_number`, `support_shift_auto_off`, `support_take_ride`.
- Nothing hardcodes `56621636` in `apps/` or `packages/` source afterwards (store metadata and docs excepted).
- UI copy in Spanish with es/en/pt entries; code, comments and commits in English.

## Review Focus

1. **Two alerts in the same second with two operators on shift** — they must go one to each, not both to the same one. Covered by T2 case `B3`.
2. **An operator deactivated (`users.is_active = false`) while her switch is on** — she must never be picked or shown as the contact. Covered by T1 case `A9`.
3. **A rider taps "Pide ayuda" twice** — same number both times, one push only. Covered by T2 case `B6`.
4. **The phone is offline on first launch after the OTA** — the help screens offer e-mail, never the founder's number; with a cached number, they use it. Covered by T4 `resolveSupportPhone` tests and the T7 guard test.
5. **An operator is the rider of a waiting ride (testing with her own account)** — the assignment skips her; with nobody else on shift the ride stays unowned. Covered by T2 case `B9`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00681_support_ride_owner.sql` | Everything server-side (T1-T3) |
| `supabase/tests/00681/{run.sh,scaffold.sql,tables.sql,live-bodies.sql}` | Local rehearsal, 00673 layout |
| `packages/utils/src/supportContact.ts` (+ test) | `normalizeSupportWhatsapp`, `resolveSupportPhone` |
| `packages/utils/src/supportOwnership.ts` (+ test) | `assistOwnership`, `sortWaitingForViewer` |
| `packages/api/src/services/support-contact.service.ts` (+ test) | `get_support_contact` |
| `packages/api/src/services/support-shift.service.ts` (+ test) | shift switch RPCs |
| `packages/api/src/services/ride-assist.service.ts` (+ test) | owner fields, `openAssist`, `takeRide`, `requestHelp` phone |
| `apps/admin/src/components/support/SupportShiftSwitch.tsx` | header switch and WhatsApp dialog |
| `apps/admin/src/components/support/AssistOwnerStrip.tsx` | owner strip and "Tomar este viaje" |
| `apps/{client,driver}/src/hooks/useSupportPhone.ts`, `apps/web/src/lib/useSupportPhone.ts` | the number for help screens |

---

### Task 1: Migration 00681 part 1 — staff, shifts and the public contact

**Files:**
- Create: `supabase/migrations/00681_support_ride_owner.sql`
- Create: `supabase/tests/00681/run.sh`, `scaffold.sql`, `tables.sql`, `live-bodies.sql` (copy the 00673 runner's helpers `run/val/has/apply/mkdb/as_user/tx/call`; `live-bodies.sql` holds `pg_get_functiondef` of every function in the md5 list, captured from prod, plus `is_ops_staff`, `is_operator`, `is_admin`, `_ride_short_code`, `_ride_type_label`, `get_platform_config_numeric`, `log_rpc_attempt`; `cron_http_post` and `get_service_role_key` are stubs; the first records `(label, body)` in a scaffold table `public.test_pushes`, which the cases read)

**Interfaces:**
- Produces (SQL):
  - table `public.support_staff(user_id uuid PK → users ON DELETE CASCADE, whatsapp_phone text CHECK (whatsapp_phone ~ '^\+[1-9][0-9]{7,14}$'), on_shift boolean NOT NULL DEFAULT false, shift_started_at timestamptz, shift_ended_at timestamptz, missed_in_a_row integer NOT NULL DEFAULT 0, last_assigned_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`; policy `support_staff_select_ops` `FOR SELECT TO authenticated USING ((SELECT public.is_ops_staff()))`.
  - `ride_assist` columns `owner_id uuid REFERENCES users`, `owner_assigned_at timestamptz`, `owner_opened_at timestamptz`, `owners_tried uuid[] NOT NULL DEFAULT '{}'`, `all_missed_alert_at timestamptz`; index on `owner_id` where not null.
  - `ops_set_support_shift(p_on boolean, p_whatsapp text DEFAULT NULL) RETURNS jsonb` → `{success, on_shift, whatsapp_phone, handed_over, kept}` or `{error}` with `forbidden`, `whatsapp_required`, `invalid_whatsapp`. (T2 fills in the handover and pickup it calls.)
  - `ops_support_shift_status() RETURNS jsonb` → `{me: {on_shift, whatsapp_phone, shift_started_at, missed_in_a_row} | null, on_shift: [{user_id, name}], suggested_whatsapp: text | null}` (`suggested_whatsapp` = caller's `users.phone`).
  - `get_support_contact() RETURNS jsonb` → `{phone: text | null}`.
  - `_support_pick_owner(p_ride_id uuid, p_exclude uuid[]) RETURNS uuid`.
  - `_support_staff_on_shift(p_user uuid) RETURNS boolean` (on shift, has a number, `users.is_active`, role in admin/super_admin/operator).

- [ ] **Step 1: Write the rehearsal cases (RED)** in `run.sh`, accounts `OP1`, `OP2` (operator), `ADM` (admin), `CUS` (customer), rides `R1..R4` searching:
  - `A1` operator calls `ops_set_support_shift(true, NULL)` with no `users.phone` → `{"error":"whatsapp_required"}`.
  - `A2` `ops_set_support_shift(true, '5 512 3456')` → `invalid_whatsapp` (the server takes E.164 only; the panel normalizes).
  - `A3` `ops_set_support_shift(true, '+5355123456')` → `on_shift` true, row stored, one `admin_actions` row `support_shift_on`.
  - `A4` customer calls it → `forbidden`; `anon` cannot EXECUTE it.
  - `A5` `get_support_contact()` as `anon` with OP1 on shift → `{"phone":"+5355123456"}`.
  - `A6` OP1 turns off (`support_shift_off` logged), nobody on → `get_support_contact()` returns OP1's number; then OP2 on and off later → returns OP2's (latest `shift_ended_at`).
  - `A7` no row ever → `{"phone":null}`.
  - `A8` both on, OP1 owns one open searching ride, OP2 none → `_support_pick_owner(R2,'{}')` = OP2; equal load → the one with the older `last_assigned_at` (NULL first).
  - `A9` OP2 on shift but `users.is_active = false` → never picked; `get_support_contact()` skips her.
  - `A10` ADM can turn the switch on (admins may cover).
- [ ] **Step 2: Run** `supabase/tests/00681/run.sh none` → every A case FAILs (functions missing).
- [ ] **Step 3: Write part 1 of the migration**: config rows (`INSERT … ON CONFLICT (key) DO NOTHING`), the table, policy, GRANTs, the columns, and the five functions above. Pick rule in `_support_pick_owner`: staff with `_support_staff_on_shift`, not in `p_exclude`, not the ride's customer nor its driver's user; order by count of rides they own with status `searching` or active (`accepted`, `driver_en_route`, `arrived_at_pickup`, `in_progress`, `arrived_at_destination`), then `last_assigned_at NULLS FIRST`; lock the chosen `support_staff` row `FOR UPDATE` and stamp `last_assigned_at = now()` (this is what makes two simultaneous alerts alternate).
- [ ] **Step 4: Run** `supabase/tests/00681/run.sh supabase/migrations/00681_support_ride_owner.sql` → A1-A10 PASS, applied twice.
- [ ] **Step 5: Commit** `feat(db): support staff shifts and the public support contact (00681 part 1)`.

### Task 2: Migration 00681 part 2 — assignment, help number, handover and auto off-shift

**Files:**
- Modify: `supabase/migrations/00681_support_ride_owner.sql`, `supabase/tests/00681/run.sh`

**Interfaces:**
- Consumes: T1's `_support_pick_owner`, `_support_staff_on_shift`, `support_staff`, `ride_assist` owner columns.
- Produces:
  - `_support_alert(p_ride_id uuid, p_kind text)` replaced (md5-guarded full replacement): if the ride has no owner, or its owner is not on shift, it assigns `_support_pick_owner(ride, owners_tried)` (setting `owner_id`, `owner_assigned_at = now()`, `owner_opened_at = NULL`, `all_missed_alert_at = NULL`, appending to `owners_tried`) and pushes only her with the owner title; when nobody qualifies it pushes every active ops staff account exactly as today. A ride whose owner is on shift pushes only her.
  - `_support_send(p_label text, p_user_ids uuid[], p_title text, p_body text, p_event text, p_ride_id uuid)`: the `cron_http_post` call `_support_alert` makes today, factored out; same exception handling and `alert_failed` logging.
  - `_support_phone_for_ride(p_ride_id uuid) RETURNS text`: owner's number when the owner is on shift, else `get_support_contact()->>'phone'`.
  - `request_ride_help(p_ride_id)` patched: the success object gains `'support_phone', public._support_phone_for_ride(p_ride_id)` (also on the capped path).
  - `_support_handoff_rides_of(p_user uuid) RETURNS jsonb` → `{handed_over: int, kept: int}`: her rides with status searching or active pass to `_support_pick_owner(ride, owners_tried || p_user)`, push `support-handoff`; rides with no taker stay.
  - `_support_pickup_for(p_user uuid) RETURNS integer`: searching rides already alerted (`help_alert_sent_at` or `wait_alert_sent_at` not null) with no owner, or whose owner is off shift and `owner_opened_at IS NULL`, are assigned by `_support_pick_owner` with an owner push. Called by `ops_set_support_shift(true, …)`.
  - `support_handoff_tick() RETURNS integer` and `cron.schedule('support-handoff-tick', '20 seconds', 'SELECT public.support_handoff_tick()')`.

- [ ] **Step 1: Write the rehearsal cases (RED):**
  - `B1` OP1 on shift; `_support_alert(R1,'help')` → R1 owner OP1, one push labelled `support-owner-alert` to `[OP1]` only, title starts with `Te toca · `.
  - `B2` nobody on shift → no owner, one push to every active ops staff account (OP1, OP2, ADM), as today.
  - `B3` OP1 and OP2 on, two alerts back to back (R1 then R2, same transaction timestamp) → owners differ.
  - `B4` `request_ride_help(R1)` as CUS with OP1 on → `support_phone` = OP1's number; with nobody on shift and OP2 the last off → OP2's number; with the help capped (3 earlier help alerts this hour) → still a `support_phone`, no owner set.
  - `B5` R1 owned by OP1 who then goes off shift alone (R1 stays hers) → `request_ride_help` on R1 returns `get_support_contact()`'s number and the help push goes to every ops staff account.
  - `B6` `request_ride_help(R1)` twice → same `support_phone`, one push.
  - `B7` handover: OP1 and OP2 on, R1 owned by OP1, `owner_assigned_at` back-dated 61 s, `support_handoff_tick()` → owner OP2, push `support-handoff` to `[OP2]`, OP1 `missed_in_a_row` = 1. Back-dated 59 s → nothing changes.
  - `B8` alone: OP1 only on shift, R1 back-dated 61 s → owner stays OP1, one `support-all-missed` push to every ops staff account, `all_missed_alert_at` set, OP1 `missed_in_a_row` = 1; a second tick changes nothing. A second ride the same way → OP1 off shift, `shift_ended_at` set, push `support-auto-offshift` to `[OP1]`, `admin_actions` `support_shift_auto_off`.
  - `B9` OP1 is the customer of R3 and the only one on shift → R3 gets no owner and the push goes to everyone.
  - `B10` OP1 opens nothing; R1 not searching any more (accepted) → the tick ignores it.
  - `B11` OP1 and OP2 on, OP1 owns R1 (searching) and R2 (opened); OP1 goes off → both pass to OP2 with two `support-handoff` pushes, result `{handed_over:2,kept:0}`. OP2 alone goes off with R1 → `{handed_over:0,kept:1}`.
  - `B12` coming on: R4 alerted with no owner, R1 owned by off-shift OP1 never opened, R2 owned by off-shift OP1 and opened → OP2 turning on gets R4 and R1 (two owner pushes), R2 stays OP1's.
  - `B13` a failing push (stub raises) keeps the assignment and logs `alert_failed`.
- [ ] **Step 2: Run** the rehearsal → B cases FAIL.
- [ ] **Step 3: Write part 2.** `_support_alert` and `request_ride_help` through `m00681_patch` (full body swap for `_support_alert`, one-anchor replacement on the `RETURN jsonb_build_object('success', true, 'code', …)` line for `request_ride_help`). In the tick, a miss counts once per assignment: only rides with `owner_opened_at IS NULL`, `all_missed_alert_at IS NULL`, status `searching`, owner on shift, assigned at or before `now() - handoff_s`. After the ride loop, every on-shift staff row with `missed_in_a_row >= misses` goes off shift and runs `_support_handoff_rides_of`.
- [ ] **Step 4: Run** the rehearsal → A and B PASS, applied twice.
- [ ] **Step 5: Commit** `feat(db): give each waiting ride one owner on shift, with handover (00681 part 2)`.

### Task 3: Migration 00681 part 3 — ownership guard, open and take, owner in the panel reads, self-check

**Files:**
- Modify: `supabase/migrations/00681_support_ride_owner.sql`, `supabase/tests/00681/run.sh`

**Interfaces:**
- Consumes: T1-T2.
- Produces:
  - `_assist_claim_or_refuse(p_ride_id uuid) RETURNS text`: NULL when the caller may act (creates the `ride_assist` row if missing; with no owner makes the caller the owner with `owner_opened_at = now()`); `'ride_owned_by_other'` when another user owns it.
  - Each of `admin_offer_ride_to_driver`, `admin_assign_ride_to_driver`, `admin_change_ride_service`, `admin_release_active_ride`, `admin_advance_active_ride`, `admin_complete_active_ride`, `admin_cancel_ride` patched to call it right after its own ride lock and self-ride checks (in `admin_cancel_ride`, before `PERFORM public._ops_allow(ARRAY[p_ride_id]);`) and `RETURN jsonb_build_object('error', v_own)` when not NULL.
  - `ops_open_ride_assist(p_ride_id uuid) RETURNS jsonb` → `{success, is_owner}`; stamps `owner_opened_at` and resets the owner's `missed_in_a_row` only when the caller is the owner.
  - `ops_take_ride_assist(p_ride_id uuid, p_expected_owner_id uuid) RETURNS jsonb` → `{success}` or `{error: 'ride_changed' | 'self_ride' | 'forbidden'}`; pushes the previous owner (`support-take`), logs `support_take_ride`.
  - `admin_support_waiting_rides_v2()`: same columns as v1 plus `owner_id uuid, owner_name text, owner_on_shift boolean, owner_assigned_at timestamptz, owner_opened_at timestamptz`.
  - `admin_ride_assist_context` and `admin_active_ride_context` gain key `owner`: `{id, name, on_shift, assigned_at, opened_at}` or null.

- [ ] **Step 1: Write the rehearsal cases (RED):**
  - `C1` R1 owned by OP1: OP2 calls each of the seven actions → `{"error":"ride_owned_by_other"}` and the ride is unchanged.
  - `C2` R4 with no owner: ADM's first `admin_offer_ride_to_driver` makes ADM the owner (the action's own refusal, e.g. `not_online`, still leaves ADM as owner).
  - `C3` `ops_take_ride_assist(R1, OP1)` by OP2 → owner OP2, push `support-take` to `[OP1]` with title `<OP2 name> tomó el viaje #<code>`; then `ops_take_ride_assist(R1, OP1)` by ADM → `ride_changed`.
  - `C4` `ops_open_ride_assist(R1)` by the owner stamps `owner_opened_at` and zeroes her `missed_in_a_row`; by someone else → `is_owner` false, nothing changes.
  - `C5` `admin_support_waiting_rides_v2()` lists R1 with `owner_name` and `owner_on_shift`; v1 still answers with its old columns.
  - `C6` both contexts carry `owner` with the five keys.
  - `C7` self-check negative proofs, each on a broken copy: a missing function, `anon` able to EXECUTE an `ops_*` function, RLS off on `support_staff`, the cron job missing.
- [ ] **Step 2: Run** → C FAIL.
- [ ] **Step 3: Write part 3**, ending with the self-check block (pattern: the end of 00673): the exact set of new functions, each SECURITY DEFINER; `anon` EXECUTE only on `get_support_contact`; RLS on `support_staff`; the md5 of every patched body equals its new value and contains no `\r`; `cron.job` has `support-handoff-tick`.
- [ ] **Step 4: Run** the full rehearsal (A, B, C PASS, applied twice, CRLF copy on a fresh database) and `pnpm check:migration-grants`.
- [ ] **Step 5: Commit** `feat(db): one owner per assisted ride in every assist action (00681 part 3)`.

### Task 4: Pure helpers in `@tricigo/utils`

**Files:**
- Create: `packages/utils/src/supportContact.ts`, `packages/utils/src/supportOwnership.ts`
- Test: `packages/utils/src/__tests__/supportContact.test.ts`, `packages/utils/src/__tests__/supportOwnership.test.ts`
- Modify: `packages/utils/src/index.ts` (export both)

**Interfaces:**
- Produces:
  - `normalizeSupportWhatsapp(raw: string): string | null`
  - `type SupportContactResult = { status: 'ok'; phone: string | null } | { status: 'unreachable' }`
  - `interface SupportPhoneStore { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }`
  - `const SUPPORT_PHONE_CACHE_KEY = 'tricigo.support_phone'`
  - `resolveSupportPhone(fetchContact: () => Promise<SupportContactResult>, store: SupportPhoneStore): Promise<string | null>`
  - `type AssistOwnership = 'mine' | 'other' | 'none'`; `assistOwnership(ownerId: string | null | undefined, viewerId: string | null | undefined): AssistOwnership`
  - `sortWaitingForViewer<T extends { owner_id: string | null; help_requested_at: string | null }>(rides: T[], viewerId: string | null): T[]`

- [ ] **Step 1: Write the failing tests:**
  - `normalizeSupportWhatsapp('+53 5512-3456')` → `'+5355123456'`; `('55123456')` → `'+5355123456'`; `('(305) 555-0100')` → `null` (no `+`, not a Cuban mobile); `('+1 305 555 0100')` → `'+13055550100'`; `('')` → `null`; `('+53 1234')` → `null`.
  - `resolveSupportPhone`: ok with a phone → returns it and stores it; ok with `null` → returns `null` and removes the cache; unreachable with a cached value → the cached value; unreachable with nothing cached → `null`; a store that throws on read → behaves as empty.
  - `assistOwnership('u1','u1')` → `'mine'`; `('u1','u2')` → `'other'`; `(null,'u2')` → `'none'`; `('u1', null)` → `'other'`.
  - `sortWaitingForViewer`: the viewer's rides first, then the original order (which already puts help first); stable for equal keys.
- [ ] **Step 2: Run** `pnpm --filter @tricigo/utils test` → FAIL (modules missing).
- [ ] **Step 3: Implement** in the two files; `normalizeSupportWhatsapp` strips spaces, dashes, dots and parentheses, keeps a leading `+`, adds `+53` to an 8-digit number starting with 5, and validates `^\+[1-9][0-9]{7,14}$`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(utils): support phone resolution and ride ownership helpers`.

### Task 5: Services in `@tricigo/api`

**Files:**
- Create: `packages/api/src/services/support-contact.service.ts`, `packages/api/src/services/support-shift.service.ts`
- Modify: `packages/api/src/services/ride-assist.service.ts`, `packages/api/src/index.ts` (export the new services and types)
- Test: `packages/api/src/services/__tests__/support-contact.test.ts`, `support-shift.test.ts`, `ride-assist.test.ts` (same `mockRpc` setup as the existing file)

**Interfaces:**
- Consumes: T4 `SupportContactResult`; RPCs from T1-T3.
- Produces:
  - `supportContactService.fetch(): Promise<SupportContactResult>` (`get_support_contact`; any error or thrown network failure → `{status:'unreachable'}`).
  - `interface SupportShiftStatus { me: { on_shift: boolean; whatsapp_phone: string | null; shift_started_at: string | null; missed_in_a_row: number } | null; on_shift: { user_id: string; name: string }[]; suggested_whatsapp: string | null }`
  - `supportShiftService.getStatus(): Promise<SupportShiftStatus>`; `supportShiftService.setShift(on: boolean, whatsapp?: string): Promise<{ handed_over: number; kept: number }>` (refusals throw `AppError` with the server code, via the file's `throwIfRefused` pattern).
  - `interface AssistOwner { id: string; name: string; on_shift: boolean; assigned_at: string | null; opened_at: string | null }`; `RideAssistContext.owner` and `ActiveRideContext.owner: AssistOwner | null`.
  - `SupportWaitingRide` gains `owner_id: string | null; owner_name: string | null; owner_on_shift: boolean | null; owner_assigned_at: string | null; owner_opened_at: string | null`; `getWaitingRides()` calls `admin_support_waiting_rides_v2`, falling back to v1 (owner fields null) on PGRST202.
  - `rideAssistService.requestHelp(rideId): Promise<{ code: string; supportPhone: string | null } | null>`.
  - `rideAssistService.openAssist(rideId: string): Promise<void>` (errors swallowed: opening must never break the page).
  - `rideAssistService.takeRide(rideId: string, expectedOwnerId: string): Promise<void>` (refusals throw).

- [ ] **Step 1: Write the failing tests:** `requestHelp` maps `support_phone` → `supportPhone` and gives `null` when absent (old server); `fetch` maps `{phone}` and turns `MISSING`, `{error}` and a rejected promise into `unreachable`; `setShift(true,'+5355123456')` sends `{ p_on: true, p_whatsapp: '+5355123456' }` and throws `AppError` code `invalid_whatsapp` on refusal; `getWaitingRides` calls v2 and falls back to v1 on `MISSING`; `takeRide` sends `p_expected_owner_id` and throws `ride_owned_by_other` / `ride_changed`; `openAssist` resolves even when the RPC errors.
- [ ] **Step 2: Run** `pnpm --filter @tricigo/api test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `pnpm --filter @tricigo/api check-types` passes.
- [ ] **Step 5: Commit** `feat(api): support shift, contact and ride owner services`.

### Task 6: Admin panel — switch, banner chip, owner strip, errors and copy

**Files:**
- Create: `apps/admin/src/components/support/SupportShiftSwitch.tsx`, `apps/admin/src/components/support/AssistOwnerStrip.tsx`
- Modify: `apps/admin/src/components/layout/Header.tsx` (mount the switch for ops staff, next to `NotificationBell`), `apps/admin/src/components/support/SupportWaitingBanner.tsx`, `apps/admin/src/hooks/useSupportWaitingRides.ts`, `apps/admin/src/app/rides/[id]/assist/page.tsx`, `apps/admin/src/components/support/AssistActiveRide.tsx`, `apps/admin/src/components/support/AssistCandidates.tsx`, `apps/admin/src/components/support/AssistServiceChange.tsx`, `apps/admin/src/components/support/assistErrors.ts`, `apps/admin/src/app/settings/platform-config/page.tsx` (the two config keys, `type: 'number'`), `packages/i18n/src/locales/{es,en,pt}/admin.json`

**Interfaces:**
- Consumes: T4 `normalizeSupportWhatsapp`, `assistOwnership`, `sortWaitingForViewer`; T5 services and types; `useAdminUser()` for the viewer id.

- [ ] **Step 1: Switch.** Off by default; turning it on with no stored number opens a dialog prefilled with `suggested_whatsapp`, validated with `normalizeSupportWhatsapp` before sending; shows "{{name}} también está en turno" for each other person on shift; turning it off shows the `handed_over` / `kept` result in a toast ("{{count}} viajes pasaron a {{name}}" / "Tus {{count}} viajes siguen contigo: no hay nadie más en turno"). Polls `getStatus` every 30 s so an automatic off-shift shows up.
- [ ] **Step 2: Banner.** Rows sorted with `sortWaitingForViewer`; chip "Tuyo" / "Lo atiende {{name}}" / "Sin asignar" from `assistOwnership`; an owner off shift reads "{{name}} (fuera de turno)".
- [ ] **Step 3: Assist page.** On load (both views) call `rideAssistService.openAssist(id)` once. `AssistOwnerStrip` on top: "Lo atiendes tú" / "Lo atiende {{name}} desde hace {{min}} min" + "Tomar este viaje" (confirm dialog, then `takeRide(id, owner.id)` and reload) / "Sin asignar · tu primera acción te lo asigna". When ownership is `'other'`, pass `disabled` to every action button in `AssistCandidates`, `AssistServiceChange`, `AssistActiveRide` and the cancel button.
- [ ] **Step 4: Errors and copy.** Add `ride_owned_by_other` ("Este viaje lo atiende otra persona. Tómalo primero si vas a actuar."), `whatsapp_required`, `invalid_whatsapp` to `CODES` and `ride_assist.error_*` in es/en/pt; config help texts `platform_config.support_handoff_after_s_help`, `platform_config.support_auto_offshift_misses_help`.
- [ ] **Step 5: Verify** `pnpm --filter admin check-types`, `pnpm --filter admin lint`, `pnpm --filter admin build` (output lists `ƒ Middleware`).
- [ ] **Step 6: Commit** `feat(admin): shift switch and one owner per assisted ride`.

### Task 7: Apps and web read the number; remove the founder's number

**Files:**
- Create: `apps/client/src/hooks/useSupportPhone.ts`, `apps/driver/src/hooks/useSupportPhone.ts` (AsyncStorage as `SupportPhoneStore`), `apps/web/src/lib/useSupportPhone.ts` (a `localStorage` store wrapped in try/catch), `packages/utils/src/__tests__/noHardcodedSupportPhone.test.ts`
- Modify: `apps/client/src/components/SupportHelpButton.tsx`, `apps/client/app/profile/help.tsx`, `apps/client/app/support.tsx`, `apps/driver/app/profile/help.tsx`, `apps/driver/app/onboarding/pending.tsx`, `apps/web/src/app/track/[id]/SupportHelpCard.tsx`, `apps/web/src/app/support/page.tsx`, `packages/utils/src/searchWait.ts` and `index.ts` (remove `SUPPORT_WHATSAPP_PHONE`), `packages/utils/src/__tests__/searchWait.test.ts` (drop its case), `packages/i18n/src/locales/{es,en,pt}/rider.json`, `packages/i18n/src/locales/{es,en,pt}/common.json`

**Interfaces:**
- Consumes: T4 `resolveSupportPhone`, `waMeLink`; T5 `supportContactService.fetch`, `rideAssistService.requestHelp`.
- Produces: `useSupportPhone(): { phone: string | null; loading: boolean }` in each app.

- [ ] **Step 1: Write the failing guard test** `noHardcodedSupportPhone.test.ts`: walks `apps/*/src`, `apps/*/app`, `apps/web/src` and `packages/*/src` (`.ts`, `.tsx`, `.json`), skipping `node_modules`, `store-metadata` and test files, and expects no file to contain `56621636`. Run `pnpm --filter @tricigo/utils test` → FAIL listing the 11 places.
- [ ] **Step 2: Help button.** `SupportHelpButton` and `SupportHelpCard` use `res?.supportPhone`, else `useSupportPhone().phone`; with a number, open `waMeLink(phone, …)` as today; with none, or when WhatsApp fails to open, show `home.support_help_no_whatsapp` with `{{phone}}` and `{{code}}`, or the new `home.support_help_no_contact` ("Escríbenos a soporte@tricigo.com con el código {{code}}.") when there is no number.
- [ ] **Step 3: Help screens.** The five other screens take `useSupportPhone()`; the WhatsApp row/link renders only with a number; e-mail and tickets stay.
- [ ] **Step 4: Copy.** `faq_a7`: "Puedes crear un ticket desde esta pantalla, escribir a soporte@tricigo.com o usar el botón de WhatsApp." (es, with en/pt equivalents); `support_help_no_whatsapp`: "No pudimos abrir WhatsApp. Escríbenos al {{phone}} con el código {{code}}.".
- [ ] **Step 5: Remove** `SUPPORT_WHATSAPP_PHONE` and its test case.
- [ ] **Step 6: Verify** the guard test PASSes; `pnpm --filter @tricigo/utils test`, `pnpm --filter client test`, `pnpm --filter driver test`, `pnpm check-types`, `pnpm lint`, `pnpm --filter web build`.
- [ ] **Step 7: Commit** `feat: take the support number from the operator on shift, not the code`.

### Task 8: Whole-branch verification

- [ ] **Step 1:** Re-run the 00681 rehearsal from scratch and every package's tests; record counts.
- [ ] **Step 2:** Start the admin preview (`.claude/launch.json`) against prod **read-only**: open `/rides` and an assist page of an old ride, check the strip and chips render and the console is clean. Do not turn the switch on or act on rides: those write to prod.
- [ ] **Step 3:** Request the code review (superpowers:requesting-code-review) and fix what it confirms.

### Task 9: Rollout (each step only with the founder's OK in chat)

- [ ] **Step 1: Prod rehearsal** inside `BEGIN … ROLLBACK` via MCP `execute_sql`: apply the file, then B1, B4, B7 and C1 with the real operator accounts and a test rider (`users.is_test`). First read the live body of `cron_http_post` (00506) and confirm it only queues through pg_net, so the rollback sends no push; if it sends synchronously, rehearse with it swapped for a recording stub inside the same transaction. Report to the founder.
- [ ] **Step 2: Apply** with MCP `apply_migration` (name `00681_support_ride_owner`); verify by object: the md5 of each patched body, `support_staff` exists with RLS, the cron job runs (`cron.job_run_details` shows a success within a minute).
- [ ] **Step 3: PR and merge** (`gh pr create`, base `master`); admin and web deploy from master. If GitHub answers 502 on merge, check the commit landed and launch the deploy by hand (memory: reference-github-merge-502).
- [ ] **Step 4: Operators.** The founder asks Lete and Melanye to turn "En turno" on once and enter their WhatsApp; confirm both rows in `support_staff`.
- [ ] **Step 5: OTA** through `eas-update.yml` (workflow_dispatch), client then driver, `rollout_percentage` 10; widen to 100 with `eas-update-ops.yml` after the founder confirms one help request reached an operator.
- [ ] **Step 6:** Remind the founder to set the WhatsApp away message pointing riders to support, for phones that have not taken the OTA yet.
