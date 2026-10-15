# Wider marketing view of the admin panel — design

**Status:** approved in conversation on 2026-10-15. Builds on the marketing role (`2026-10-08-marketing-role-design.md`, migrations 00641/00642).

## Problem

Marketing sees ten pages today: launch pulse, funnel, code performance, segments, reports, referrals, promotions, campaigns, announcements and blog. The founder wants them to find the app's biggest weak points, and for that they need four more areas:

- what users say: reviews, support tickets, disputes;
- rides that fail: the ride list and detail, cancellation reasons;
- the driver side: the driver list and detail, incomplete sign-ups;
- product failures: places searched that do not exist, push reach, app versions, failed payments.

## Decisions taken with the founder

| Question | Decision |
|---|---|
| Areas | All four above. |
| Read or act | Read everything. The only action is **support**: reply to tickets and change their status. |
| Approach | Open the existing admin pages to marketing in read-only mode (option B). A single "weak points" page (A) and a mix (C) were rejected. |
| Product failures | A new "Fallas del producto" section in Reportes, plus Lugares and Validación read-only. |
| Page list and hidden data | As in the table below, approved as shown. The ride chat stays hidden. |
| Server approach | As in "Server" below. |
| Lost items (after review) | Marketing reads them through a view without support's internal notes and the return arrangements (`admin_notes`, `return_location`, `return_notes`). |
| Ride pricing breakdown (after review) | The commission in `ride_pricing_snapshots` stays visible to marketing. |

Facts measured in prod on 2026-10-15 that shaped the design:
- 7 reviews (3 with a comment), 3 support tickets, 0 disputes, 0 incidents, 0 lost items. The richest signals are rides, cancellations, driver supply and onboarding.
- 141 of the 214 canceled rides only say "Cancelado por el pasajero": the app does not record why riders cancel. That is itself a weak point; this design only makes it visible.
- `push_registration_status`: of 189 rows, 87 are `registered`; the rest are `denied` (39), `error` (55) and `blocked` (8).
- 9 failed payments: 4 "Invalid card number", 4 "netopia returned non-JSON response", 1 "Declined".
- `app_opens` is empty until a build that reports app opens is out.
- Nothing in the panel reads `poi_import_queue` (7 rows).

## What marketing sees

Rule: marketing reads; it never sees live GPS or coordinates, the tracking link (`share_token`), wallets or balances, driver documents, selfies or contracts, identity number, home address or criminal record, and gets no button that approves, cancels or moves money. The only exception to "read only" is support.

| Page | Marketing sees | Hidden |
|---|---|---|
| Viajes (list) | What admins see today, filters, CSV, plus cancellation reason and who canceled | Coordinates, tracking link |
| Viaje (detail) | Status timeline, fare and its breakdown (commission included), rider and driver (name, phone), dispatch round, waiting time and its charge | Ride chat, delivery code and photos, "Cancelar" and "Ayudar" buttons |
| Conductores (list) | Name, phone, vehicle, status, rating, sign-up date, CSV | GPS |
| Conductor (detail) | Status, dates, rating, rides, acceptance rate, last seen online, municipality, vehicle, which documents were uploaded and whether they were approved (no file), reviews, churn risk | Wallet, document files, selfies, contract, identity number, address, criminal record, earnings, every action |
| Usuarios (list and detail) | Profile, rides, total spent on rides, reviews | Wallet, transfers, penalties, block, change level, delete |
| Reseñas | Everything: rating, comment, tags, who rated whom | Hide and feature |
| Soporte | Tickets and messages; reply (shown as support) and change status | Priority and assignment |
| Disputas | Reason, status, parties and what each wrote | Evidence, refunds, every action |
| Incidentes, Objetos perdidos | List and detail | Change status, notes, close, hide review; for a lost item, support's notes and where and how it goes back |
| Registros incompletos | Who got stuck, which document is missing, contacts already made | Log a contact |
| Lugares, Validación | Places, place suggestions, the three validation metrics | Create, edit, approve |
| Reportes | New "Fallas del producto" section | — |

Left out on purpose: **Cancelaciones** is the anti-collusion queue, not the list of canceled rides. Cancellation reasons are shown in Viajes.

## Server

The principle from the marketing role still holds: everything hidden is hidden in the database, not only on screen. Marketing gets new SELECT access; no existing policy, grant or gate is loosened for any other role.

### 1. Views for tables with sensitive columns

RLS cannot hide columns, so these are read through views. They follow the 00642 pattern: `security_invoker = false`, `security_barrier`, `WHERE (SELECT is_admin()) OR (SELECT is_marketing())`, SELECT granted to `authenticated` and `service_role`, nothing to `anon`.

