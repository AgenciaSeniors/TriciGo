# Operator role, delivery 4: support, accounts and moderation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the operator answers tickets, works incidents, disputes and lost items, escalates a refund to an admin with a suggested amount, blocks and unblocks passengers and drivers, pushes one person, and moderates reviews, fraud alerts and the collusion queue — always through server functions, never on themselves, never touching money.

**Architecture:** migration 00673 adds `ops_*` SECURITY DEFINER functions that admins and operators share (marketing too, for tickets), a `ride_dispute_escalations` table with `admin_refund_escalated_dispute` (admin only, calls the unchanged `process_dispute_refund`), and opens `admin_set_user_active` and the three collusion RPCs to ops staff. `send-push` lets the operator send one `announcement` to exactly one person and writes the `notification_log` row itself. The panel's services go through a new `case-ops.service.ts`; the pages ask `usePanelCan().can()`.

**Tech Stack:** Postgres 16 / plpgsql (Supabase), Deno Edge Function, TypeScript services (`@tricigo/api`), Next.js 15 admin panel, vitest.

Spec: `docs/superpowers/specs/2026-10-25-operator-role-design.md` (§3, §4, §6, §7, delivery 4).

---

## What the panel writes today (surveyed 2026-11-02)

| Page | Action | Today | After |
|---|---|---|---|
| `/support` | Reply | `ticket_messages` insert + a separate `updateTicket(in_progress)` | `ops_reply_ticket` (one transaction) |
| `/support` | Resolve, close | `support_tickets` update | `ops_update_ticket` |
| `/incidents`, `/incidents/[id]` | Investigate, resolve, dismiss | update + unchecked `admin_actions` insert | `ops_update_incident` |
| `/incidents/[id]` | Hide reported review | two calls, not atomic | `ops_update_incident(..., p_hide_review => true)` |
| `/disputes` | Take ("Asignármela") | update + browser pushes (403 for an operator) | `ops_update_dispute('take')`, push from the server |
| `/disputes` | Save notes | update | `ops_update_dispute('notes')` |
| `/disputes` | Resolve `no_action` / `warning_issued` | update + ride update; **`warning_issued` sent a hidden amount to `process_dispute_refund` and refunded it** | `ops_resolve_dispute_without_refund` |
| `/disputes` | Refund (admin) | `process_dispute_refund` | unchanged; operator gets "Escalar con monto sugerido" (`ops_escalate_dispute`) |
| `/lost-found` | Notes, close | updates | `ops_update_lost_item` |
| `/users/[id]` | Block, unblock | `admin_set_user_active` (admin) | same RPC, opened to ops staff |
| `/reviews` | Show / hide | direct update | `ops_set_review_visibility` |
| `/reviews` | Feature | direct update | unchanged, admin only (`reviews.feature`) |
| `/fraud` | Resolve | direct update | `ops_resolve_fraud_alert` |
| `/cancellations` | Rescan, sanction, reverse | admin RPCs + browser push | same RPCs opened to ops staff; the warning push from the server |
| `/notifications` | Push | `sendAdminPush` + browser log insert | operator: one person, `announcement`; `send-push` writes the log |

## Files

- Create `supabase/migrations/00673_operator_support_and_moderation.sql`
- Create `supabase/tests/00673/{scaffold,tables,base,live-bodies,wiring}.sql`, `supabase/tests/00673/run.sh`
- Modify `supabase/functions/_shared/panel-roles.ts` (+ `panel-roles.test.ts`), `supabase/functions/send-push/index.ts` (+ `index.test.ts`)
- Create `packages/api/src/services/_ops-rpc.ts` (shared `callOpsRpc`), `packages/api/src/services/case-ops.service.ts` (+ tests); modify `onboarding.service.ts` to use `_ops-rpc.ts`
- Modify `packages/api/src/services/{support,dispute,lost-item,fraud,admin,notification}.service.ts` (drop the admin writes the ops functions replace; `applyCollusionSanction` no longer pushes; `sendAdminPush` skips the log when `send-push` wrote it) and their tests
- Modify `packages/utils/src/adminPanelAccess.ts` (+ test): operator capabilities, `/notifications`, new capabilities `push.one`, `push.broadcast`, `reviews.feature`
- Modify pages: `apps/admin/src/app/{support,incidents,incidents/[id],disputes,lost-found,users/[id],reviews,fraud,notifications}/page.tsx`; `apps/admin/src/lib/opsErrors.ts`
- Modify `packages/i18n/src/locales/{es,en,pt}/admin.json`
- Modify `CLAUDE.md` (operator section, delivery 4)

## Task 1: migration 00673

**Patches** (live body md5 → new md5, each replaced text exactly once, as in 00672):
- `tg_users_protect_admin_fields` (`1934b73f…`): the ops branch stops reverting `is_active` (only `admin_set_user_active` puts a user id in `app.ops_targets` without changing the role).
- `tg_ride_disputes_protect_columns` (`e7c52190…`): `IF is_admin() OR public._ops_acting_on(NEW.id) THEN RETURN NEW`.
- `admin_set_user_active` (`4fa49090…`): gate `is_ops_staff()`; a target that is not a customer or a driver needs a super_admin (closes the admin-blocks-marketing gap); `_ops_allow(ARRAY[p_user_id])` before the writes.
- `detect_collusion_reviews` (`94558654…`): gate `is_ops_staff()`.
- `apply_collusion_sanction` (`3586cce9…`): gate `is_ops_staff()`; `self_action` when the caller is the driver or the customer of the case; the warning push from the server (`_ops_notice_push`, same title and body the panel sent).
- `reverse_collusion_sanction` (`4724bd48…`): gate `is_ops_staff()`; `self_action`.

