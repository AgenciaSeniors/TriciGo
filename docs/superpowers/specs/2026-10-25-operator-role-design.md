# Operator role in the admin panel — design

**Status:** approved in conversation on 2026-10-25. Plan for delivery 1 (Base): `docs/superpowers/plans/2026-10-25-operator-role-base.md`, whose "Notes from planning" are folded in here.

## Problem

TriciGo needs a person who helps run the service from the admin panel: live rides, support, driver onboarding and user accounts. The panel has `super_admin`, `admin` and `marketing` today.
- **Making them `admin`** would also give them money (wallet adjustments, gifts, top-up approval, refunds), configuration (fares, zones, flags) and the team.
- **`marketing` does not fit:** it is mostly read-only and sees no GPS, no driver documents and no ride chat.

## Decisions taken with the founder

| Question | Decision |
|---|---|
| What the operator does | Live rides, support, driver onboarding, user accounts |
| Extra screens | Reviews, fraud and collusion, fleets |
| Money | Nothing. Completing a stuck ride at the agreed fare is allowed: the operator does not choose the amount |
| A dispute that deserves a refund | The operator escalates it with a suggested amount and a reason; an admin refunds with one tap |
| Drivers | Approves, rejects and suspends (with a reason) alone. Every action is logged |
| Fleets | Approves or rejects fleet requests and the drivers a fleet invites. Corporate client accounts and their commission stay admin |
| Blocking accounts | Only passengers and drivers, never a team member |
| Deleting a pending account | Allowed, with today's blockers (no rides, no balance, never a team member) |
| Push | One person per send |
| Read-only | Wallets and movements, metrics (home, reports, launch pulse), promotions and referrals. Not POIs |
| Ride chat | Reads it, never writes |
| "No driver yet" and "asked for help" alerts | Push to operators and admins |
| SOS | A **new** push to operators and admins. Today an SOS only shows in an open panel (banner and bell) and texts the rider's trusted contacts |
| Daily digest | Without the money block, with the pending block |
| Landing page | `/` |
| Priority | Base first, then driver onboarding |
| Approach | A new role; reads through its own policies; every action through a server function (option A). Treating the operator as an admin with a deny list (B) and a permission matrix (C) were rejected |

Choices made in the design that the founder can still reverse:
- **The operator does not see:**
  - the audit log (`admin_actions`), the earnings page (`/earnings`, `get_platform_earnings`), settings and the team. It still reads wallets and movements, from which the platform's totals and each ride's commission can be worked out;
  - content, campaigns, announcements, blog, quests, partner places, POIs and competitors;
  - segments (it exports personal data), funnel, codes, validation and gifts.
- **The delivery code (OTP)** of a delivery stays hidden.
- **Driver identity and criminal record** are visible: approving a driver needs them.

## State of prod (2026-10-25)