- **`panel_rides`**, extended with: `ride_mode`, `is_scheduled`, `scheduled_at`, `accepted_at`, `driver_arrived_at`, `pickup_at`, `arrived_at_destination_at`, `completed_at`, `canceled_at`, `canceled_by`, `cancellation_reason`, `cancellation_reason_code`, `estimated_distance_m`, `actual_distance_m`, `estimated_duration_s`, `actual_duration_s`, `wait_time_minutes`, `wait_time_charge_cup` (the wait columns the app fills; `wait_time_seconds` and `wait_charge_cup` are empty in every ride), `passenger_count`, `shared_ride`, `is_split`, `corporate_account_id`, `partner_place_id`, `partner_discount_cup`, `tip_amount`, `surge_multiplier`, `driver_gps_status` (a status flag, not coordinates), `searching_seen_at`, `last_dispatched_at`, `payment_status`, and a computed `canceled_by_role`, null when the ride is not canceled: `customer` (the ride's rider), `driver` (its driver), `staff` (an admin or super admin; marketing cannot cancel), `system` (nobody: `canceled_by` is null) or `unknown` (anyone else). The role is the canceler's role today, not at the time of the cancellation: a rider who later became an admin shows as `staff`. Accepted: there is no record of the role at cancel time, and it changes rarely. Still without coordinates (`*_location`, `*_lat`, `*_lng`), `share_token`, pickup and dropoff notes, the wallet/cash split and the payment intent.
- **`panel_driver_profiles`**, extended with: `status`, `rating_avg`, `acceptance_rate`, `total_rides_offered`, `city_id`, `zone_id`, `municipality`, `province`, `created_at`, `approved_at`, `suspended_at`, `suspended_reason`, `is_on_break`, `auto_accept_enabled`, `last_heartbeat_at` (last seen, not a position), `auto_offline_at`, `terms_accepted_at`, the user's `full_name`, `phone` and `email`, and the active vehicle's `vehicle_type`, `plate_number`, `vehicle_make`, `vehicle_model`, `vehicle_color`, `vehicle_year`. The vehicle goes through the view and not through a SELECT policy on `vehicles`: since 00644 any policy there counts as a leak, and a view returns only what the panel needs. Still without `current_location`, `current_heading`, `identity_number`, `address`, `has_criminal_record`, `criminal_record_details`, `negative_balance_since`, `is_financially_eligible`, `quota_blocked`, `match_score`, `custom_per_km_rate_cup`, `preferences`. Marketing can still rebuild `match_score` from `driver_score_events`, which section 2 opens on purpose. Accepted: those events are what marketing needs to understand driver quality.
- **`panel_driver_documents`** (new): `id`, `driver_id`, `document_type`, `uploaded_at`, `is_verified`, `verified_at`, `rejection_reason`. No `storage_path`, file name, face-match or liveness data.
- **`panel_driver_churn_risk`** (new): the `driver_churn_risk` columns without `earnings_this_week` and `earnings_last_week`.
- **`panel_ride_disputes`** (new): `ride_disputes` without `evidence_urls`, `respondent_evidence_urls`, `refund_amount_trc`, `refund_transaction_id`, `admin_notes`, `ride_estimated_fare_trc`, `ride_final_fare_trc`.
- **`panel_incident_reports`** (new): `incident_reports` without `evidence_urls` and `resolution_notes`.
- **`panel_lost_items`** (new): `lost_items` without `admin_notes`, `return_location` and `return_notes` (support's notes and the return arrangements, which the owner keeps to support).

Extending an existing view with `CREATE OR REPLACE VIEW` keeps its grants and may only add columns at the end, so the new columns are appended. The 00642 block that refuses any marketing policy on `rides` or `driver_profiles` stays.

**Who reads the views.** The Viajes and Conductores lists switch to the views for every role, as 00642 did for funnel and segments: admins lose nothing, because the views carry every column those lists use (checked in the plan). Detail pages keep the full read for admins and use a reduced read for marketing.

### 2. SELECT policies for tables with nothing to hide

New `*_select_marketing` policies, `FOR SELECT TO authenticated USING ((SELECT is_marketing()))`, on: `reviews`, `support_tickets`, `ticket_messages`, `ride_transitions`, `ride_pricing_snapshots` (the commission included, as decided), `driver_score_events`, `driver_outreach_log`. `review_tags` needs none: its policy already shows a tag to whoever can read its review. `lost_items` gets no policy: marketing reads it through `panel_lost_items`, and the migration refuses to run if any marketing policy exists on it.

### 3. RPCs the pages call

Gate widened from `is_admin()` (or `role IN ('admin','super_admin')`) to admin or marketing, by patching the live body in place with an md5 guard: `admin_incomplete_driver_signups`, `get_auto_accept_rate`, `get_auto_nav_rate`, `get_override_frequency`, `admin_list_pois`, `list_poi_submissions`. The write RPCs of those pages (`admin_create_poi`, `admin_update_poi`, `approve_poi_submission`, `reject_poi_submission`, `apply_collusion_sanction`, `admin_cancel_ride`, `admin_adjust_wallet`, `admin_set_user_active`, and so on) do not change.

### 4. Support: the only writes

- **Read:** the policies in section 2.
- **Reply:** a new INSERT policy on `ticket_messages` for marketing (`sender_id = auth.uid()`, the ticket exists). `tg_ticket_messages_client_guard` (00653) forces `is_admin := false` for anyone who is not an admin; it now forces `is_admin := true` for marketing, so the reply is shown as support whatever the client sends.
- **Change status:** a new UPDATE policy on `support_tickets` for marketing, and a new BEFORE UPDATE guard: for a marketing writer only `status`, `resolved_at` and `updated_at` may change, `status` must be a valid value, and `resolved_at` is set by the server when the status becomes `resolved` or `closed` (from resolved to closed it keeps its date, or gets one if it had none). Anything else fails with a Spanish MESSAGE and DETAIL `ticket_column_staff_only`. Admin writes are unchanged. The guard must be the first BEFORE UPDATE row trigger of `support_tickets` by name, and the migration checks it.

### 5. "Fallas del producto"

New RPC `get_product_failures(p_days int)`, SECURITY DEFINER, gated admin or marketing, EXECUTE for `authenticated` and `service_role` only. The period is clamped to 1–365 days (30 by default). Test accounts and the two system accounts (`…0001`, the platform, and `…0099`, deleted users) are left out of every block. It returns one jsonb with:
- **places not found:** the places in `poi_import_queue`, one per name (compared without case, accents or outer spaces, shown with its latest spelling cut to 80 characters), with the rides and the distinct riders of the period that asked for each. 00584 does not queue a name again while a pending row of that name sits within ~200 m, so a queue row is a place, not a request: the demand is counted on the rides. A ride asked for a place when its pickup or dropoff venue (00584's `_poi_leading_venue_name`, the text before the first comma) has that name; by name only, so a ride to a place of the same name elsewhere counts too. A place is listed when it was queued in the period or a ride of the period asked for it, ordered by rides. Each item: `name`, `rides`, `riders`, `last_seen` (its latest queue row) and `imported` (how many of its queue rows were imported). Queue rows and rides of test and system accounts are left out; a queue row without a ride stays. No coordinates.
- **push reach:** `push_registration_status` counted by app and outcome, for rows reported in the period (`updated_at`), plus the share of active riders and drivers (seen in the period) with at least one row in `user_devices`.
- **app versions:** `app_opens` counted by app, version and platform, for opens in the period.
- **failed payments:** `payment_intents` with status `failed` in the period, grouped by `provider_error_code` or else the start of `error_message`, cut to 60 characters, with counts. No amounts and no user ids.

## Admin panel

- **Allow-list:** `MARKETING_ROUTES` gains `/rides`, `/drivers`, `/users`, `/reviews`, `/support`, `/disputes`, `/incidents`, `/lost-found`, `/incomplete-drivers`, `/pois`, `/validation`. The routes `/rides/[id]/assist` and `/cancellations` stay closed: the allow-list check gains an explicit deny list for sub-pages, tested in `adminPanelAccess` tests.
- **Menus:** Sidebar and BottomNav already filter by the allow-list.
- **Read-only mode:** each page reads `usePanelRole()` and, for marketing, does not render action buttons, forms or modals (except support). The server refuses those actions anyway.
- **Services:** list reads go to the views. Detail reads gain a marketing variant (`getRideDetailForPanel`, `getDriverDetailForPanel`, `getUserDetailForPanel`) that only touches the views and the tables in section 2. The admin variants do not change.
- **Reportes:** a "Fallas del producto" section with the four blocks, a period selector (7, 30, 90 days) and empty states that explain why a block is empty (for example "Se llena cuando salga la versión que reporta aperturas").

## Testing

- **Rehearsal** `supabase/tests/00663/run.sh` (00663 was the next free number on 2026-10-15, with 00662 reserved by #1160; re-check before writing the migration) on local Postgres 16 with the live prod bodies in the scaffold, RED without the migration and GREEN with it applied twice plus a CRLF copy:
  - marketing reads every new view and table; a passenger reads none of them; admins read the same as before;
  - no view exposes a coordinate, `share_token`, wallet column, document path, identity number, address or criminal record (checked by column name against `information_schema`, so a column added later fails the test);
  - marketing cannot write to any of these tables except the support reply and status, and the reply is stored with `is_admin = true`;
  - marketing cannot change ticket priority, assignment, subject or description;
  - each widened RPC answers marketing and still refuses a passenger; the write RPCs still refuse marketing;
  - `get_product_failures` returns the four blocks with exactly their keys, no uuid and, at any depth, no key that names a person, a ride or a coordinate; counts the rides and riders that asked for each place (not its queue rows); keeps to the period, leaves test and system accounts out of every block, and refuses a passenger;
  - each view's exact columns and grants; nothing else in the database changes (a before/after snapshot);
  - the migration's self-checks: every policy exactly as created, the hidden columns of each view and any column of a panel view named like a coordinate, the exact gate at the end of every panel view, the guard's trigger order, SECURITY DEFINER and the search_path of the functions it creates, and the md5 of every body it patches or creates (a CRLF copy gives the same bodies);
  - negative proofs of those self-checks.
- **Unit tests:** `adminPanelAccess` (new routes, the deny list), the panel services (view reads, marketing variants), the product-failures parser.
- **Browser:** the pages as marketing against a local build, checking that no action button renders and that the hidden sections are absent.

## Out of scope

- Notifying the user when support replies. Today nobody is notified; it is a weak point worth its own task.
- Recording why riders cancel (the generic "Cancelado por el pasajero").
- Opening the ride chat, wallets, documents or GPS.