**Helper:** `_ops_notice_push(p_rpc, p_target, p_user_ids uuid[], p_title, p_body, p_data)` — one `send-push` call through `cron_http_post` (label `ops-case-notice`), no category and no preference gate (as `sendToUser`), never fails the action (logs `push_failed`). Owner only.

**New ops functions** (SECURITY DEFINER, `search_path = public, pg_catalog`, `authenticated` + `service_role`, `{error}` refusals, one `admin_actions` row):
- `ops_update_ticket(p_ticket_id, p_status, p_expected_status)` — ops staff or marketing; `self_action` on the caller's ticket; `ticket_changed`.
- `ops_reply_ticket(p_ticket_id, p_message)` — ops staff or marketing; 1–4000 characters; `is_admin = true`; `open → in_progress` in the same transaction; returns the message row.
- `ops_update_incident(p_incident_id, p_status, p_expected_status, p_notes, p_hide_review)` — open → investigating; open/investigating → resolved or dismissed; `p_hide_review` only for a `review_abuse` resolved; `self_action` for the reporter, the accused and the review's parties.
- `ops_update_lost_item(p_item_id, p_action 'notes'|'close', p_expected_status, p_notes)` — `self_action` for reporter and driver.
- `ops_update_dispute(p_dispute_id, p_action 'take'|'notes', p_expected_status, p_notes)` — take: unassigned, not resolved, not escalated → `under_review`, assigned to the caller, push both parties.
- `ops_resolve_dispute_without_refund(p_dispute_id, p_resolution 'no_action'|'warning_issued', p_expected_status, p_notes)` — `resolved_driver`, refund 0, ride `disputed → completed`, push both parties.
- `ops_escalate_dispute(p_dispute_id, p_resolution 'full_refund'|'partial_refund'|'credit', p_suggested_trc, p_expected_status, p_reason)` — amount 1..`rides.final_fare_trc` (the cap `process_dispute_refund` applies), reason ≥ 5 characters, one pending escalation per dispute, dispute → `escalated`.
- `ops_set_review_visibility(p_review_id, p_visible, p_expected_visible)` — `self_action` for reviewer and reviewee; the rating is recomputed by `trg_update_rating_avg`.
- `ops_resolve_fraud_alert(p_alert_id, p_note)` — `already_resolved`; `self_action` on an alert about the caller.

Every dispute, incident and lost-item function refuses `self_action` when the caller is a party of the ride (`_ride_context_for_caller` semantics: customer or the driver's user).

**Escalations:** table `ride_dispute_escalations` (dispute FK cascade, `suggested_trc > 0`, resolution, reason 5–1000, status `pending|refunded|closed`, escalated_by/at, resolved_by/at, refund_transaction_id; no FK to `users`, so account deletion is not blocked), one pending per dispute, RLS with a read policy for ops staff, GRANT SELECT to `authenticated` and ALL to `service_role`. Trigger `trg_ride_disputes_close_escalations` closes a pending escalation when its dispute is resolved by any path. `admin_refund_escalated_dispute(p_escalation_id, p_expected_trc)`: admin only, `amount_changed`, `self_action` for a ride party, marks the escalation refunded, calls `process_dispute_refund` (unchanged), pushes both parties.

**notification_log:** read policy for the operator (the `/notifications` history).

**Checks:** every md5; the full list of functions allowed to call the ops checks (00668 + 00671 + 00672 + 00673); money and role functions (now also `admin_refund_escalated_dispute`) never name the operator; each `ops_*` function SECURITY DEFINER, closed to `anon`, open to `authenticated`, logs; fifteen ops functions; helpers closed; the escalation table has RLS, the ops read policy and the `service_role` grant.

## Task 2: local rehearsal `supabase/tests/00673/run.sh`

`none` → RED (functions missing, operator refused); with the migration → GREEN, applied twice, a snapshot of every other function, a CRLF copy, negative proofs of the checks. Cases: each function as operator, admin, marketing (tickets only), a customer; self refusals; stale-state refusals; operator blocks a driver (sessions closed, offline, logged), cannot block marketing; admin cannot block marketing, super_admin can; escalation → admin refund (stubbed `process_dispute_refund` locally; the real one in the prod rehearsal), amount_changed, the closing trigger; collusion sanction push queued; ticket reply sets `in_progress`.

## Task 3: `send-push`

`isOpsRole` callers pass the auth gate; `canSendPush(role, category, recipients)` lets the operator send only `announcement` to exactly one distinct recipient; operator `data` is dropped; for an operator call the function writes `notification_log` (`target_type 'user'`, `sent_by` the caller) and answers `logged: true`. Tests in `send-push/index.test.ts` and `panel-roles.test.ts`.

## Task 4: services and panel

`case-ops.service.ts` wraps the eleven functions (`CASES_UNAVAILABLE` when 00673 is missing); pages switch to it; capabilities `tickets.act`, `cases.act`, `users.block`, `moderation.act`, `push.one` for the operator; `/notifications` for the operator with only the one-person audience and no inbox stats (`push.broadcast`); "Destacar" behind `reviews.feature`; "Bloquear" only for passengers and drivers unless super admin; disputes page: operator escalates refunds, admin sees the pending escalation and "Reembolsar lo sugerido". New `ops_errors.*` texts in es/en/pt.

## Task 5: prod rehearsal (rolled-back block) — then apply, deploy `send-push`, merge, each with the founder's OK.