- `user_role` = customer, driver, admin, super_admin, marketing.
- 00656, 00660, 00661 and 00664 are applied.
- 4 super_admin accounts and 2 marketing accounts.
- Next free migration number: 00667. 00662 and 00569 are taken by open PRs (#1160, #965). Re-check before writing a migration.

## What the operator opens and does

| Area | Pages | Acts |
|---|---|---|
| Home and metrics | `/`, `/reports`, `/launch-pulse` | No. Home drops the auto-actions card, which reads the audit log |
| Rides | `/live-map`, `/rides`, `/rides/[id]`, `/rides/[id]/assist` | Assists searching rides, unsticks active rides, cancels |
| Support | `/support`, `/incidents`, `/disputes`, `/lost-found` | Yes, without refunds |
| Drivers | `/drivers`, `/drivers/[id]`, `/incomplete-drivers`, `/businesses` | Yes, without wallet adjustments. On `/businesses`, only accounts that are fleets |
| Accounts | `/users`, `/users/[id]`, `/notifications` (from delivery 4) | Block, unblock, delete a pending account, push one person. Not the level, not the wallet |
| Moderation | `/reviews`, `/fraud`, `/cancellations` | Yes |
| Read-only | `/wallet`, `/wallet/receipts`, `/promotions`, `/referrals` | No |

## Design

### 1. Role and accounts

- **`operator`** is added to the `user_role` enum in its own migration. `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it (00641 split the same way).
- **Helpers**, both plpgsql with the anon-safe early return of `is_admin()` (00592):
  - `public.is_operator()`;
  - `public.is_ops_staff()`: admin, super_admin or operator.
- **`is_admin()` does not change.** Nothing gated on it today opens to the operator unless this design names it.
- **Team (00661/00664):**
  - `operator` joins the `team_invitations.role` CHECK (drop and recreate) and every role list in the team functions;
  - the `/equipo` page offers it;
  - `_team_role_rank('operator')` is 1, the same as marketing. Accepting an invitation never lowers a role, so moving someone between marketing and operator is done with "Cambiar rol".
- **Creating an operator:** a super_admin invites them from `/equipo`. Nothing else is needed.
- **`packages/types` `UserRole`** and **`team.service.ts` `TeamRole`** gain `'operator'`. The panel shows it as "Operador".

### 2. Reads

**Tables.** One policy per table, named `<table>_select_operator`, `FOR SELECT TO authenticated USING ((SELECT public.is_operator()))`. It covers:
- rides and their detail: `rides`, ride transitions, pricing snapshots and the ride chat (`ride_messages`);
- people: `users`, `driver_profiles`, driver documents, selfie checks and driver contracts;
- support: tickets and their messages, incidents, disputes, lost items, reviews, fraud alerts and collusion reviews;
- corporate accounts, fleets and fleet members;
- money, read-only: wallets, the ledger, transfers, top-up requests and receipts;
- promotions, referrals and `stuck_ride_alerts`;
- in delivery 4, with `/notifications`, `notification_log`.

**What stays closed:**
- the audit log (`admin_actions`), `get_platform_earnings` and `platform_config` beyond what is already public. Wallets and movements stay readable, so the platform's totals and each ride's commission can still be worked out; hiding them means leaving the platform account's rows (`…0001`) out of the operator's policies on `wallet_accounts`, `ledger_entries` and `ledger_transactions`;
- `delivery_details`, read directly. The panel reads a delivery through `ops_delivery_details`, a view that leaves the code out.

**Storage.** Read policies on the `driver-documents`, `driver-contracts` and `receipts` buckets. `dispute-evidence` is already public.

**Views.**
- The seven `panel_*` views and `_panel_driver_churn_risk()` add `OR (SELECT public.is_operator())` to their gate.
- In `panel_rides.canceled_by_role`, `'staff'` covers the operator too.

**`vehicles`.** `v_admin_select` changes to `is_ops_staff()` through `ALTER POLICY`. The 00644 self-check allows no third SELECT policy on that table.

**Read functions.** Their gate is patched in place on the live body, with an md5 guard, like 00642. They are:
- the metrics RPCs: the dashboard, wallet stats, `get_rides_by_*`, `get_top_drivers`, `get_peak_hours`, `get_driver_utilization`, `get_product_failures` and `admin_launch_pulse`;
- `admin_incomplete_driver_signups`;
- `admin_get_online_fleet`, whose role list is hardcoded today;
- the assist context RPCs of 00628 and 00660.

**Realtime.** The SOS bell, the live map and the banners use `postgres_changes`, which applies the RLS of the base table. The policies above are enough; a view would not work.

### 3. Actions: `ops_*` functions

The operator never writes a table directly.

**Shape.** Every action is a SECURITY DEFINER function with `search_path = ''`, executable by `authenticated` and `service_role` only, and gated by `is_ops_staff()`. Admins use the same functions: the panel keeps one code path. The existing admin write policies stay, so an old browser tab keeps working.

**Rules for every function:**
- **Never on oneself.** It refuses with DETAIL `ops_self_action` when the target is the caller's own driver profile, own account, a ride the caller is part of, the caller's ticket, a dispute or incident the caller is part of, or the caller's fleet.
- **Bound to what was shown.** It receives `expected_status` or the values the operator saw, and matches 0 rows when the row changed meanwhile (the `FLEET_MEMBER_CHANGED` 409 pattern).
- **Logged.** One `admin_actions` row with `admin_id = auth.uid()`.
- **Notices sent by the server.** Pushes and e-mails to the user go out through `cron_http_post`. Today the panel sends them from the browser with no category, and `send-push` would refuse them for an operator.
- **Errors.** A Spanish MESSAGE and a code in DETAIL.

**Silent reverts.** Inside a SECURITY DEFINER function, `auth.uid()` is still the operator. Several protection triggers bypass on `is_admin()` and otherwise restore the old values with no error, as in 00543, where 80 of 84 approved drivers were left as `customer`.
- **The fix:**
  - `_ops_allow(ids)` sets `app.ops_targets` for the transaction;
  - `_ops_acting_on(id)` returns true when `is_ops_staff()` and the id is in that list;
  - each affected trigger becomes `IF is_admin() OR _ops_acting_on(NEW.id)`, the same pattern as `app.vehicle_rereview` (00650);
  - a client cannot set `app.*` through PostgREST.
- **Affected triggers:**
  - `tg_driver_profiles_protect_admin_fields` and `tg_driver_documents_protect_review`;
  - `tg_users_protect_admin_fields`: only `is_active` and the customer→driver step. The `app.team_role_change` block stays exactly once, which the 00661 self-check requires;
  - `tg_ride_disputes_protect_columns` and `enforce_ride_update_columns`;
  - the gate line of `complete_ride_and_pay`, a one-line patch on the live body;
  - the fleet triggers, through the existing `app.trusted_fleet_update` and `app.trusted_corporate_update` flags.
- **Guards that check `current_user`** (00634, 00650, 00653, 00655, 00663) already pass inside a SECURITY DEFINER function: there `current_user` is its owner.

**Ride transitions (`enforce_ride_transition`).** The operator counts as `customer`, and as `admin` only inside an `ops_*` function acting on that ride. An operator therefore never gets admin transitions on their own ride, and `valid_transitions` does not change.

**Existing functions that open to the operator.** Their `is_admin()` gate becomes `is_ops_staff()`, with an md5 guard:
- the six assist RPCs of 00628. Offering, assigning and changing the vehicle type also gain the not-oneself rule, which they lack today;
- the four stuck-ride RPCs of 00660, which already refuse the caller's own ride;
- `admin_cancel_ride`, plus not-oneself;
- `detect_collusion_reviews`, `apply_collusion_sanction` and `reverse_collusion_sanction`, plus not-oneself;
- `admin_set_user_active`, with a positive list: a target that is not a customer or a driver needs a super_admin. This also closes today's gap, where an admin can block a marketing account.

**New functions:**
- **Drivers:**
  - `ops_set_driver_status`: approve, reject, suspend;
  - `ops_review_driver_document`;
  - `ops_add_driver_document`, after the upload through `storage-upload`;
  - `ops_log_driver_outreach`.
- **Fleets:**
  - `ops_review_fleet_account`, only for accounts with a `driver_fleets` row;
  - `ops_review_fleet_member`, which keeps the rule that a decision is bound to the row the reviewer saw.
- **Support:**
  - `ops_update_ticket` and `ops_reply_ticket`, also for marketing;
  - `ops_update_incident`;
  - `ops_update_lost_item`.
- **Disputes:** `ops_update_dispute`, `ops_resolve_dispute_without_refund` and `ops_escalate_dispute`.
- **Moderation:** `ops_set_review_visibility` and `ops_resolve_fraud_alert`.

**Never opened, and the migration asserts it:**
- money: `admin_adjust_wallet`, `admin_send_gift`, `admin_reverse_gift`, `freeze_wallet`, `unfreeze_wallet`, `approve_wallet_recharge`, `process_dispute_refund`, `admin_refund_ride_commission`, `admin_reward_referral`, `admin_invalidate_referral`, `set_referral_amounts`, `admin_send_wallet_v2_bonus_push` and `get_platform_earnings`;
- roles: `promote_user_role` and `admin_set_user_level`. The team functions stay closed too, but not through this assertion: they name the operator because it is a role that can be invited, and `_team_require_super_admin` is what keeps it out of them;
- configuration.

### 4. Disputes: escalating with a suggested amount

- **A new table, `ride_dispute_escalations`:** the dispute, the suggested amount, the reason, who escalated and when, and who resolved it and when. A separate table avoids patching 00400 again.
  - It has RLS, explicit GRANTs that include `service_role` (the 2026-10-30 rule) and a read policy for operations staff.
- **The admin** sees the proposal on the dispute and taps "Reembolsar lo sugerido". `admin_refund_escalated_dispute(escalation_id, expected_trc)` checks the amount again and calls `process_dispute_refund`, which does not change.

### 5. Alerts and the daily digest

- **Support alerts.** `_support_alert` (00628) adds `operator` to the push recipients.
- **SOS:**
  - a new AFTER INSERT trigger on `incident_reports` for `type = 'sos'` pushes to active operators and admins, through `cron_http_post` with the label `sos-staff-alert`;
  - it runs inside its own exception handler, so an SOS is never refused.
- **Digest:**
  - `team_digest_recipients` adds `operator`;
  - the template splits `seesMoney` (admins) from a new `seesPending` (admins and operators).
- **Delivery.** Pushes reach whatever TriciGo app the operator has installed with the same account, as for admins today.

### 6. Edge Functions (`_shared/panel-roles.ts`)

- **A new `isOpsRole`:** admin, super_admin or operator. `isPanelStaffRole` does not change: it opens bulk e-mail and campaigns.
- **`send-push`:**
  - the operator may send only `announcement`, to **exactly one** recipient, with no ride data;
  - the function writes the `notification_log` row instead of the browser.
- **`storage-upload`:** the operator may upload only under `driver-docs/<driver_id>/`, never to their own profile.
- **`generate-driver-contract` and `admin-delete-pending-account`:**
  - both accept the operator, with the not-oneself rule;
  - the "target is staff" blocker of `admin-delete-pending-account` covers the four panel roles. Today it lets an admin delete a marketing account.
- **`notify-document-rejection`** is called with the service key from `ops_review_driver_document`.
- **Templates:** the team invitation shows the role label; the digest gets the split above.

### 7. Panel

**`adminPanelAccess.ts`:**
- `PANEL_ROLES` adds `operator`, with `OPERATOR_ROUTES` (the pages above) and `OPERATOR_DENIED` (`/wallet/gifts`). `panelHome('operator')` is `/`.
- **`panelCanAct` is replaced by capabilities:** `panelCan(role, cap)` and a `usePanelCan().can(cap)` hook. A per-page check is not enough: `/drivers/[id]` mixes operations and money.
  - Operator, once all four deliveries are in: `detail.full`, `rides.act`, `tickets.act`, `cases.act`, `drivers.review`, `fleets.review`, `users.block`, `accounts.delete_pending`, `moderation.act`, plus a push capability in delivery 4. Delivery 1 gives it only `detail.full`.
  - Admin only: `money.act`, `corporate.clients`, `pois.act`, `promotions.write`, `promotions.approve`, `referrals.amounts`, `referrals.rewards`, `audit.read`.
  - Marketing keeps what it has today: `tickets.act`, `promotions.write`, `referrals.amounts`.
  - `tickets.act` (support tickets) and `cases.act` (incidents, disputes, lost items) are separate because marketing answers tickets but never had the others. The level selector already checks super admin, so no capability is needed for it.
- **`menuRole` with no known role** keeps marketing's menu, the smallest one. The middleware and the server still refuse everything else.

**Shell:**
- the operator gets the waiting-rides banner and the SOS bell;
- the header says "Operador" and hides "Mi perfil";
- `BottomNav` does not change: the operator gets the default four tabs, all of which it can open;
- the sidebar does not load the pending-promotions count.

**Mixed pages:**
- **`/drivers/[id]` and `/users/[id]`:** no wallet adjustment. `/users/[id]` keeps the level selector disabled for anyone but a super admin (it already is), and shows "Bloquear" only when the target is a passenger or a driver.
- **Disputes:** the refund options become "Escalar con monto sugerido".
- **`/businesses/[id]`:** approve or reject only when the account is a fleet; no commission, suspend or reactivate.
- **Referrals and promotions:** read-only.
- **`/wallet`:** no top-up approval and no bonus push button.
- **Notifications:** only the "una persona" target, with no stats.
- **Home:** no audit card.
- **Role badges:** in the users list and the team page.

### 8. Self-check of each migration

Each migration ends with a block that aborts unless:
- **Policies:** the set of `*_operator` policies is exactly the expected one, and each is SELECT, PERMISSIVE, `{authenticated}`, with its exact `qual`.
- **Functions:**
  - the set of functions whose body mentions `is_operator(` or `is_ops_staff(` is exactly the expected one, each with its md5 and no `\r`;
  - none of the never-opened functions of §3 mentions them.
- **`ops_*` functions:** each is SECURITY DEFINER, `anon` cannot execute it, and its body writes to `admin_actions`.
- **Views:** every `panel_%` view ends in the new gate. This takes over the exact-text check of 00663.
- **Helpers:** `is_operator()` and `is_ops_staff()` return false with no JWT and as `anon`, and the md5 of `is_admin()` is unchanged.

## Delivery

Each delivery follows the same steps, each with the founder's OK: local rehearsal, rehearsal in prod inside a rolled-back block, apply, merge.

1. **Base.**
   - 00667 adds the enum value.
   - 00668 adds:
     - the helpers, the reads, the view gates and the metrics and read gates;
     - `operator` in the role lists: transitions, driver approval, rating, team, digest;
     - the support alert recipients and the SOS push.
   - Panel: routes, capabilities with every operator action off, menus and header. The digest and invitation templates.
   - Afterwards operators can be invited. They see what is theirs and get the alerts and the digest. Every write is still admin-only.
2. **Driver onboarding and fleets.**
   - `_ops_allow` / `_ops_acting_on`, and the patches to the driver profile, document, users (promotion to driver) and fleet guards.
   - `ops_set_driver_status`, document review and upload, outreach, the fleet functions.
   - The `storage-upload`, `generate-driver-contract` and `admin-delete-pending-account` changes.
3. **Live rides.**
   - The transition mapping, `enforce_ride_update_columns` and the `complete_ride_and_pay` line.
   - The 00628 and 00660 functions and `admin_cancel_ride`, opened with the not-oneself rule.
4. **Support, accounts and moderation.**
   - Tickets, incidents, lost items, reviews, fraud and collusion.
   - Disputes with escalation: the new table and the admin's one tap.
   - `admin_set_user_active` with the positive list, and the one-person rule in `send-push`.

Each delivery moves the panel services to the new functions for every role and hides what the operator cannot do.

## Risks

- **Silent reverts.** Every rehearsal checks the row after the call, not only that no error came back.
- **Re-running old migrations.** Re-running 00628, 00660, 00485, 00629, 00488 or the 00663 views, which use plain `CREATE OR REPLACE`, would silently reset the gates to admin-only. To be recorded in CLAUDE.md.
- **Applying:**
  - `admin_set_user_active` has `DELETE` in its body, so its migration goes through the SQL Editor: MCP does not show the approval for it;
  - the policies on 33 tables and the seven panel views are created under `lock_timeout = '500ms'`, with the views locked first. No order of the tables agrees with every app path, so the migration is the side that gives up in a lock cycle: apply it at a quiet hour and run it again on 55P03 or 40P01;
  - CRLF is normalized.
- **Per-person audit.** `ride_transitions.actor_role` says `admin` for an operator's actions. Reports by person use `actor_id` and `admin_actions`.
- **Performance.** Every gate is wrapped in `(SELECT …)`. The live map evaluates RLS on every `driver_profiles` event, once per operator watching.
- **New tables.** Explicit GRANTs with `service_role`, checked by `pnpm check:migration-grants`.

## Testing

- **Local rehearsal** in `supabase/tests/<n>/run.sh` for each migration, using live bodies checked by md5:
  - one account of each role;
  - RED without the migration; GREEN applied twice and from a CRLF copy;
  - a negative proof for every policy, gate and self-check;
  - the operator can do nothing with money, settings or the team, and nothing on themselves;
  - each action leaves the expected row and its `admin_actions` row.
- **vitest:**
  - `adminPanelAccess`: routes, capabilities and the fallback;
  - the handlers of `send-push` (one-person rule), `storage-upload` (operator branch) and `admin-delete-pending-account`, and the digest template;
  - the services that move to the new functions.
- **Panel:** `pnpm check-types`, lint and `next build`, whose output must list `ƒ Middleware`.
- **Rehearsal in prod** inside a rolled-back block, with real accounts and a test operator created inside the block.
- **Last step:** the founder invites a real operator from `/equipo` and walks through home, a driver, a ride and a ticket, confirming that no money or settings show.
