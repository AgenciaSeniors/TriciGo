# Wider marketing view of the admin panel — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marketing opens eleven more admin pages read-only, answers support tickets, and sees a "Fallas del producto" section in Reportes, without ever reading GPS, the tracking link, wallets, driver documents or identity data.

**Architecture:** Migration 00663 adds what marketing may read on the server: panel views without the sensitive columns, SELECT policies on tables with nothing to hide, a wider gate on six read RPCs, a support reply/status path, and a `get_product_failures()` RPC. The panel adds those routes to the marketing allow-list, reads lists through the views for every role, renders a read-only detail component for marketing on the ride, driver and user pages, and hides every action button for marketing on the other pages.

**Tech Stack:** Postgres 16 (Supabase), plpgsql, Next.js 15 App Router (admin), React 19, TypeScript, vitest, supabase-js.

**Spec:** `docs/superpowers/specs/2026-10-15-marketing-visibility-design.md`.

**Branch:** `claude/hopeful-shannon-g3theu` (PR #1163). Migration number **00663**: on 2026-10-15 master ended at 00661 and the open PR #1160 reserved 00662. Re-check before writing the migration and again before pushing:

```bash
git fetch origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
```

and, for every open PR, `git fetch origin <branch>` then `git diff --name-only origin/master...FETCH_HEAD -- supabase/migrations`.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00663_marketing_wider_view.sql` (new) | Views, policies, RPC gates, support guard, `get_product_failures`, self-checks |
| `supabase/tests/00663/scaffold.sql` (new) | Tables and prod policies 00663 touches, on top of the 00642 rehearsal scaffold |
| `supabase/tests/00663/live-bodies.sql` (new) | The seven live function bodies 00663 patches, dumped from prod |
| `supabase/tests/00663/seed.sql` (new) | Rows the tests read |
| `supabase/tests/00663/run.sh` (new) | Rehearsal runner: RED without the migration, GREEN with it |
| `packages/utils/src/adminPanelAccess.ts` | New marketing routes, the assist deny rule, `panelCanAct()` |
| `packages/utils/src/__tests__/adminPanelAccess.test.ts` | Tests for the above |
| `packages/api/src/services/_search.ts` (new) | `escapeLikePattern`, `rideCodePrefix` moved out of admin.service |
| `packages/api/src/services/panel-read.service.ts` (new) | Every read marketing does through views; product failures parser |
| `packages/api/src/services/__tests__/panel-read.test.ts` (new) | Tests for the service |
| `packages/api/src/index.ts`, `packages/api/package.json` | Export the service |
| `apps/admin/src/lib/useCanAct.ts` (new) | `useCanAct()` hook for the pages |
| `apps/admin/src/lib/rideCancel.ts` (new) | Label of who canceled a ride |
| `apps/admin/src/components/panel/RideDetailReadOnly.tsx` (new) | Marketing's ride detail |
| `apps/admin/src/components/panel/DriverDetailReadOnly.tsx` (new) | Marketing's driver detail |
| `apps/admin/src/components/panel/UserDetailReadOnly.tsx` (new) | Marketing's user detail |
| `apps/admin/src/components/panel/ProductFailuresSection.tsx` (new) | The new Reportes section |
| `apps/admin/src/app/rides/page.tsx`, `drivers/page.tsx` | Lists read the views |
| `apps/admin/src/app/rides/[id]/page.tsx`, `drivers/[id]/page.tsx`, `users/[id]/page.tsx` | Role switch to the read-only component |
| `apps/admin/src/app/reviews/page.tsx`, `disputes/page.tsx`, `incidents/page.tsx`, `incidents/[id]/page.tsx`, `lost-found/page.tsx`, `incomplete-drivers/page.tsx`, `pois/page.tsx`, `pois/submissions/page.tsx` | Hide actions for marketing; disputes and incidents read the views |
| `apps/admin/src/app/reports/page.tsx` | Mount the new section |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` | New texts |
| `CLAUDE.md` | Rules for the wider marketing view |

---

## Task 1: Rehearsal scaffold, live bodies and seed

**Files:**
- Create: `supabase/tests/00663/scaffold.sql`
- Create: `supabase/tests/00663/live-bodies.sql`
- Create: `supabase/tests/00663/seed.sql`

The rehearsal builds on the 00642 rehearsal: `supabase/tests/00642/scaffold.sql` is prod as of 2026-10-08, and applying 00641 and 00642 to it gives prod's marketing role. This scaffold adds the columns, tables, policies and live bodies 00663 touches. Everything is created as the non-superuser role `postgres`, as in prod, so RLS applies to the API roles and not to the owner. PostGIS is not needed: coordinates are `text` stand-ins, and `admin_list_pois` / `list_poi_submissions` are only called to check their gate.

- [ ] **Step 1: Dump the seven live bodies from prod**

Run this read-only query through the Supabase MCP (`execute_sql`, project `lqaufszburqvlslpcuac`):

```sql
SELECT string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' ORDER BY p.proname)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('admin_incomplete_driver_signups', 'admin_list_pois', 'get_auto_accept_rate',
                    'get_auto_nav_rate', 'get_override_frequency', 'list_poi_submissions',
                    'tg_ticket_messages_client_guard');
```

Write the result to `supabase/tests/00663/live-bodies.sql` behind this header (keep each `$function$` body byte for byte; `pg_get_functiondef` ends without a semicolon, so the `|| ';'` above adds it):

```sql
-- The live bodies 00663 patches, dumped from prod on 2026-10-15 with pg_get_functiondef.
-- run.sh (L1) checks every one against prod's md5(prosrc). Do not edit by hand: re-dump.
SET ROLE postgres;
```

and end the file with `RESET ROLE;`.

- [ ] **Step 2: Write `scaffold.sql`**

```sql
-- Scaffold for the 00663 rehearsal (marketing reads more of the admin panel).
-- Runs after supabase/tests/00642/scaffold.sql + 00641 + 00642 (prod's marketing role) and adds
-- what 00663 touches, reduced to the columns the code under test reads, with prod's policies as
-- of 2026-10-15. Coordinates are text stand-ins (no PostGIS): no test reads them, and the views
-- must leave them out by name.
SET ROLE postgres;

-- Columns 00663's views read or must leave out.
ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS is_scheduled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS driver_arrived_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_at timestamptz,
  ADD COLUMN IF NOT EXISTS arrived_at_destination_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz,
  ADD COLUMN IF NOT EXISTS canceled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_reason_code text,
  ADD COLUMN IF NOT EXISTS estimated_distance_m integer,
  ADD COLUMN IF NOT EXISTS actual_distance_m integer,
  ADD COLUMN IF NOT EXISTS estimated_duration_s integer,
  ADD COLUMN IF NOT EXISTS actual_duration_s integer,
  ADD COLUMN IF NOT EXISTS wait_time_seconds integer,
  ADD COLUMN IF NOT EXISTS wait_charge_cup numeric,
  ADD COLUMN IF NOT EXISTS passenger_count integer,
  ADD COLUMN IF NOT EXISTS is_split boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tip_amount integer,
  ADD COLUMN IF NOT EXISTS surge_multiplier numeric,
  ADD COLUMN IF NOT EXISTS driver_gps_status text,
  ADD COLUMN IF NOT EXISTS searching_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS pickup_location text,
  ADD COLUMN IF NOT EXISTS actual_dropoff_location text,
  ADD COLUMN IF NOT EXISTS pickup_lat double precision,
  ADD COLUMN IF NOT EXISTS pickup_lng double precision,
  ADD COLUMN IF NOT EXISTS dropoff_lat double precision,
  ADD COLUMN IF NOT EXISTS dropoff_lng double precision,
  ADD COLUMN IF NOT EXISTS pickup_notes text,
  ADD COLUMN IF NOT EXISTS dropoff_notes text,
  ADD COLUMN IF NOT EXISTS wallet_amount_cup integer,
  ADD COLUMN IF NOT EXISTS cash_amount_cup integer,
  ADD COLUMN IF NOT EXISTS payment_intent_id uuid;

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS acceptance_rate numeric,
  ADD COLUMN IF NOT EXISTS total_rides_offered integer,
  ADD COLUMN IF NOT EXISTS city_id uuid,
  ADD COLUMN IF NOT EXISTS zone_id uuid,
  ADD COLUMN IF NOT EXISTS municipality text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS is_on_break boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_accept_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_offline_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_number text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS has_criminal_record boolean,
  ADD COLUMN IF NOT EXISTS criminal_record_details text,
  ADD COLUMN IF NOT EXISTS negative_balance_since timestamptz;

-- auth.users: admin_incomplete_driver_signups reads last_sign_in_at.
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, last_sign_in_at timestamptz);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(id),
  type text NOT NULL,
  make text, model text, year integer, color text,
  plate_number text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(id),
  document_type text NOT NULL,
  storage_path text NOT NULL,
  file_name text,
  uploaded_at timestamptz DEFAULT now(),
  is_verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  rejection_reason text,
  face_match_score numeric,
  liveness_passed boolean
);
CREATE TABLE public.driver_score_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL,
  event_type text NOT NULL,
  delta numeric NOT NULL DEFAULT 0,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_outreach_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_profile_id uuid NOT NULL,
  admin_id uuid,
  channel text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid,
  reviewer_id uuid NOT NULL,
  reviewee_id uuid NOT NULL,
  rating integer NOT NULL,
  comment text,
  is_visible boolean NOT NULL DEFAULT true,
  is_featured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.review_tags (review_id uuid NOT NULL, tag_key text NOT NULL);
CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  ride_id uuid,
  category text, subject text, description text,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  resolved_at timestamptz
);
CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.users(id),
  message text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lost_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid, reporter_id uuid NOT NULL, driver_id uuid,
  description text, photo_urls text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'reported',
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ride_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL, opened_by uuid NOT NULL,
  reason text NOT NULL, description text,
  evidence_urls text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open', priority text NOT NULL DEFAULT 'normal',
  respondent_id uuid, respondent_message text,
  respondent_evidence_urls text[] NOT NULL DEFAULT '{}',
  respondent_replied_at timestamptz,
  resolution text, resolution_notes text,
  refund_amount_trc integer, refund_transaction_id uuid,
  assigned_to uuid, admin_notes text,
  sla_first_response_at timestamptz, sla_resolution_deadline timestamptz,
  support_ticket_id uuid, incident_report_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  ride_estimated_fare_trc integer, ride_final_fare_trc integer
);
CREATE TABLE public.incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid, reported_by uuid NOT NULL, against_user_id uuid,
  type text NOT NULL, severity text NOT NULL DEFAULT 'medium',
  description text NOT NULL DEFAULT '',
  evidence_urls text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open',
  resolved_by uuid, resolved_at timestamptz, resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  review_id uuid
);
CREATE TABLE public.poi_import_queue (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ride_id uuid, endpoint text NOT NULL DEFAULT 'dropoff', name text NOT NULL,
  lat double precision, lng double precision,
  status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  poi_id bigint, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE public.push_registration_status (
  user_id uuid NOT NULL, app text NOT NULL, outcome text NOT NULL,
  platform text, detail text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app)
);
CREATE TABLE public.app_opens (
  user_id uuid NOT NULL, app text NOT NULL, device_id text NOT NULL,
  app_version text, platform text,
  first_opened_at timestamptz NOT NULL DEFAULT now(), last_opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app, device_id)
);
CREATE TABLE public.payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, status text NOT NULL,
  amount_usd numeric, error_message text, provider_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, push_token text NOT NULL, platform text
);
CREATE TABLE public.validation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid, event_type text NOT NULL, properties jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Only created so the live admin_list_pois / list_poi_submissions bodies have their tables.
CREATE TABLE public.cuba_pois (
  id bigint PRIMARY KEY, name text, name_normalized text, category text, subcategory text,
  tricigo_category text, address text, municipality text, province text, location text,
  source text, source_ids jsonb, phone text, website text, socials jsonb, hours text,
  confidence real, is_admin boolean, is_active boolean, importance smallint,
  synced_at timestamptz, updated_at timestamptz
);
CREATE TABLE public.cuba_pois_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submitted_by uuid, name text,
  tricigo_category text, location text, address text, notes text, status text,
  submitter_role text, created_at timestamptz DEFAULT now(), moderator_id uuid,
  moderated_at timestamptz, rejection_reason text, promoted_poi_id bigint
);

-- driver_churn_risk is a security_invoker view in prod; this one has its columns.
CREATE VIEW public.driver_churn_risk WITH (security_invoker = true) AS
SELECT dp.id AS driver_profile_id, dp.user_id, u.full_name, dp.rating_avg, dp.total_rides_completed,
       dp.acceptance_rate, dp.is_online, dp.status, 3 AS days_since_last_ride,
       1200 AS earnings_this_week, 900 AS earnings_last_week,
       0.4::numeric AS churn_risk_score, 'medium'::text AS risk_level
FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id;

-- RLS and prod's policies (2026-10-15).
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_outreach_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lost_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ride_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.poi_import_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_registration_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ride_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ride_pricing_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY v_select ON public.vehicles FOR SELECT
  USING (driver_id IN (SELECT id FROM public.driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY dd_select ON public.driver_documents FOR SELECT
  USING (driver_id IN (SELECT id FROM public.driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY "Admins read score events" ON public.driver_score_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')));
CREATE POLICY driver_outreach_log_admin_select ON public.driver_outreach_log FOR SELECT TO authenticated
  USING ((SELECT is_admin()));
CREATE POLICY rev_select ON public.reviews FOR SELECT
  USING (reviewer_id = (SELECT auth.uid()) OR reviewee_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY rt_select ON public.review_tags FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.reviews r WHERE r.id = review_tags.review_id));
CREATE POLICY "Users read own tickets" ON public.support_tickets FOR SELECT
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')));
CREATE POLICY "Users create own tickets" ON public.support_tickets FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins update tickets" ON public.support_tickets FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')));
CREATE POLICY "Ticket participants read messages" ON public.ticket_messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = ticket_messages.ticket_id
         AND (t.user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))))));
CREATE POLICY "Ticket participants insert messages" ON public.ticket_messages FOR INSERT
  WITH CHECK (sender_id = auth.uid() AND EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = ticket_messages.ticket_id
         AND (t.user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))))));
CREATE POLICY lost_items_select ON public.lost_items FOR SELECT
  USING (reporter_id = auth.uid() OR driver_id = auth.uid() OR is_admin());
CREATE POLICY dispute_select ON public.ride_disputes FOR SELECT
  USING (opened_by = auth.uid() OR respondent_id = auth.uid() OR is_admin());
CREATE POLICY ir_select ON public.incident_reports FOR SELECT
  USING (reported_by = (SELECT auth.uid()) OR against_user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY poi_import_queue_admin_read ON public.poi_import_queue FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY prs_own ON public.push_registration_status FOR ALL USING (user_id = auth.uid());
CREATE POLICY prs_admin ON public.push_registration_status FOR ALL USING (is_admin());
CREATE POLICY pi_own_select ON public.payment_intents FOR SELECT
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')));
CREATE POLICY ud_own ON public.user_devices FOR ALL USING (user_id = auth.uid());
CREATE POLICY admins_read_all ON public.validation_events FOR SELECT USING (is_admin());
CREATE POLICY rt_select ON public.ride_transitions FOR SELECT
  USING (ride_id IN (SELECT id FROM public.rides WHERE customer_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY rps_select ON public.ride_pricing_snapshots FOR SELECT
  USING (ride_id IN (SELECT id FROM public.rides WHERE customer_id = (SELECT auth.uid())) OR is_admin());

-- app_opens is a lock table in prod (00622): service_role only.
REVOKE ALL ON public.app_opens FROM anon, authenticated;
-- driver_churn_risk: anon has no SELECT in prod (00532).
REVOKE SELECT ON public.driver_churn_risk FROM anon;

RESET ROLE;
\ir live-bodies.sql
SET ROLE postgres;
CREATE TRIGGER trg_ticket_messages_client_guard BEFORE INSERT ON public.ticket_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_ticket_messages_client_guard();
RESET ROLE;
```

- [ ] **Step 3: Write `seed.sql`**

User ids come from the 00642 scaffold: Ana `a…01` admin, Sara `a…02` super_admin, Carla `c…01` customer, Diego `c…02` driver (profile `d…02`), Mara `c…03` (run.sh makes her marketing).

```sql
-- Rows the 00663 tests read. Runs as the owner (RLS does not apply).
SET ROLE postgres;
INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_address, dropoff_address,
  share_token, pickup_lat, pickup_lng, canceled_at, canceled_by, cancellation_reason, created_at)
VALUES
  ('f0000000-0000-4000-8000-000000000010', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'canceled', 'Calle 23 e/ L y M', 'Prado 100',
   'tok-secret', 23.13, -82.38, now() - interval '1 day', 'c0000000-0000-4000-8000-000000000001',
   'changed_plans', now() - interval '1 day'),
  ('f0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'completed', 'Obispo 5', 'Línea 9',
   NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '2 days'),
  ('f0000000-0000-4000-8000-000000000012', 'c0000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'canceled', 'G y 25', 'Prado 1',
   NULL, NULL, NULL, now(), 'c0000000-0000-4000-8000-000000000002', 'no_show', now()),
  ('f0000000-0000-4000-8000-000000000013', 'c0000000-0000-4000-8000-000000000001',
   NULL, 'canceled', 'Malecón 1', 'Paseo 2',
   NULL, NULL, NULL, now(), NULL, 'searching_abandoned', now());
UPDATE public.rides SET final_fare_cup = 1500, completed_at = now() - interval '2 days'
  WHERE id = 'f0000000-0000-4000-8000-000000000011';
UPDATE public.driver_profiles
  SET identity_number = '90010112345', address = 'Calle Secreta 1', municipality = 'Plaza',
      province = 'La Habana', has_criminal_record = false, current_location = 'POINT(-82.38 23.13)',
      last_heartbeat_at = now()
  WHERE id = 'd0000000-0000-4000-8000-000000000002';
INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'triciclo', 'Tricimoto', 'T1', 2022, 'rojo', 'P123456');
INSERT INTO public.driver_documents (driver_id, document_type, storage_path, file_name, is_verified)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'national_id', 'driver-docs/d2/id.jpg', 'id.jpg', true);
INSERT INTO public.driver_score_events (driver_id, event_type, delta)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'ride_completed', 1);
INSERT INTO public.driver_outreach_log (driver_profile_id, admin_id, channel, note)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'whatsapp', 'seed');
INSERT INTO public.reviews (id, ride_id, reviewer_id, reviewee_id, rating, comment)
  VALUES ('b0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 2, 'Llegó tarde');
INSERT INTO public.review_tags (review_id, tag_key) VALUES ('b0000000-0000-4000-8000-000000000001', 'late');
INSERT INTO public.support_tickets (id, user_id, subject, description)
  VALUES ('b1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Cobro', 'Me cobraron dos veces'),
         ('b1000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'Mi viaje', 'Ticket propio de Mara');
INSERT INTO public.ticket_messages (ticket_id, sender_id, message)
  VALUES ('b1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Hola');
INSERT INTO public.lost_items (ride_id, reporter_id, driver_id, description, admin_notes)
  VALUES ('f0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000002', 'Mochila azul', 'nota interna');
INSERT INTO public.ride_transitions (ride_id, from_status, to_status, actor_id)
  VALUES ('f0000000-0000-4000-8000-000000000010', 'searching', 'canceled', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, total)
  VALUES ('f0000000-0000-4000-8000-000000000011', 'estimate', 1500);
INSERT INTO public.ride_disputes (id, ride_id, opened_by, reason, description, evidence_urls, refund_amount_trc, admin_notes)
  VALUES ('b2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'overcharge', 'Me cobró de más',
          ARRAY['https://example.test/evidence.jpg'], 50, 'nota de admin');
INSERT INTO public.incident_reports (id, ride_id, reported_by, against_user_id, type, description, evidence_urls)
  VALUES ('b3000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000011',
          'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'rude_behavior',
          'Fue grosero', ARRAY['https://example.test/incident.jpg']);
INSERT INTO public.poi_import_queue (name, status) VALUES ('Paladar X', 'pending'), ('Paladar X', 'failed'), ('Hotel Y', 'done');
INSERT INTO public.push_registration_status (user_id, app, outcome)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'client', 'denied'),
         ('c0000000-0000-4000-8000-000000000002', 'driver', 'registered');
INSERT INTO public.user_devices (user_id, push_token, platform)
  VALUES ('c0000000-0000-4000-8000-000000000002', 'ExponentPushToken[x]', 'android');
INSERT INTO public.app_opens (user_id, app, device_id, app_version, platform)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'client', 'dev-1', '1.7.3', 'android');
INSERT INTO public.payment_intents (user_id, status, amount_usd, error_message, provider_error_code)
  VALUES ('c0000000-0000-4000-8000-000000000001', 'failed', 20, 'Invalid card number', NULL),
         ('c0000000-0000-4000-8000-000000000001', 'failed', 10, 'Invalid card number', NULL),
         ('c0000000-0000-4000-8000-000000000001', 'failed', 10, 'Error: netopia', 'E99'),
         ('c0000000-0000-4000-8000-000000000001', 'paid', 10, NULL, NULL);
INSERT INTO public.validation_events (driver_id, event_type, properties)
  VALUES ('d0000000-0000-4000-8000-000000000002', 'driver_ride_rejected', '{"profit_level":"low"}');
RESET ROLE;
```

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/00663/scaffold.sql supabase/tests/00663/live-bodies.sql supabase/tests/00663/seed.sql
git commit -m "test(db): scaffold and seed for the 00663 rehearsal"
```

---

## Task 2: Rehearsal runner (RED)

**Files:**
- Create: `supabase/tests/00663/run.sh`

- [ ] **Step 1: Write `run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal runner for migration 00663 (marketing reads more of the admin panel).
# Builds prod as of 2026-10-15: the 00642 rehearsal scaffold (prod on 2026-10-08) with 00641 and
# 00642 applied and Mara made marketing, then scaffold.sql and seed.sql of this folder.
#   supabase/tests/00663/run.sh none
#       -> prod + tests (RED: marketing reads none of the new data and cannot answer support)
#   supabase/tests/00663/run.sh supabase/migrations/00663_marketing_wider_view.sql
#       -> the same + 00663 applied twice, each in one transaction (GREEN), a CRLF copy applied to a
#          fresh database, and negative proofs of the file's own checks
# Cluster: user pgtest, port 5433. Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr663
ENUM="$ROOT/supabase/migrations/00641_marketing_role_enum.sql"
M642="$ROOT/supabase/migrations/00642_marketing_role_permissions.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }
nomatch(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ko "$1" "did not expect [$3], got [$r]"; else ok "$1"; fi; }

ANA=a0000000-0000-4000-8000-000000000001
CARLA=c0000000-0000-4000-8000-000000000001
DIEGO=c0000000-0000-4000-8000-000000000002
MARA=c0000000-0000-4000-8000-000000000003
DIEGO_DP=d0000000-0000-4000-8000-000000000002
RIDE_X=f0000000-0000-4000-8000-000000000010
T1=b1000000-0000-4000-8000-000000000001
T_MARA=b1000000-0000-4000-8000-000000000003
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
as_anon(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }

LIVE_OLD="admin_incomplete_driver_signups=2841ccd9b2c3f9cb3804a361097e22d3,admin_list_pois=c4646cc85b1bd83c65bf11974d49fbfd,get_auto_accept_rate=d287cc0735f48cb5d621d71b82bd0456,get_auto_nav_rate=ea732c6b23a1f3654f44d52077e3bd70,get_override_frequency=32d90734b10ec562591c9362b61f11a7,list_poi_submissions=6b1551aa33141886c0a9d0ac9a6bb616,tg_ticket_messages_client_guard=27dfd5fae754370a8554fd7c52f993cc"
# Computed in prod on 2026-10-15 as md5(replace(prosrc, <target>, <replacement>)).
LIVE_NEW="admin_incomplete_driver_signups=65aad048b3031c8398c21cf3649bd47f,admin_list_pois=0fd97f9da45bb7fddce9350acfec7fe6,get_auto_accept_rate=6f20da2215bf11febeeba716589ca74a,get_auto_nav_rate=c763c447e0ac0d61f150757efc543bad,get_override_frequency=e7ad623472e2f8f2e180f05bf2c172fb,list_poi_submissions=5bb221cc967fa33857a39ea963cd560c,tg_ticket_messages_client_guard=96297a4de1f620d1e545e21643268224"
LIVE_NAMES="'admin_incomplete_driver_signups','admin_list_pois','get_auto_accept_rate','get_auto_nav_rate','get_override_frequency','list_poi_submissions','tg_ticket_messages_client_guard'"
BODIES="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname IN ($LIVE_NAMES)"
FORBIDDEN="'share_token','share_token_expires_at','pickup_location','dropoff_location','actual_dropoff_location',
  'pickup_lat','pickup_lng','dropoff_lat','dropoff_lng','current_location','current_heading','identity_number',
  'address','has_criminal_record','criminal_record_details','negative_balance_since','storage_path','file_name',
  'face_match_score','liveness_passed','evidence_urls','respondent_evidence_urls','refund_amount_trc',
  'refund_transaction_id','admin_notes','earnings_this_week','earnings_last_week','pickup_notes','dropoff_notes',
  'wallet_amount_cup','cash_amount_cup','payment_intent_id'"

psqlf(){ $BIN/psql $CONN -d "$1" -q -v ON_ERROR_STOP=1 "${@:2}"; }
load(){ local db=$1 i
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  psqlf "$db" -f "$ROOT/supabase/tests/00642/scaffold.sql" >"$TMP/s642.out" 2>&1 || { echo "00642 scaffold failed:"; cat "$TMP/s642.out"; exit 1; }
  for i in 1 2; do psqlf "$db" -c "$AS_OWNER" -f "$ENUM" >"$TMP/enum.out" 2>&1 || { echo "00641 failed:"; cat "$TMP/enum.out"; exit 1; }; done
  psqlf "$db" -c "UPDATE public.users SET role = 'marketing' WHERE id = '$MARA'" >/dev/null 2>&1 || { echo "could not make Mara marketing"; exit 1; }
  psqlf "$db" -1 -c "$AS_OWNER" -f "$M642" >"$TMP/m642.out" 2>&1 || { echo "00642 failed:"; cat "$TMP/m642.out"; exit 1; }
  psqlf "$db" -f "$DIR/scaffold.sql" >"$TMP/s663.out" 2>&1 || { echo "00663 scaffold failed:"; cat "$TMP/s663.out"; exit 1; }
  psqlf "$db" -f "$DIR/seed.sql" >"$TMP/seed.out" 2>&1 || { echo "seed failed:"; cat "$TMP/seed.out"; exit 1; }
}
apply(){ psqlf "$1" -1 -c "$AS_OWNER" -f "$2" >"$TMP/mig.out" 2>&1; }

load $DB
# L1: the live bodies are prod's (before the migration).
val L1 "$BODIES" "$LIVE_OLD"

if [ "$MIG" != none ]; then
  apply $DB "$MIG" || { echo "migration failed on apply 1:"; cat "$TMP/mig.out"; exit 1; }
  apply $DB "$MIG" || { echo "migration failed on apply 2:"; cat "$TMP/mig.out"; exit 1; }
fi

# --- Views ---------------------------------------------------------------------------------
val V1 "BEGIN; $(as_user $MARA) SELECT canceled_by_role, cancellation_reason FROM public.panel_rides WHERE id = '$RIDE_X'; ROLLBACK;" "customer|changed_plans"
val V2 "BEGIN; $(as_user $MARA) SELECT string_agg(coalesce(canceled_by_role, '-'), ',' ORDER BY id) FROM public.panel_rides; ROLLBACK;" "-,customer,-,driver,system"
val V3 "BEGIN; $(as_user $MARA) SELECT full_name, plate_number, vehicle_type, municipality FROM public.panel_driver_profiles WHERE id = '$DIEGO_DP'; ROLLBACK;" "Diego Driver|P123456|triciclo|Plaza"
val V4 "BEGIN; $(as_user $MARA) SELECT document_type, is_verified FROM public.panel_driver_documents; ROLLBACK;" "national_id|t"
val V5 "BEGIN; $(as_user $MARA) SELECT risk_level FROM public.panel_driver_churn_risk WHERE driver_profile_id = '$DIEGO_DP'; ROLLBACK;" "medium"
val V6 "BEGIN; $(as_user $MARA) SELECT reason FROM public.panel_ride_disputes; ROLLBACK;" "overcharge"
val V7 "BEGIN; $(as_user $MARA) SELECT type FROM public.panel_incident_reports; ROLLBACK;" "rude_behavior"
val V8 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles),
  (SELECT count(*) FROM public.panel_driver_documents), (SELECT count(*) FROM public.panel_driver_churn_risk),
  (SELECT count(*) FROM public.panel_ride_disputes), (SELECT count(*) FROM public.panel_incident_reports); ROLLBACK;" "0|0|0|0|0|0"
err V9 "BEGIN; $(as_anon) SELECT count(*) FROM public.panel_driver_documents; ROLLBACK;" "permission denied"
val V10 "BEGIN; $(as_user $ANA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_documents),
  (SELECT count(*) FROM public.panel_ride_disputes); ROLLBACK;" "5|1|1"
# V11: no panel view carries a column that the spec keeps hidden (by name, so a later column fails too).
val V11 "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name IN ('panel_rides','panel_driver_profiles','panel_driver_documents','panel_driver_churn_risk','panel_ride_disputes','panel_incident_reports')
  AND column_name IN ($FORBIDDEN)" "0"
val V12 "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name IN ('panel_driver_documents','panel_driver_churn_risk','panel_ride_disputes','panel_incident_reports')" "4"

# --- Policies ------------------------------------------------------------------------------
val P1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.reviews), (SELECT count(*) FROM public.review_tags),
  (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.ticket_messages),
  (SELECT count(*) FROM public.lost_items), (SELECT count(*) FROM public.ride_transitions WHERE ride_id = '$RIDE_X'),
  (SELECT count(*) FROM public.ride_pricing_snapshots WHERE ride_id = 'f0000000-0000-4000-8000-000000000011'),
  (SELECT count(*) FROM public.driver_score_events),
  (SELECT count(*) FROM public.driver_outreach_log); ROLLBACK;" "1|1|2|1|1|1|1|1|1"
# P2: tables marketing reads only through views, or not at all.
val P2 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.driver_profiles),
  (SELECT count(*) FROM public.vehicles), (SELECT count(*) FROM public.driver_documents),
  (SELECT count(*) FROM public.ride_disputes), (SELECT count(*) FROM public.incident_reports),
  (SELECT count(*) FROM public.payment_intents), (SELECT count(*) FROM public.user_devices); ROLLBACK;" "0|0|0|0|0|0|0|0"
val P3 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.reviews); ROLLBACK;" "1|1"

# --- Support -------------------------------------------------------------------------------
val S1 "BEGIN; $(as_user $MARA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin)
  VALUES ('$T1', '$MARA', 'Te ayudamos', false) RETURNING is_admin; ROLLBACK;" "t"
val S2 "BEGIN; $(as_user $MARA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin)
  VALUES ('$T_MARA', '$MARA', 'Soy pasajera', true) RETURNING is_admin; ROLLBACK;" "f"
val S3 "BEGIN; $(as_user $CARLA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin)
  VALUES ('$T1', '$CARLA', 'Soy soporte', true) RETURNING is_admin; ROLLBACK;" "f"
err S4 "BEGIN; $(as_user $MARA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message)
  VALUES ('$T1', '$CARLA', 'en nombre de Carla'); ROLLBACK;" "row-level security"
val S5 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'resolved' WHERE id = '$T1'
  RETURNING status, resolved_at IS NOT NULL, updated_at IS NOT NULL; ROLLBACK;" "resolved|t|t"
err S6 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET priority = 'urgent' WHERE id = '$T1'; ROLLBACK;" "ticket_column_staff_only"
err S7 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'bogus' WHERE id = '$T1'; ROLLBACK;" "ticket_status_invalid"
val S8 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'closed' WHERE id = '$T1';
  UPDATE public.support_tickets SET status = 'open' WHERE id = '$T1' RETURNING resolved_at IS NULL; ROLLBACK;" "t"
val S9 "BEGIN; $(as_user $ANA) UPDATE public.support_tickets SET priority = 'urgent' WHERE id = '$T1' RETURNING priority; ROLLBACK;" "urgent"
val S10 "BEGIN; $(as_user $CARLA) UPDATE public.support_tickets SET status = 'closed' WHERE id = '$T1' RETURNING id; ROLLBACK;" ""

# --- RPCs ----------------------------------------------------------------------------------
val R1 "BEGIN; $(as_user $MARA) SELECT count(*) FROM public.admin_incomplete_driver_signups(); ROLLBACK;" "0"
val R2 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.get_auto_accept_rate(7)), (SELECT count(*) FROM public.get_auto_nav_rate(7)),
  (SELECT count(*) FROM public.get_override_frequency(7, 20)); ROLLBACK;" "1|1|1"
err R3 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.admin_incomplete_driver_signups(); ROLLBACK;" "Admin only"
# R4: marketing gets past admin_list_pois' gate (without PostGIS the body then fails on geometry).
nomatch R4 "BEGIN; $(as_user $MARA) SELECT count(*) FROM public.admin_list_pois(); ROLLBACK;" "forbidden"
err R5 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.admin_list_pois(); ROLLBACK;" "forbidden"
val R6 "$BODIES" "$( [ "$MIG" = none ] && echo "$LIVE_OLD" || echo "$LIVE_NEW" )"
val R7 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.list_poi_submissions('all', 10, 0); ROLLBACK;" "0"

# --- Product failures ----------------------------------------------------------------------
val F1 "BEGIN; $(as_user $MARA) SELECT r->'places_not_found'->0->>'name', r->'places_not_found'->0->>'searches',
  jsonb_array_length(r->'failed_payments'), r->'failed_payments'->0->>'reason', r->'failed_payments'->0->>'payments',
  jsonb_array_length(r->'app_versions'), jsonb_array_length(r->'push_outcomes'),
  r->'push_reach'->>'riders_active', r->'push_reach'->>'riders_reachable',
  r->'push_reach'->>'drivers_active', r->'push_reach'->>'drivers_reachable'
  FROM (SELECT public.get_product_failures(30) AS r) x; ROLLBACK;" "Paladar X|2|2|Invalid card number|2|1|2|1|0|1|1"
err F2 "BEGIN; $(as_user $CARLA) SELECT public.get_product_failures(30); ROLLBACK;" "Admin only"
err F3 "BEGIN; $(as_anon) SELECT public.get_product_failures(30); ROLLBACK;" "permission denied"
nomatch F4 "BEGIN; $(as_user $MARA) SELECT public.get_product_failures(30)::text; ROLLBACK;" "$CARLA"
val F5 "BEGIN; $(as_user $ANA) SELECT (public.get_product_failures(0)->>'days'), (public.get_product_failures(9999)->>'days'); ROLLBACK;" "1|365"

if [ "$MIG" != none ]; then
  # CR1: a CRLF copy applies to a fresh database and leaves the same bodies.
  tr -d '\r' < "$MIG" | sed 's/$/\r/' > "$TMP/crlf.sql"
  load ${DB}crlf
  apply ${DB}crlf "$TMP/crlf.sql" && ok CR1a || ko CR1a "CRLF copy failed: $(cat "$TMP/mig.out")"
  val CR1b "$BODIES" "$LIVE_NEW" ${DB}crlf

  # N1: a patched function with a body the file does not know aborts the file.
  load ${DB}neg
  psqlf ${DB}neg -c "$AS_OWNER" -c "CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back integer DEFAULT 7)
    RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric) LANGUAGE sql AS \$f\$ SELECT 0::bigint, 0::bigint, 0::bigint, 0::numeric \$f\$" >/dev/null 2>&1
  apply ${DB}neg "$MIG" && ko N1 "the file applied over an unknown body" || { grep -q "does not know" "$TMP/mig.out" && ok N1 || ko N1 "$(cat "$TMP/mig.out")"; }

  # N2: a marketing policy on vehicles aborts the file (marketing reads vehicles only through the view).
  load ${DB}neg
  psqlf ${DB}neg -c "$AS_OWNER" -c "CREATE POLICY vehicles_select_marketing ON public.vehicles FOR SELECT TO authenticated USING ((SELECT public.is_marketing()))" >/dev/null 2>&1
  apply ${DB}neg "$MIG" && ko N2 "the file applied with a marketing policy on vehicles" || { grep -q "through the panel views" "$TMP/mig.out" && ok N2 || ko N2 "$(cat "$TMP/mig.out")"; }

  # N3: any panel_ view with a hidden column aborts the file.
  load ${DB}neg
  psqlf ${DB}neg -c "$AS_OWNER" -c "CREATE VIEW public.panel_extra AS SELECT id, share_token FROM public.rides" >/dev/null 2>&1
  apply ${DB}neg "$MIG" && ko N3 "the file applied with a panel view exposing share_token" || { grep -q "hidden column" "$TMP/mig.out" && ok N3 || ko N3 "$(cat "$TMP/mig.out")"; }
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
```

Make it executable: `chmod +x supabase/tests/00663/run.sh`.

- [ ] **Step 2: Start the local cluster** (if it is not running; see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod")

```bash
id pgtest >/dev/null 2>&1 || useradd -m pgtest
[ -d /home/pgtest/data ] || su pgtest -c '/usr/lib/postgresql/16/bin/initdb -D /home/pgtest/data -U pgtest -A trust -E UTF8 --no-locale' >/dev/null
su pgtest -c '/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -o "-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -l /home/pgtest/log -w start'
```

- [ ] **Step 3: Run RED**

Run: `bash supabase/tests/00663/run.sh none`
Expected: L1, V11, P2, P3, S2, S3, S4, S9, S10, R3, R5, R6, R7 and F4 pass; V1–V10, V12, P1, S1, S5–S8, R1, R2, R4, F1–F3 and F5 fail (missing columns, relations, policies or the function). The last line reads `N passed, M failed` with M > 0 and the exit code is 1. If any test in the first group fails, the scaffold is wrong: fix it before going on.

- [ ] **Step 4: Commit**

```bash
git add supabase/tests/00663/run.sh
git commit -m "test(db): rehearsal runner for 00663 (RED)"
```

---

## Task 3: Migration 00663

**Files:**
- Create: `supabase/migrations/00663_marketing_wider_view.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 00663 — marketing reads more of the admin panel, and answers support
-- Spec: docs/superpowers/specs/2026-10-15-marketing-visibility-design.md
-- Needs 00642 (is_marketing() and the panel views).
--
--   1. Panel views. panel_rides and panel_driver_profiles gain columns; four new views (driver
--      documents, churn risk, disputes, incidents) leave out files, money and internal notes.
--   2. SELECT policies for marketing on tables with nothing to hide.
--   3. The read RPCs of the opened pages let marketing through their admin gate.
--   4. Support: marketing replies as support and changes a ticket's status, and nothing else.
--   5. get_product_failures(): the "Fallas del producto" section of Reportes.
--   6. Checks of everything above. A failed check aborts the whole file.
--
-- Additive: nothing that exists is loosened for any other role, and nothing is dropped.
-- Every function patch starts from the live body, runs only on the body this file was written
-- against (md5 below), is skipped on the body it leaves, and refuses any other body.
-- Rehearsal: supabase/tests/00663/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- Creating a policy locks its table; fail fast instead of queueing the app's reads behind us.
SET lock_timeout = '5s';

-- Every table this file touches, locked up front: a ride first, then its people. ACCESS EXCLUSIVE
-- where a policy or trigger is created, ACCESS SHARE where a view only reads it. On 40P01
-- (deadlock) or 55P03 (lock_timeout) the whole file rolls back; run it again.
LOCK TABLE public.rides IN ACCESS SHARE MODE;
LOCK TABLE public.ride_transitions, public.ride_pricing_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.users, public.driver_profiles, public.vehicles, public.driver_documents IN ACCESS SHARE MODE;
LOCK TABLE public.driver_score_events, public.driver_outreach_log, public.reviews,
  public.support_tickets, public.ticket_messages, public.lost_items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.ride_disputes, public.incident_reports IN ACCESS SHARE MODE;

-- 1. Panel views -----------------------------------------------------------------------------
-- As in 00642: not security_invoker (the base tables' RLS would show marketing nothing), with
-- security_barrier and the admin-or-marketing gate in WHERE. Only SELECT is granted: through a
-- view that reads as its owner, a write would skip the base tables' RLS.
-- CREATE OR REPLACE keeps the existing columns first and in order; new ones go at the end.
CREATE OR REPLACE VIEW public.panel_rides
WITH (security_barrier = true, security_invoker = false) AS
SELECT r.id, r.created_at, r.status, r.customer_id, r.driver_id, r.service_type, r.city_id,
       r.estimated_fare_cup, r.final_fare_cup, r.final_fare_trc, r.payment_method,
       r.pickup_address, r.dropoff_address, r.promo_code_id, r.discount_amount_cup,
       r.shared_ride_discount_cup, r.dispatch_round,
       -- 00663
       r.ride_mode, r.is_scheduled, r.scheduled_at, r.accepted_at, r.driver_arrived_at, r.pickup_at,
       r.arrived_at_destination_at, r.completed_at, r.canceled_at, r.canceled_by,
       CASE
         WHEN r.status <> 'canceled' THEN NULL
         WHEN r.canceled_by IS NULL THEN 'system'
         WHEN r.canceled_by = r.customer_id THEN 'customer'
         WHEN EXISTS (SELECT 1 FROM public.driver_profiles d
                      WHERE d.id = r.driver_id AND d.user_id = r.canceled_by) THEN 'driver'
         ELSE 'staff'
       END AS canceled_by_role,
       r.cancellation_reason, r.cancellation_reason_code,
       r.estimated_distance_m, r.actual_distance_m, r.estimated_duration_s, r.actual_duration_s,
       r.wait_time_seconds, r.wait_charge_cup, r.passenger_count, r.shared_ride, r.is_split,
       r.corporate_account_id, r.partner_place_id, r.partner_discount_cup, r.tip_amount,
       r.surge_multiplier, r.driver_gps_status, r.searching_seen_at, r.last_dispatched_at,
       r.payment_status
FROM public.rides r
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

-- The vehicle comes through this view: since 00644 a SELECT policy on vehicles counts as a leak.
CREATE OR REPLACE VIEW public.panel_driver_profiles
WITH (security_barrier = true, security_invoker = false) AS
SELECT dp.id, dp.user_id, dp.is_online, dp.total_rides_completed, dp.total_rides,
       -- 00663
       dp.status, dp.rating_avg, dp.acceptance_rate, dp.total_rides_offered, dp.city_id, dp.zone_id,
       dp.municipality, dp.province, dp.created_at, dp.approved_at, dp.suspended_at,
       dp.suspended_reason, dp.is_on_break, dp.auto_accept_enabled, dp.last_heartbeat_at,
       dp.auto_offline_at, dp.terms_accepted_at,
       u.full_name, u.phone, u.email,
       v.type AS vehicle_type, v.plate_number, v.make AS vehicle_make, v.model AS vehicle_model,
       v.color AS vehicle_color, v.year AS vehicle_year
FROM public.driver_profiles dp
JOIN public.users u ON u.id = dp.user_id
LEFT JOIN LATERAL (
  SELECT vh.type, vh.plate_number, vh.make, vh.model, vh.color, vh.year
  FROM public.vehicles vh
  WHERE vh.driver_id = dp.id AND vh.is_active
  ORDER BY vh.created_at DESC, vh.id DESC
  LIMIT 1
) v ON true
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_driver_documents
WITH (security_barrier = true, security_invoker = false) AS
SELECT d.id, d.driver_id, d.document_type, d.uploaded_at, d.is_verified, d.verified_at, d.rejection_reason
FROM public.driver_documents d
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_driver_churn_risk
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.driver_profile_id, c.user_id, c.full_name, c.rating_avg, c.total_rides_completed,
       c.acceptance_rate, c.is_online, c.status, c.days_since_last_ride, c.churn_risk_score, c.risk_level
FROM public.driver_churn_risk c
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_ride_disputes
WITH (security_barrier = true, security_invoker = false) AS
SELECT d.id, d.ride_id, d.opened_by, d.reason, d.description, d.status, d.priority,
       d.respondent_id, d.respondent_message, d.respondent_replied_at, d.resolution,
       d.resolution_notes, d.assigned_to, d.sla_first_response_at, d.sla_resolution_deadline,
       d.support_ticket_id, d.incident_report_id, d.created_at, d.updated_at, d.resolved_at
FROM public.ride_disputes d
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_incident_reports
WITH (security_barrier = true, security_invoker = false) AS
SELECT i.id, i.ride_id, i.reported_by, i.against_user_id, i.type, i.severity, i.description,
       i.status, i.resolved_by, i.resolved_at, i.created_at, i.updated_at, i.review_id
FROM public.incident_reports i
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

-- Until 2026-10-30 Supabase gives every new view of public ALL for the API roles: take it back,
-- then grant reading only. Written out per view: pnpm check:migration-grants skips dynamic SQL.
REVOKE ALL ON public.panel_rides FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_profiles FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_documents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_churn_risk FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_ride_disputes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_incident_reports FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.panel_rides TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_profiles TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_documents TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_churn_risk TO authenticated, service_role;
GRANT SELECT ON public.panel_ride_disputes TO authenticated, service_role;
GRANT SELECT ON public.panel_incident_reports TO authenticated, service_role;

COMMENT ON VIEW public.panel_rides IS
  'Rides as the admin panel reads them, for admins and marketing: no coordinates, share_token, notes or payment split (00642, 00663).';
COMMENT ON VIEW public.panel_driver_profiles IS
  'Driver profiles as the admin panel reads them, for admins and marketing: no GPS, identity, address, record or balance (00642, 00663).';
COMMENT ON VIEW public.panel_driver_documents IS
  'Which documents a driver uploaded and their review, for admins and marketing: no files (00663).';
COMMENT ON VIEW public.panel_driver_churn_risk IS
  'Driver churn risk for admins and marketing, without earnings (00663).';
COMMENT ON VIEW public.panel_ride_disputes IS
  'Disputes for admins and marketing: no evidence, refunds or admin notes (00663).';
COMMENT ON VIEW public.panel_incident_reports IS
  'Incident reports for admins and marketing: no evidence or resolution notes (00663).';

-- 2. Policies -------------------------------------------------------------------------------
DO $policies$
DECLARE
  c_m constant text := '(SELECT public.is_marketing())';
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('reviews',                'reviews_select_marketing',                'SELECT', c_m,  NULL::text),
      ('support_tickets',        'support_tickets_select_marketing',        'SELECT', c_m,  NULL),
      ('support_tickets',        'support_tickets_update_marketing',        'UPDATE', c_m,  c_m),
      ('ticket_messages',        'ticket_messages_select_marketing',        'SELECT', c_m,  NULL),
      ('ticket_messages',        'ticket_messages_insert_marketing',        'INSERT', NULL, c_m || ' AND sender_id = (SELECT auth.uid())'),
      ('lost_items',             'lost_items_select_marketing',             'SELECT', c_m,  NULL),
      ('ride_transitions',       'ride_transitions_select_marketing',       'SELECT', c_m,  NULL),
      ('ride_pricing_snapshots', 'ride_pricing_snapshots_select_marketing', 'SELECT', c_m,  NULL),
      ('driver_score_events',    'driver_score_events_select_marketing',    'SELECT', c_m,  NULL),
      ('driver_outreach_log',    'driver_outreach_log_select_marketing',    'SELECT', c_m,  NULL)
    ) AS v(tbl, name, cmd, using_expr, check_expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.name) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR %s TO authenticated%s%s',
        r.name, r.tbl, r.cmd,
        CASE WHEN r.using_expr IS NULL THEN '' ELSE ' USING (' || r.using_expr || ')' END,
        CASE WHEN r.check_expr IS NULL THEN '' ELSE ' WITH CHECK (' || r.check_expr || ')' END);
    END IF;
  END LOOP;
END
$policies$;

-- 3 and 4a. Patches of live functions ---------------------------------------------------------
-- The read RPCs of the opened pages: their admin gate becomes "admin or marketing". The write
-- RPCs of those pages do not change.
-- tg_ticket_messages_client_guard: marketing's messages are support's, except in its own ticket.
-- Targets and replacements lose any \r, so a copy saved with CRLF patches to the same bodies.
DO $patch$
DECLARE
  r record;
  v_src text;
  v_md5 text;
  v_target text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.admin_incomplete_driver_signups()',
       '2841ccd9b2c3f9cb3804a361097e22d3', '65aad048b3031c8398c21cf3649bd47f',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.get_auto_accept_rate(integer)',
       'd287cc0735f48cb5d621d71b82bd0456', '6f20da2215bf11febeeba716589ca74a',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.get_auto_nav_rate(integer)',
       'ea732c6b23a1f3654f44d52077e3bd70', 'c763c447e0ac0d61f150757efc543bad',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.get_override_frequency(integer,integer)',
       '32d90734b10ec562591c9362b61f11a7', 'e7ad623472e2f8f2e180f05bf2c172fb',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.list_poi_submissions(text,integer,integer)',
       '6b1551aa33141886c0a9d0ac9a6bb616', '5bb221cc967fa33857a39ea963cd560c',
       'IF auth.uid() IS NULL OR NOT public.is_admin() THEN',
       'IF auth.uid() IS NULL OR NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.admin_list_pois(text,text,text,text,boolean,boolean,integer,integer)',
       'c4646cc85b1bd83c65bf11974d49fbfd', '0fd97f9da45bb7fddce9350acfec7fe6',
       $t$AND u.role IN ('admin','super_admin')$t$, $t$AND u.role IN ('admin','super_admin','marketing')$t$),
      ('public.tg_ticket_messages_client_guard()',
       '27dfd5fae754370a8554fd7c52f993cc', '96297a4de1f620d1e545e21643268224',
       $t$  NEW.is_admin := false;
$t$,
       $t$  -- Marketing answers tickets as support (00663), except in a ticket of its own.
  IF public.is_marketing() AND NOT EXISTS (
    SELECT 1 FROM public.support_tickets t WHERE t.id = NEW.ticket_id AND t.user_id = auth.uid()
  ) THEN
    NEW.is_admin := true;
  ELSE
    NEW.is_admin := false;
  END IF;
$t$)
    ) AS v(fn, old_md5, new_md5, target, repl)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = r.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00663: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    v_target := replace(r.target, chr(13), '');
    IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
      RAISE EXCEPTION '00663: the target is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), v_target, replace(r.repl, chr(13), ''));
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00663: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 4b. Support: what a client may change in a ticket ----------------------------------------
-- Admins keep "Admins update tickets" unchanged. Any other client (today only marketing has an
-- UPDATE policy) may change the status and nothing else; the server stamps the dates.
-- SECURITY INVOKER on purpose: current_user tells a client write from a function's.
CREATE OR REPLACE FUNCTION public.tg_support_tickets_client_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_free constant text[] := ARRAY['status', 'resolved_at', 'updated_at'];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - c_free) IS DISTINCT FROM (to_jsonb(OLD) - c_free) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Solo puedes cambiar el estado del ticket.',
      DETAIL = 'ticket_column_staff_only';
  END IF;
  IF NEW.status IS NULL OR NEW.status NOT IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ese estado de ticket no existe.',
      DETAIL = 'ticket_status_invalid';
  END IF;
  NEW.updated_at := now();
  IF NEW.status IN ('resolved', 'closed') THEN
    NEW.resolved_at := CASE WHEN OLD.status IN ('resolved', 'closed') THEN OLD.resolved_at ELSE now() END;
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.tg_support_tickets_client_update_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_support_tickets_client_update_guard
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_client_update_guard();

-- 5. Product failures -------------------------------------------------------------------------
-- What breaks for users, by period, for admins and marketing. No amounts, no user ids, no
-- coordinates: counts and reasons only.
CREATE OR REPLACE FUNCTION public.get_product_failures(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_days integer := LEAST(GREATEST(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := now() - make_interval(days => v_days);
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'days', v_days,
    -- Places riders typed that the app did not have (00584 queues them).
    'places_not_found', coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'searches', x.searches,
                                          'last_seen', x.last_seen, 'imported', x.imported)
                       ORDER BY x.searches DESC, x.last_seen DESC)
      FROM (
        SELECT q.name, count(*)::integer AS searches, max(q.created_at) AS last_seen,
               count(*) FILTER (WHERE q.status = 'done')::integer AS imported
        FROM public.poi_import_queue q
        WHERE q.created_at >= v_since
        GROUP BY q.name
        ORDER BY count(*) DESC, max(q.created_at) DESC
        LIMIT 50
      ) x), '[]'::jsonb),
    -- The last push registration outcome per account and app (00585), test accounts left out.
    'push_outcomes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('app', x.app, 'outcome', x.outcome, 'users', x.users)
                       ORDER BY x.app, x.outcome)
      FROM (
        SELECT s.app, s.outcome, count(*)::integer AS users
        FROM public.push_registration_status s
        JOIN public.users u ON u.id = s.user_id
        WHERE NOT u.is_test
        GROUP BY s.app, s.outcome
      ) x), '[]'::jsonb),
    -- Of the people active in the period, how many have a device that can get a push.
    'push_reach', (
      SELECT jsonb_build_object(
        'riders_active', count(*),
        'riders_reachable', count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.user_devices d WHERE d.user_id = a.id)))
      FROM (
        SELECT DISTINCT r.customer_id AS id
        FROM public.rides r JOIN public.users u ON u.id = r.customer_id
        WHERE r.created_at >= v_since AND NOT u.is_test
      ) a
    ) || (
      SELECT jsonb_build_object(
        'drivers_active', count(*),
        'drivers_reachable', count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.user_devices d WHERE d.user_id = dp.user_id)))
      FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id
      WHERE dp.last_heartbeat_at >= v_since AND NOT u.is_test
    ),
    -- App versions opened in the period (00622). Empty until a build that reports opens is out.
    'app_versions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('app', x.app, 'version', x.app_version,
                                          'platform', x.platform, 'installs', x.installs)
                       ORDER BY x.app, x.installs DESC)
      FROM (
        SELECT o.app, o.app_version, o.platform, count(*)::integer AS installs
        FROM public.app_opens o
        WHERE o.last_opened_at >= v_since
        GROUP BY o.app, o.app_version, o.platform
      ) x), '[]'::jsonb),
    -- Failed payments by reason: the provider's code, or the start of the error message.
    'failed_payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object('reason', x.reason, 'payments', x.payments,
                                          'last_seen', x.last_seen)
                       ORDER BY x.payments DESC, x.last_seen DESC)
      FROM (
        SELECT coalesce(nullif(btrim(p.provider_error_code), ''),
                        left(coalesce(nullif(btrim(p.error_message), ''), 'sin motivo'), 60)) AS reason,
               count(*)::integer AS payments, max(p.created_at) AS last_seen
        FROM public.payment_intents p
        WHERE p.status = 'failed' AND p.created_at >= v_since
        GROUP BY 1
      ) x), '[]'::jsonb)
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.get_product_failures(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_product_failures(integer) TO authenticated, service_role;

-- 6. What this file promises ----------------------------------------------------------------
DO $check$
DECLARE
  c_hidden constant text[] := ARRAY[
    'share_token', 'share_token_expires_at', 'pickup_location', 'dropoff_location',
    'actual_dropoff_location', 'pickup_lat', 'pickup_lng', 'dropoff_lat', 'dropoff_lng',
    'current_location', 'current_heading', 'identity_number', 'address', 'has_criminal_record',
    'criminal_record_details', 'negative_balance_since', 'storage_path', 'file_name',
    'face_match_score', 'liveness_passed', 'evidence_urls', 'respondent_evidence_urls',
    'refund_amount_trc', 'refund_transaction_id', 'admin_notes', 'earnings_this_week',
    'earnings_last_week', 'pickup_notes', 'dropoff_notes', 'wallet_amount_cup', 'cash_amount_cup',
    'payment_intent_id'];
  c_guard constant regprocedure := 'public.tg_support_tickets_client_update_guard()'::regprocedure;
  c_pf constant regprocedure := 'public.get_product_failures(integer)'::regprocedure;
  v_name text;
  v_def text;
  v_tbl text;
  v_cmd text;
  v_pcmd text;
  v_roles name[];
  v_perm text;
  v_qual text;
  v_check text;
BEGIN
  -- No panel_ view in public carries a hidden column (by name: a column added later fails here).
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO v_def
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND c.relname LIKE 'panel\_%'
    AND a.attname = ANY (c_hidden);
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION '00663: % is a hidden column in a panel view', v_def;
  END IF;

  -- The six views: read as the owner behind the gate, readable only by authenticated and
  -- service_role, writable by none of them.
  FOREACH v_name IN ARRAY ARRAY['panel_rides', 'panel_driver_profiles', 'panel_driver_documents',
                                'panel_driver_churn_risk', 'panel_ride_disputes', 'panel_incident_reports'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                   WHERE oid = ('public.' || v_name)::regclass AND relkind = 'v'
                     AND reloptions @> ARRAY['security_barrier=true', 'security_invoker=false']) THEN
      RAISE EXCEPTION '00663: view % must be a security_barrier view that is not security_invoker', v_name;
    END IF;
    v_qual := pg_get_viewdef(('public.' || v_name)::regclass);
    IF position('is_admin()' IN v_qual) = 0 OR position('is_marketing()' IN v_qual) = 0 THEN
      RAISE EXCEPTION '00663: view % does not gate its rows on is_admin() or is_marketing()', v_name;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || v_name, 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.' || v_name, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v_name, 'SELECT')
       OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                  WHERE c.oid = ('public.' || v_name)::regclass
                    AND (a.grantee = 0
                         OR (a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
                             AND a.privilege_type <> 'SELECT'))) THEN
      RAISE EXCEPTION '00663: view % must be readable by authenticated and service_role only, and writable by none of them', v_name;
    END IF;
  END LOOP;

  -- The policies: PERMISSIVE, TO authenticated, using is_marketing().
  FOR v_tbl, v_name, v_cmd IN
    SELECT * FROM (VALUES
      ('reviews', 'reviews_select_marketing', 'SELECT'),
      ('support_tickets', 'support_tickets_select_marketing', 'SELECT'),
      ('support_tickets', 'support_tickets_update_marketing', 'UPDATE'),
      ('ticket_messages', 'ticket_messages_select_marketing', 'SELECT'),
      ('ticket_messages', 'ticket_messages_insert_marketing', 'INSERT'),
      ('lost_items', 'lost_items_select_marketing', 'SELECT'),
      ('ride_transitions', 'ride_transitions_select_marketing', 'SELECT'),
      ('ride_pricing_snapshots', 'ride_pricing_snapshots_select_marketing', 'SELECT'),
      ('driver_score_events', 'driver_score_events_select_marketing', 'SELECT'),
      ('driver_outreach_log', 'driver_outreach_log_select_marketing', 'SELECT')
    ) AS v(t, n, c)
  LOOP
    SELECT p.cmd, p.roles, p.permissive, coalesce(p.qual, ''), coalesce(p.with_check, '')
      INTO v_pcmd, v_roles, v_perm, v_qual, v_check
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.policyname = v_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION '00663: policy % on % is missing', v_name, v_tbl;
    END IF;
    IF (v_cmd IN ('SELECT', 'UPDATE') AND position('is_marketing()' IN v_qual) = 0)
       OR (v_cmd IN ('INSERT', 'UPDATE') AND position('is_marketing()' IN v_check) = 0) THEN
      RAISE EXCEPTION '00663: policy % on % does not use is_marketing()', v_name, v_tbl;
    END IF;
    IF v_pcmd <> v_cmd OR v_roles <> ARRAY['authenticated']::name[] OR v_perm <> 'PERMISSIVE' THEN
      RAISE EXCEPTION '00663: policy % on % must be PERMISSIVE FOR % TO authenticated (it is % FOR % TO %)',
        v_name, v_tbl, v_cmd, v_perm, v_pcmd, v_roles;
    END IF;
  END LOOP;
  SELECT coalesce(with_check, '') INTO v_check FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'ticket_messages' AND policyname = 'ticket_messages_insert_marketing';
  IF v_check !~ 'sender_id = \( SELECT auth\.uid\(\)' THEN
    RAISE EXCEPTION '00663: policy ticket_messages_insert_marketing does not tie sender_id to auth.uid()';
  END IF;

  -- Tables marketing reads only through the panel views, or not at all.
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_def FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('rides', 'driver_profiles', 'vehicles', 'driver_documents', 'ride_disputes',
                      'incident_reports', 'wallet_accounts', 'ledger_entries', 'ledger_transactions',
                      'wallet_transfers', 'payment_intents', 'ride_messages', 'delivery_details',
                      'selfie_checks', 'driver_contracts', 'user_devices')
    AND (position('is_marketing' IN coalesce(qual, '')) > 0
         OR position('is_marketing' IN coalesce(with_check, '')) > 0);
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION '00663: % let marketing read a table it must reach only through the panel views', v_def;
  END IF;

  -- The patched bodies.
  FOR v_name, v_def IN
    SELECT * FROM (VALUES
      ('public.admin_incomplete_driver_signups()', '65aad048b3031c8398c21cf3649bd47f'),
      ('public.get_auto_accept_rate(integer)', '6f20da2215bf11febeeba716589ca74a'),
      ('public.get_auto_nav_rate(integer)', 'c763c447e0ac0d61f150757efc543bad'),
      ('public.get_override_frequency(integer,integer)', 'e7ad623472e2f8f2e180f05bf2c172fb'),
      ('public.list_poi_submissions(text,integer,integer)', '5bb221cc967fa33857a39ea963cd560c'),
      ('public.admin_list_pois(text,text,text,text,boolean,boolean,integer,integer)', '0fd97f9da45bb7fddce9350acfec7fe6'),
      ('public.tg_ticket_messages_client_guard()', '96297a4de1f620d1e545e21643268224')
    ) AS v(fn, md5)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure) <> v_def THEN
      RAISE EXCEPTION '00663: % does not have the patched body', v_name;
    END IF;
  END LOOP;

  -- The support guard: invoker, on every UPDATE of support_tickets, row by row, enabled.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = c_guard) THEN
    RAISE EXCEPTION '00663: tg_support_tickets_client_update_guard() must be SECURITY INVOKER';
  END IF;
  -- tgtype bits: ROW 1, BEFORE 2, UPDATE 16.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.support_tickets'::regclass
                   AND tgname = 'trg_support_tickets_client_update_guard'
                   AND tgfoid = c_guard AND tgenabled = 'O' AND tgtype = (1 | 2 | 16)
                   AND cardinality(tgattr::int2[]) = 0 AND tgqual IS NULL) THEN
    RAISE EXCEPTION '00663: trg_support_tickets_client_update_guard must fire BEFORE UPDATE FOR EACH ROW on support_tickets, on every column, enabled';
  END IF;

  -- get_product_failures(): a definer with an empty search_path, for authenticated and the
  -- service role only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = c_pf AND prosecdef AND proconfig = ARRAY['search_path=""']) THEN
    RAISE EXCEPTION '00663: get_product_failures(integer) must be SECURITY DEFINER with search_path = ''''';
  END IF;
  IF NOT has_function_privilege('authenticated', c_pf, 'EXECUTE')
     OR NOT has_function_privilege('service_role', c_pf, 'EXECUTE')
     OR has_function_privilege('anon', c_pf, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = c_pf AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '00663: get_product_failures(integer) must be executable by authenticated and service_role, not by anon or PUBLIC';
  END IF;
END
$check$;

RESET lock_timeout;
```

- [ ] **Step 2: Run GREEN**

Run: `bash supabase/tests/00663/run.sh supabase/migrations/00663_marketing_wider_view.sql`
Expected: every test PASS, last line `N passed, 0 failed`, exit 0. On a failure, fix the migration (never the expected value) and re-run. Two known traps:
- `CREATE OR REPLACE VIEW` fails with "cannot change name of view column" if the first 17 / 5 columns of `panel_rides` / `panel_driver_profiles` are not exactly 00642's, in order.
- V2 lists rides in id order: the 00642 seed ride `f…01` (searching, `-`), then `f…10` customer, `f…11` completed (`-`), `f…12` driver, `f…13` system.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00663_marketing_wider_view.sql
git commit -m "feat(db): marketing reads more of the admin panel and answers support (00663)"
```

---

## Task 4: Allow-list, deny rule and `panelCanAct`

**Files:**
- Modify: `packages/utils/src/adminPanelAccess.ts`
- Test: `packages/utils/src/__tests__/adminPanelAccess.test.ts`

- [ ] **Step 1: Write the failing tests**

In `adminPanelAccess.test.ts`, add `panelCanAct` to the import list, replace the test `'keeps marketing out of everything else'` with the one below, and add the two new tests inside `describe('canOpenPanelPath', …)` and a new `describe` at the end:

```ts
  it('keeps marketing out of everything else', () => {
    for (const path of ['/', '/wallet', '/wallet/gifts', '/settings', '/notifications', '/content',
      '/competitors', '/earnings', '/cancellations', '/cancellations/1', '/live-map', '/fraud',
      '/businesses', '/partners', '/quests', '/audit']) {
      expect(canOpenPanelPath('marketing', path)).toBe(false);
    }
  });

  it('opens the read-only pages to marketing (00663)', () => {
    for (const path of ['/rides', '/rides/abc', '/drivers', '/drivers/abc', '/users', '/users/abc',
      '/reviews', '/support', '/disputes', '/incidents', '/incidents/abc', '/lost-found',
      '/incomplete-drivers', '/pois', '/pois/submissions', '/validation']) {
      expect(canOpenPanelPath('marketing', path)).toBe(true);
    }
  });

  it('keeps marketing out of the stuck-ride assist page under an open page', () => {
    for (const path of ['/rides/abc/assist', '/rides/abc/assist/', '/rides/abc/assist/x']) {
      expect(canOpenPanelPath('marketing', path)).toBe(false);
      expect(canOpenPanelPath('admin', path)).toBe(true);
    }
    expect(canOpenPanelPath('marketing', '/rides/abc/assistance')).toBe(true);
  });
```

```ts
describe('panelCanAct', () => {
  it('lets admins and super admins act and nobody else', () => {
    expect(panelCanAct('admin')).toBe(true);
    expect(panelCanAct('super_admin')).toBe(true);
    expect(panelCanAct('marketing')).toBe(false);
    expect(panelCanAct(null)).toBe(false);
    expect(panelCanAct(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/utils && npx vitest run src/__tests__/adminPanelAccess.test.ts`
Expected: FAIL (`panelCanAct` is not exported; `/rides` closed to marketing).

- [ ] **Step 3: Implement**

In `adminPanelAccess.ts`, replace `MARKETING_ROUTES` and the marketing branch of `canOpenPanelPath`, and add `panelCanAct`:

```ts
/** The pages marketing may open. Each one also covers its sub-pages, except MARKETING_DENIED. */
export const MARKETING_ROUTES: readonly string[] = [
  '/launch-pulse',
  '/funnel',
  '/code-performance',
  '/segments',
  '/reports',
  '/referrals',
  '/promotions',
  '/campaigns',
  '/announcements',
  '/blog',
  // Read-only (00663). Marketing acts only on /support.
  '/rides',
  '/drivers',
  '/users',
  '/reviews',
  '/support',
  '/disputes',
  '/incidents',
  '/lost-found',
  '/incomplete-drivers',
  '/pois',
  '/validation',
];

/** Sub-pages of an allowed page that marketing still may not open: the stuck-ride assist tools. */
const MARKETING_DENIED: readonly RegExp[] = [/^\/rides\/[^/]+\/assist(?:\/|$)/];
```

```ts
export function canOpenPanelPath(role: PanelRole, pathname: string): boolean {
  if (underRoute(SUPER_ADMIN_ROUTES, pathname)) return role === 'super_admin';
  if (role === 'admin' || role === 'super_admin') return true;
  if (role !== 'marketing') return false;
  return underRoute(MARKETING_ROUTES, pathname) && !MARKETING_DENIED.some((re) => re.test(pathname));
}

/**
 * Whether the panel shows actions (approve, edit, cancel, move money). Admins and super admins
 * act; marketing only reads, except on /support. An unknown role acts on nothing. It only shapes
 * the UI: the server refuses those actions on its own.
 */
export function panelCanAct(role: PanelRole | null | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/utils && npx vitest run src/__tests__/adminPanelAccess.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/adminPanelAccess.ts packages/utils/src/__tests__/adminPanelAccess.test.ts
git commit -m "feat(utils): open eleven read-only admin pages to marketing"
```

---

## Task 5: `panelReadService` — lists

**Files:**
- Create: `packages/api/src/services/_search.ts`
- Modify: `packages/api/src/services/admin.service.ts:6-18` (move the two helpers out)
- Create: `packages/api/src/services/panel-read.service.ts`
- Create: `packages/api/src/services/__tests__/panel-read.test.ts`
- Modify: `packages/api/src/index.ts`, `packages/api/package.json`

- [ ] **Step 1: Move the search helpers**

Create `packages/api/src/services/_search.ts`:

```ts
/** Escape special characters for PostgreSQL ILIKE patterns. */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}

/**
 * A ride code as riders and support write it ("F1A2B3C4", "#f1a2b3c4"): the first 8 hex
 * characters of the ride id, lower-cased. null when the text is not one.
 */
export function rideCodePrefix(text: string): string | null {
  const m = text.trim().match(/^#?([0-9a-f]{8})$/i);
  return m ? m[1]!.toLowerCase() : null;
}
```

In `admin.service.ts`, delete the two function definitions (lines 6–18) and add `import { escapeLikePattern, rideCodePrefix } from './_search';` next to the other imports.

- [ ] **Step 2: Write the failing tests**

`packages/api/src/services/__tests__/panel-read.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A query chain that records every call and resolves to the next queued result. */
const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
const results: Array<{ data: unknown; error: unknown }> = [];
function chain(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const result = results.shift() ?? { data: [], error: null };
  const proxy: Record<string, unknown> = {};
  for (const op of ['select', 'eq', 'in', 'gte', 'lt', 'lte', 'or', 'ilike', 'order', 'range', 'limit', 'maybeSingle', 'single']) {
    proxy[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return proxy;
    };
  }
  proxy.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return proxy;
}
const mockRpc = vi.fn();
vi.mock('../../client', () => ({
  getSupabaseClient: () => ({ from: (t: string) => chain(t), rpc: mockRpc }),
}));

import { panelReadService } from '../panel-read.service';

beforeEach(() => {
  calls.length = 0;
  results.length = 0;
  mockRpc.mockReset();
});

describe('panelReadService.getRides', () => {
  it('reads panel_rides with the same filters as the admin list', async () => {
    results.push({ data: [{ id: 'r1' }], error: null });
    const rows = await panelReadService.getRides({ status: 'canceled', search: 'F1A2B3C4', rideMode: 'cargo' }, 1, 20);
    expect(rows).toEqual([{ id: 'r1' }]);
    expect(calls[0]!.table).toBe('panel_rides');
    expect(calls[0]!.ops).toEqual(expect.arrayContaining([
      ['select', ['*']],
      ['range', [20, 39]],
      ['eq', ['status', 'canceled']],
      ['eq', ['ride_mode', 'cargo']],
      ['gte', ['id', 'f1a2b3c4-0000-0000-0000-000000000000']],
      ['lte', ['id', 'f1a2b3c4-ffff-ffff-ffff-ffffffffffff']],
    ]));
  });

  it('searches addresses when the text is not a ride code, escaping LIKE characters', async () => {
    results.push({ data: [], error: null });
    await panelReadService.getRides({ search: 'Calle 23_%' });
    expect(calls[0]!.ops).toContainEqual(['or', ['pickup_address.ilike.%Calle 23\\_\\%%,dropoff_address.ilike.%Calle 23\\_\\%%']]);
  });

  it('throws the Supabase error', async () => {
    results.push({ data: null, error: new Error('boom') });
    await expect(panelReadService.getRides()).rejects.toThrow('boom');
  });
});

describe('panelReadService.getDrivers', () => {
  it('reads panel_driver_profiles and shapes rows like the admin list', async () => {
    results.push({
      data: [{ id: 'd1', full_name: 'Diego', phone: null, email: 'd@x.cu', vehicle_type: 'triciclo', plate_number: 'P1' },
             { id: 'd2', full_name: 'Sin auto', phone: '+535', email: null, vehicle_type: null, plate_number: null }],
      error: null,
    });
    const rows = await panelReadService.getDrivers(0, 20, { search: 'Die', vehicleType: 'triciclo', ratingMin: 4 });
    expect(calls[0]!.table).toBe('panel_driver_profiles');
    expect(calls[0]!.ops).toEqual(expect.arrayContaining([
      ['ilike', ['full_name', '%Die%']],
      ['eq', ['vehicle_type', 'triciclo']],
      ['gte', ['rating_avg', 4]],
    ]));
    expect(rows[0]!.users).toEqual({ full_name: 'Diego', phone: '', email: 'd@x.cu' });
    expect(rows[0]!.vehicles).toEqual([{ type: 'triciclo', plate_number: 'P1' }]);
    expect(rows[1]!.vehicles).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd packages/api && npx vitest run src/services/__tests__/panel-read.test.ts`
Expected: FAIL (cannot find `../panel-read.service`).

- [ ] **Step 4: Implement the lists**

`packages/api/src/services/panel-read.service.ts`:

```ts
// ============================================================
// TriciGo — what the admin panel reads through the panel views (00642, 00663)
// The views leave out GPS, the tracking link, wallets, documents and identity data, and
// answer admins and marketing only. Lists read them for every role; marketing's detail pages
// read only them and the tables 00663 opened to marketing.
// ============================================================

import type {
  DriverScoreEvent,
  DriverStatus,
  IncidentReport,
  PaymentMethod,
  RideDispute,
  RidePricingSnapshot,
  RideStatus,
  RideTransition,
  ServiceTypeSlug,
  User,
  VehicleType,
} from '@tricigo/types';
import { havanaDayRangeUtc } from '@tricigo/utils';
import { getSupabaseClient } from '../client';
import { escapeLikePattern, rideCodePrefix } from './_search';

export type CanceledByRole = 'customer' | 'driver' | 'staff' | 'system';

/** One row of panel_rides. */
export interface PanelRide {
  id: string;
  created_at: string;
  status: RideStatus;
  customer_id: string;
  driver_id: string | null;
  service_type: ServiceTypeSlug;
  city_id: string | null;
  estimated_fare_cup: number;
  final_fare_cup: number | null;
  final_fare_trc: number | null;
  payment_method: PaymentMethod;
  pickup_address: string;
  dropoff_address: string;
  promo_code_id: string | null;
  discount_amount_cup: number;
  shared_ride_discount_cup: number;
  dispatch_round: number;
  ride_mode: 'passenger' | 'cargo';
  is_scheduled: boolean;
  scheduled_at: string | null;
  accepted_at: string | null;
  driver_arrived_at: string | null;
  pickup_at: string | null;
  arrived_at_destination_at: string | null;
  completed_at: string | null;
  canceled_at: string | null;
  canceled_by: string | null;
  canceled_by_role: CanceledByRole | null;
  cancellation_reason: string | null;
  cancellation_reason_code: string | null;
  estimated_distance_m: number | null;
  actual_distance_m: number | null;
  estimated_duration_s: number | null;
  actual_duration_s: number | null;
  wait_time_seconds: number | null;
  wait_charge_cup: number | null;
  passenger_count: number | null;
  shared_ride: boolean;
  is_split: boolean;
  corporate_account_id: string | null;
  partner_place_id: string | null;
  partner_discount_cup: number;
  tip_amount: number | null;
  surge_multiplier: number | null;
  driver_gps_status: string | null;
  searching_seen_at: string | null;
  last_dispatched_at: string | null;
  payment_status: string | null;
}

/** One row of panel_driver_profiles. */
export interface PanelDriverRow {
  id: string;
  user_id: string;
  is_online: boolean;
  total_rides_completed: number;
  total_rides: number;
  status: DriverStatus;
  rating_avg: number | null;
  acceptance_rate: number | null;
  total_rides_offered: number | null;
  city_id: string | null;
  zone_id: string | null;
  municipality: string | null;
  province: string | null;
  created_at: string;
  approved_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  is_on_break: boolean;
  auto_accept_enabled: boolean | null;
  last_heartbeat_at: string | null;
  auto_offline_at: string | null;
  terms_accepted_at: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  vehicle_type: VehicleType | null;
  plate_number: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_year: number | null;
}

/** A drivers-list row, shaped like the admin list it replaces. */
export interface PanelDriverListItem extends PanelDriverRow {
  users: { full_name: string; phone: string; email: string | null };
  vehicles: { type: VehicleType; plate_number: string }[];
}

export interface PanelRideFilters {
  status?: string;
  serviceType?: string;
  paymentMethod?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  cityId?: string;
  rideMode?: 'passenger' | 'cargo';
}

export interface PanelDriverFilters {
  status?: string;
  search?: string;
  ratingMin?: number;
  vehicleType?: string;
  cityId?: string;
}

function toListItem(row: PanelDriverRow): PanelDriverListItem {
  return {
    ...row,
    users: { full_name: row.full_name, phone: row.phone ?? '', email: row.email },
    vehicles: row.vehicle_type && row.plate_number
      ? [{ type: row.vehicle_type, plate_number: row.plate_number }]
      : [],
  };
}

export const panelReadService = {
  /** The rides list: panel_rides, with the admin list's filters. */
  async getRides(filters: PanelRideFilters = {}, page = 0, pageSize = 20): Promise<PanelRide[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    let query = supabase
      .from('panel_rides')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.serviceType) query = query.eq('service_type', filters.serviceType);
    if (filters.rideMode) query = query.eq('ride_mode', filters.rideMode);
    if (filters.paymentMethod) query = query.eq('payment_method', filters.paymentMethod);
    // Date inputs are Havana calendar days ('YYYY-MM-DD').
    if (filters.dateFrom) query = query.gte('created_at', havanaDayRangeUtc(filters.dateFrom).start.toISOString());
    if (filters.dateTo) query = query.lt('created_at', havanaDayRangeUtc(filters.dateTo).end.toISOString());
    if (filters.search) {
      const code = rideCodePrefix(filters.search);
      if (code) {
        query = query
          .gte('id', `${code}-0000-0000-0000-000000000000`)
          .lte('id', `${code}-ffff-ffff-ffff-ffffffffffff`);
      } else {
        const escaped = escapeLikePattern(filters.search);
        query = query.or(`pickup_address.ilike.%${escaped}%,dropoff_address.ilike.%${escaped}%`);
      }
    }
    if (filters.cityId) query = query.eq('city_id', filters.cityId);

    const { data, error } = await query;
    if (error) throw error;
    return data as PanelRide[];
  },

  /** The drivers list: panel_driver_profiles, with the admin list's filters. */
  async getDrivers(page = 0, pageSize = 20, filters: PanelDriverFilters = {}): Promise<PanelDriverListItem[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    let query = supabase
      .from('panel_driver_profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status);
    if (filters.search) query = query.ilike('full_name', `%${escapeLikePattern(filters.search)}%`);
    if (filters.ratingMin !== undefined && filters.ratingMin > 0) query = query.gte('rating_avg', filters.ratingMin);
    if (filters.cityId) query = query.eq('city_id', filters.cityId);
    if (filters.vehicleType) query = query.eq('vehicle_type', filters.vehicleType);

    const { data, error } = await query;
    if (error) throw error;
    return (data as PanelDriverRow[]).map(toListItem);
  },
};
```

- [ ] **Step 5: Export it**

In `packages/api/src/index.ts`, after the `teamService` export block, add:

```ts
export {
  panelReadService,
  type CanceledByRole,
  type PanelRide,
  type PanelDriverRow,
  type PanelDriverListItem,
  type PanelRideFilters,
  type PanelDriverFilters,
} from './services/panel-read.service';
```

Tasks 6 and 7 add their types to this block. In `packages/api/package.json` `exports`, add `"./services/panel-read": "./src/services/panel-read.service.ts",` next to `"./services/admin"`.

- [ ] **Step 6: Run the tests**

Run: `cd packages/api && npx vitest run src/services/__tests__/panel-read.test.ts`
Expected: PASS for the `getRides` and `getDrivers` tests.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/services/_search.ts packages/api/src/services/admin.service.ts \
  packages/api/src/services/panel-read.service.ts packages/api/src/services/__tests__/panel-read.test.ts \
  packages/api/src/index.ts packages/api/package.json
git commit -m "feat(api): panelReadService lists rides and drivers through the panel views"
```

---

## Task 6: `panelReadService` — details, disputes and incidents

**Files:**
- Modify: `packages/api/src/services/panel-read.service.ts`
- Test: `packages/api/src/services/__tests__/panel-read.test.ts`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```ts
describe('panelReadService details', () => {
  it('reads a ride, its timeline, its price and both people without the chat or delivery', async () => {
    results.push(
      { data: { id: 'r1', customer_id: 'c1', driver_id: 'd1' }, error: null }, // panel_rides
      { data: [{ id: 't1' }], error: null },                                   // ride_transitions
      { data: { ride_id: 'r1', total: 1500 }, error: null },                    // ride_pricing_snapshots
      { data: { full_name: 'Carla', phone: '+5355' }, error: null },            // users
      { data: { id: 'd1', full_name: 'Diego', phone: null }, error: null },     // panel_driver_profiles
    );
    const detail = await panelReadService.getRideDetail('r1');
    expect(calls.map((c) => c.table)).toEqual(['panel_rides', 'ride_transitions', 'ride_pricing_snapshots', 'users', 'panel_driver_profiles']);
    expect(detail.customerInfo).toEqual({ name: 'Carla', phone: '+5355' });
    expect(detail.driverInfo).toEqual({ id: 'd1', name: 'Diego', phone: null });
    expect(detail.pricing).toEqual({ ride_id: 'r1', total: 1500 });
  });

  it('reads a driver from the views and keeps the latest document per type', async () => {
    results.push(
      { data: { id: 'd1', full_name: 'Diego' }, error: null },                // panel_driver_profiles
      { data: [
          { id: 'a', document_type: 'selfie', uploaded_at: '2026-10-02' },
          { id: 'b', document_type: 'selfie', uploaded_at: '2026-10-01' },
          { id: 'c', document_type: 'national_id', uploaded_at: '2026-10-01' },
        ], error: null },                                                     // panel_driver_documents
      { data: [{ id: 'e1' }], error: null },                                  // driver_score_events
      { data: { driver_profile_id: 'd1', risk_level: 'high' }, error: null }, // panel_driver_churn_risk
    );
    const detail = await panelReadService.getDriverDetail('d1');
    expect(calls.map((c) => c.table)).toEqual(['panel_driver_profiles', 'panel_driver_documents', 'driver_score_events', 'panel_driver_churn_risk']);
    expect(detail.documents.map((d) => d.id)).toEqual(['a', 'c']);
    expect(detail.churn).toEqual({ driver_profile_id: 'd1', risk_level: 'high' });
  });

  it('counts a user’s rides and total spent from panel_rides', async () => {
    results.push(
      { data: { id: 'u1', full_name: 'Carla' }, error: null },
      { data: [
          { status: 'completed', final_fare_cup: 1500 },
          { status: 'completed', final_fare_cup: null },
          { status: 'canceled', final_fare_cup: null },
          { status: 'searching', final_fare_cup: null },
        ], error: null },
    );
    const detail = await panelReadService.getUserDetail('u1');
    expect(calls.map((c) => c.table)).toEqual(['users', 'panel_rides']);
    expect(detail).toMatchObject({ ridesAsCustomer: 4, completedAsCustomer: 2, canceledAsCustomer: 1, totalSpentCup: 1500 });
  });

  it('reads disputes and incidents from their views', async () => {
    results.push({ data: [{ id: 'x' }], error: null }, { data: [{ id: 'y' }], error: null });
    await panelReadService.getDisputes({ status: 'open', limit: 10 });
    await panelReadService.getIncidents('open', 0, 20);
    expect(calls.map((c) => c.table)).toEqual(['panel_ride_disputes', 'panel_incident_reports']);
    expect(calls[0]!.ops).toContainEqual(['eq', ['status', 'open']]);
    expect(calls[0]!.ops).toContainEqual(['limit', [10]]);
  });

  it('reads an incident with names, a ride summary from panel_rides and the reported review', async () => {
    results.push(
      { data: { id: 'i1', reported_by: 'u1', against_user_id: 'u2', resolved_by: null, ride_id: 'r1', type: 'review_abuse', review_id: 'v1' }, error: null },
      { data: [{ id: 'u1', full_name: 'Carla', phone: '1' }, { id: 'u2', full_name: 'Diego', phone: '2' }], error: null },
      { data: { id: 'r1', status: 'completed', pickup_address: 'A', dropoff_address: 'B' }, error: null },
      { data: { id: 'v1', rating: 1, comment: 'x', is_visible: true, created_at: 't' }, error: null },
    );
    const detail = await panelReadService.getIncidentDetail('i1');
    expect(calls.map((c) => c.table)).toEqual(['panel_incident_reports', 'users', 'panel_rides', 'reviews']);
    expect(detail?.reporter).toEqual({ name: 'Carla', phone: '1' });
    expect(detail?.ride?.pickup_address).toBe('A');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/api && npx vitest run src/services/__tests__/panel-read.test.ts`
Expected: FAIL (`getRideDetail` is not a function).

- [ ] **Step 3: Implement** (add the types above `panelReadService` and the methods inside it)

```ts
export interface PanelRideDetail {
  ride: PanelRide;
  transitions: RideTransition[];
  pricing: RidePricingSnapshot | null;
  customerInfo: { name: string; phone: string | null } | null;
  driverInfo: { id: string; name: string; phone: string | null } | null;
}

export interface PanelDriverDocument {
  id: string;
  driver_id: string;
  document_type: string;
  uploaded_at: string | null;
  is_verified: boolean;
  verified_at: string | null;
  rejection_reason: string | null;
}

export interface PanelChurnRisk {
  driver_profile_id: string;
  days_since_last_ride: number | null;
  churn_risk_score: number | null;
  risk_level: string | null;
}

export interface PanelDriverDetail {
  profile: PanelDriverRow;
  documents: PanelDriverDocument[];
  scoreEvents: DriverScoreEvent[];
  churn: PanelChurnRisk | null;
}

export interface PanelUserDetail {
  user: User;
  ridesAsCustomer: number;
  completedAsCustomer: number;
  canceledAsCustomer: number;
  totalSpentCup: number;
}

/** A type with some fields that a panel view leaves out. */
type WithHidden<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
export type PanelDispute = WithHidden<RideDispute,
  'evidence_urls' | 'respondent_evidence_urls' | 'refund_amount_trc' | 'refund_transaction_id'
  | 'admin_notes' | 'ride_estimated_fare_trc' | 'ride_final_fare_trc'>;
export type PanelIncident = WithHidden<IncidentReport, 'evidence_urls' | 'resolution_notes'>;

export interface PanelIncidentDetail {
  incident: PanelIncident;
  reporter: { name: string; phone: string } | null;
  against: { name: string; phone: string } | null;
  resolver: { name: string; phone: string } | null;
  ride: { id: string; status: string; pickup_address: string; dropoff_address: string } | null;
  review: { id: string; rating: number; comment: string | null; is_visible: boolean; created_at: string } | null;
}
```

Methods (inside `panelReadService`):

```ts
  /** A ride for marketing: no chat, no delivery code or photos, no coordinates. */
  async getRideDetail(rideId: string): Promise<PanelRideDetail> {
    const supabase = getSupabaseClient();
    const [rideRes, transitionsRes, pricingRes] = await Promise.all([
      supabase.from('panel_rides').select('*').eq('id', rideId).single(),
      supabase.from('ride_transitions').select('*').eq('ride_id', rideId).order('created_at', { ascending: true }),
      supabase.from('ride_pricing_snapshots').select('*').eq('ride_id', rideId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (rideRes.error) throw rideRes.error;
    const ride = rideRes.data as PanelRide;

    const [custRes, driverRes] = await Promise.all([
      supabase.from('users').select('full_name, phone').eq('id', ride.customer_id).maybeSingle(),
      ride.driver_id
        ? supabase.from('panel_driver_profiles').select('id, full_name, phone').eq('id', ride.driver_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const cust = custRes.data as { full_name: string; phone: string | null } | null;
    const drv = driverRes.data as { id: string; full_name: string; phone: string | null } | null;
    return {
      ride,
      transitions: (transitionsRes.data as RideTransition[]) ?? [],
      pricing: (pricingRes.data as RidePricingSnapshot) ?? null,
      customerInfo: cust ? { name: cust.full_name, phone: cust.phone } : null,
      driverInfo: drv ? { id: drv.id, name: drv.full_name, phone: drv.phone } : null,
    };
  },

  /** A driver for marketing: no wallet, files, selfies, contract, identity or earnings. */
  async getDriverDetail(driverId: string): Promise<PanelDriverDetail> {
    const supabase = getSupabaseClient();
    const [profileRes, docsRes, eventsRes, churnRes] = await Promise.all([
      supabase.from('panel_driver_profiles').select('*').eq('id', driverId).single(),
      supabase.from('panel_driver_documents').select('*').eq('driver_id', driverId)
        .order('uploaded_at', { ascending: false }).limit(100),
      supabase.from('driver_score_events').select('*').eq('driver_id', driverId)
        .order('created_at', { ascending: false }).limit(20),
      supabase.from('panel_driver_churn_risk').select('*').eq('driver_profile_id', driverId).maybeSingle(),
    ]);
    if (profileRes.error) throw profileRes.error;
    // The most recent document per type, as the admin page shows (re-uploads leave old rows).
    const latest = new Map<string, PanelDriverDocument>();
    for (const doc of (docsRes.data as PanelDriverDocument[]) ?? []) {
      if (!latest.has(doc.document_type)) latest.set(doc.document_type, doc);
    }
    return {
      profile: profileRes.data as PanelDriverRow,
      documents: Array.from(latest.values()),
      scoreEvents: (eventsRes.data as DriverScoreEvent[]) ?? [],
      churn: (churnRes.data as PanelChurnRisk) ?? null,
    };
  },

  /** A user for marketing: no wallet, transfers or penalties. */
  async getUserDetail(userId: string): Promise<PanelUserDetail> {
    const supabase = getSupabaseClient();
    const [userRes, ridesRes] = await Promise.all([
      supabase.from('users').select('*').eq('id', userId).single(),
      supabase.from('panel_rides').select('status, final_fare_cup').eq('customer_id', userId).limit(10000),
    ]);
    if (userRes.error) throw userRes.error;
    const rides = (ridesRes.data ?? []) as Array<{ status: RideStatus; final_fare_cup: number | null }>;
    const completed = rides.filter((r) => r.status === 'completed');
    return {
      user: userRes.data as User,
      ridesAsCustomer: rides.length,
      completedAsCustomer: completed.length,
      canceledAsCustomer: rides.filter((r) => r.status === 'canceled').length,
      totalSpentCup: completed.reduce((sum, r) => sum + (r.final_fare_cup ?? 0), 0),
    };
  },

  /** Disputes without evidence, refunds or admin notes. */
  async getDisputes(params?: { status?: string; limit?: number }): Promise<PanelDispute[]> {
    const supabase = getSupabaseClient();
    let query = supabase.from('panel_ride_disputes').select('*')
      .order('created_at', { ascending: false }).limit(params?.limit ?? 50);
    if (params?.status) query = query.eq('status', params.status);
    const { data, error } = await query;
    if (error) throw error;
    return data as PanelDispute[];
  },

  /** Incident reports without evidence or resolution notes. */
  async getIncidents(status?: string, page = 0, pageSize = 20): Promise<PanelIncident[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    let query = supabase.from('panel_incident_reports').select('*')
      .order('created_at', { ascending: false }).range(from, from + pageSize - 1);
    if (status && status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return data as PanelIncident[];
  },

  async getIncidentDetail(id: string): Promise<PanelIncidentDetail | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.from('panel_incident_reports').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const incident = data as PanelIncident;

    const userIds = [incident.reported_by, incident.against_user_id, incident.resolved_by]
      .filter((v): v is string => Boolean(v));
    const userMap: Record<string, { name: string; phone: string }> = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, full_name, phone').in('id', userIds);
      for (const u of (users ?? []) as { id: string; full_name: string; phone: string }[]) {
        userMap[u.id] = { name: u.full_name, phone: u.phone };
      }
    }
    let ride: PanelIncidentDetail['ride'] = null;
    if (incident.ride_id) {
      const { data: r } = await supabase.from('panel_rides')
        .select('id, status, pickup_address, dropoff_address').eq('id', incident.ride_id).maybeSingle();
      ride = (r as PanelIncidentDetail['ride']) ?? null;
    }
    let review: PanelIncidentDetail['review'] = null;
    if (incident.type === 'review_abuse' && incident.review_id) {
      const { data: rev } = await supabase.from('reviews')
        .select('id, rating, comment, is_visible, created_at').eq('id', incident.review_id).maybeSingle();
      review = (rev as PanelIncidentDetail['review']) ?? null;
    }
    return {
      incident,
      reporter: userMap[incident.reported_by] ?? null,
      against: incident.against_user_id ? (userMap[incident.against_user_id] ?? null) : null,
      resolver: incident.resolved_by ? (userMap[incident.resolved_by] ?? null) : null,
      ride,
      review,
    };
  },
```

- [ ] **Step 4: Export the new types**

Add to the `panel-read.service` export block in `packages/api/src/index.ts`: `type PanelRideDetail, type PanelDriverDocument, type PanelChurnRisk, type PanelDriverDetail, type PanelUserDetail, type PanelDispute, type PanelIncident, type PanelIncidentDetail,`.

- [ ] **Step 5: Run the tests**

Run: `cd packages/api && npx vitest run src/services/__tests__/panel-read.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/panel-read.service.ts packages/api/src/services/__tests__/panel-read.test.ts packages/api/src/index.ts
git commit -m "feat(api): panel reads of ride, driver, user, dispute and incident details"
```

---

## Task 7: Product failures in the service

**Files:**
- Modify: `packages/api/src/services/panel-read.service.ts`
- Test: `packages/api/src/services/__tests__/panel-read.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { parseProductFailures } from '../panel-read.service';

describe('product failures', () => {
  it('parses the RPC answer and drops malformed entries', () => {
    expect(parseProductFailures({
      days: 30,
      places_not_found: [{ name: 'Paladar X', searches: 2, last_seen: 't', imported: 0 }, { name: 5 }],
      push_outcomes: [{ app: 'client', outcome: 'denied', users: 3 }],
      push_reach: { riders_active: 10, riders_reachable: 4, drivers_active: 5, drivers_reachable: 5 },
      app_versions: [{ app: 'client', version: '1.7.3', platform: 'android', installs: 2 }],
      failed_payments: [{ reason: 'Invalid card number', payments: 4, last_seen: 't' }],
    })).toEqual({
      days: 30,
      placesNotFound: [{ name: 'Paladar X', searches: 2, lastSeen: 't', imported: 0 }],
      pushOutcomes: [{ app: 'client', outcome: 'denied', users: 3 }],
      pushReach: { ridersActive: 10, ridersReachable: 4, driversActive: 5, driversReachable: 5 },
      appVersions: [{ app: 'client', version: '1.7.3', platform: 'android', installs: 2 }],
      failedPayments: [{ reason: 'Invalid card number', payments: 4, lastSeen: 't' }],
    });
  });

  it('returns empty blocks for an answer it cannot read', () => {
    expect(parseProductFailures(null)).toEqual({
      days: 0, placesNotFound: [], pushOutcomes: [],
      pushReach: { ridersActive: 0, ridersReachable: 0, driversActive: 0, driversReachable: 0 },
      appVersions: [], failedPayments: [],
    });
  });

  it('calls get_product_failures with the period', async () => {
    mockRpc.mockResolvedValueOnce({ data: { days: 7 }, error: null });
    const r = await panelReadService.getProductFailures(7);
    expect(mockRpc).toHaveBeenCalledWith('get_product_failures', { p_days: 7 });
    expect(r.days).toBe(7);
  });

  it('throws the RPC error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('Admin only') });
    await expect(panelReadService.getProductFailures(7)).rejects.toThrow('Admin only');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd packages/api && npx vitest run src/services/__tests__/panel-read.test.ts`
Expected: FAIL (`parseProductFailures` is not exported).

- [ ] **Step 3: Implement** (above `panelReadService`, and the method inside it)

```ts
export interface ProductFailures {
  days: number;
  placesNotFound: { name: string; searches: number; lastSeen: string; imported: number }[];
  pushOutcomes: { app: string; outcome: string; users: number }[];
  pushReach: { ridersActive: number; ridersReachable: number; driversActive: number; driversReachable: number };
  appVersions: { app: string; version: string | null; platform: string | null; installs: number }[];
  failedPayments: { reason: string; payments: number; lastSeen: string }[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];

/** What get_product_failures() returns, typed; malformed entries are dropped. */
export function parseProductFailures(raw: unknown): ProductFailures {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const reach = (typeof r.push_reach === 'object' && r.push_reach !== null ? r.push_reach : {}) as Record<string, unknown>;
  return {
    days: num(r.days),
    placesNotFound: list(r.places_not_found)
      .filter((p) => typeof p.name === 'string')
      .map((p) => ({ name: p.name as string, searches: num(p.searches), lastSeen: str(p.last_seen) ?? '', imported: num(p.imported) })),
    pushOutcomes: list(r.push_outcomes)
      .filter((p) => typeof p.app === 'string' && typeof p.outcome === 'string')
      .map((p) => ({ app: p.app as string, outcome: p.outcome as string, users: num(p.users) })),
    pushReach: {
      ridersActive: num(reach.riders_active),
      ridersReachable: num(reach.riders_reachable),
      driversActive: num(reach.drivers_active),
      driversReachable: num(reach.drivers_reachable),
    },
    appVersions: list(r.app_versions)
      .filter((p) => typeof p.app === 'string')
      .map((p) => ({ app: p.app as string, version: str(p.version), platform: str(p.platform), installs: num(p.installs) })),
    failedPayments: list(r.failed_payments)
      .filter((p) => typeof p.reason === 'string')
      .map((p) => ({ reason: p.reason as string, payments: num(p.payments), lastSeen: str(p.last_seen) ?? '' })),
  };
}
```

```ts
  /** The "Fallas del producto" section of Reportes (00663). */
  async getProductFailures(days: number): Promise<ProductFailures> {
    const { data, error } = await getSupabaseClient().rpc('get_product_failures', { p_days: days });
    if (error) throw error;
    return parseProductFailures(data);
  },
```

- [ ] **Step 4: Export them**

Add `parseProductFailures,` and `type ProductFailures,` to the `panel-read.service` export block in `packages/api/src/index.ts`.

- [ ] **Step 5: Run all `@tricigo/api` tests and the type check**

Run: `cd packages/api && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc prints only the errors under `src/__tests__/` that CLAUDE.md lists as pre-existing (compare with `git stash; npx tsc --noEmit -p tsconfig.json; git stash pop`).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/panel-read.service.ts packages/api/src/services/__tests__/panel-read.test.ts packages/api/src/index.ts
git commit -m "feat(api): product failures for Reportes"
```

---

## Task 8: `useCanAct`, ride cancel label, and the two lists

**Files:**
- Create: `apps/admin/src/lib/useCanAct.ts`
- Create: `apps/admin/src/lib/rideCancel.ts`
- Modify: `apps/admin/src/app/rides/page.tsx`
- Modify: `apps/admin/src/app/drivers/page.tsx`

- [ ] **Step 1: The hook**

```ts
'use client';

import { panelCanAct } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from './panelRole';

/**
 * Whether the page shows actions, and whether the role is known yet (00663). Marketing only
 * reads, except on /support. Pages that read different data by role wait for `ready`.
 */
export function useCanAct(): { canAct: boolean; ready: boolean } {
  const { role, loading } = usePanelRole();
  return { canAct: panelCanAct(role), ready: !loading };
}
```

- [ ] **Step 2: The cancel label**

```ts
import type { TFunction } from 'i18next';
import type { CanceledByRole } from '@tricigo/api';

/** Who canceled a ride and why, for the rides list and the ride detail. */
export function rideCancelSummary(
  t: TFunction,
  role: CanceledByRole | null | undefined,
  reason: string | null | undefined,
): string {
  const who = role
    ? t(`panel_view.canceled_by_${role}`, {
        defaultValue: { customer: 'Pasajero', driver: 'Conductor', staff: 'Soporte', system: 'Sistema' }[role],
      })
    : t('panel_view.canceled_by_unknown', { defaultValue: 'Sin dato' });
  return reason ? `${who} · ${reason}` : who;
}
```

Check that `TFunction` is importable as in `apps/admin/src/lib/rideType.ts` (copy its import line if it differs).

- [ ] **Step 3: Rides list reads the view**

In `apps/admin/src/app/rides/page.tsx`:
- Replace `import { adminService } from '@tricigo/api/services/admin';` with `import { panelReadService, type PanelRide } from '@tricigo/api';` (keep `adminService` only if the file still uses it elsewhere; `grep -n adminService` after the edit).
- Remove `import type { Ride } from '@tricigo/types';` and replace every `Ride` type in the file with `PanelRide` (`useState<PanelRide[]>`, `keyof PanelRide`, `DataColumn<PanelRide>[]`, `DataTable<PanelRide>`).
- Replace `await adminService.getRides(query, page, PAGE_SIZE)` with `await panelReadService.getRides(query, page, PAGE_SIZE)`.
- In the status column's `render`, show who canceled under the badge. Wrap the existing `<StatusBadge … />` like this (import `rideCancelSummary` from `@/lib/rideCancel`):

```tsx
<div className="flex flex-col gap-0.5">
  <StatusBadge domain="ride" status={r.status} />
  {r.status === 'canceled' && (
    <span className="text-[11px] text-ink-subtle">
      {rideCancelSummary(t, r.canceled_by_role, r.cancellation_reason)}
    </span>
  )}
</div>
```

(use the row variable name the column already uses). In the CSV export, add a column with `rideCancelSummary(t, r.canceled_by_role, r.cancellation_reason)` for canceled rides and `''` otherwise, with the header `t('panel_view.csv_canceled_by', { defaultValue: 'Canceló' })`.

- [ ] **Step 4: Drivers list reads the view**

In `apps/admin/src/app/drivers/page.tsx`:
- Replace `import type { DriverProfileWithUser, DriverStatus } from '@tricigo/types';` with `import type { DriverStatus } from '@tricigo/types';` and `import { panelReadService, type PanelDriverListItem } from '@tricigo/api';`.
- Replace every `DriverProfileWithUser` in the file with `PanelDriverListItem`.
- Replace `await adminService.getAllDrivers(page, PAGE_SIZE, filters)` with `await panelReadService.getDrivers(page, PAGE_SIZE, filters)`.
- Remove the `adminService` import if nothing else uses it.

- [ ] **Step 5: Type check the admin app**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no errors. An error like "Property 'x' does not exist on type 'PanelRide'" means the list reads a column the view does not have: add the column to the view in 00663 (end of the column list), to `PanelRide`, and to the expected list in the migration's comments, then re-run Task 3 Step 2.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/useCanAct.ts apps/admin/src/lib/rideCancel.ts apps/admin/src/app/rides/page.tsx apps/admin/src/app/drivers/page.tsx
git commit -m "feat(admin): rides and drivers lists read the panel views"
```

---

## Task 9: Read-only detail pages for marketing

**Files:**
- Create: `apps/admin/src/components/panel/RideDetailReadOnly.tsx`
- Create: `apps/admin/src/components/panel/DriverDetailReadOnly.tsx`
- Create: `apps/admin/src/components/panel/UserDetailReadOnly.tsx`
- Modify: `apps/admin/src/app/rides/[id]/page.tsx:83`, `apps/admin/src/app/drivers/[id]/page.tsx:108`, `apps/admin/src/app/users/[id]/page.tsx:52`

- [ ] **Step 1: A shared row helper and `RideDetailReadOnly`**

`apps/admin/src/components/panel/RideDetailReadOnly.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { panelReadService, type PanelRideDetail } from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { StatusBadge } from '@/components/data/StatusBadge';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { rideTypeLabel } from '@/lib/rideType';
import { rideCancelSummary } from '@/lib/rideCancel';

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/** A ride as marketing sees it (00663): no chat, delivery code or photos, map or actions. */
export function RideDetailReadOnly({ rideId }: { rideId: string }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<PanelRideDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await panelReadService.getRideDetail(rideId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [rideId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <AdminErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return <AdminTableSkeleton rows={6} columns={2} />;

  const { ride, transitions, pricing, customerInfo, driverInfo } = data;
  const km = (m: number | null) => (m == null ? '—' : `${(m / 1000).toFixed(1)} km`);
  const min = (s: number | null) => (s == null ? '—' : `${Math.round(s / 60)} min`);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold text-ink">#{ride.id.slice(0, 8)}</h1>
        <StatusBadge domain="ride" status={ride.status} size="md" />
        <span className="text-[12.5px] text-ink-muted">{formatAdminDate(ride.created_at)}</span>
      </header>

      <SectionCard title={t('panel_view.ride_summary', { defaultValue: 'Resumen' })}>
        <dl className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('panel_view.ride_type', { defaultValue: 'Tipo' })}>{rideTypeLabel(t, ride.service_type, ride.ride_mode)}</Field>
          <Field label={t('panel_view.ride_pickup', { defaultValue: 'Origen' })}>{ride.pickup_address}</Field>
          <Field label={t('panel_view.ride_dropoff', { defaultValue: 'Destino' })}>{ride.dropoff_address}</Field>
          <Field label={t('panel_view.ride_estimate', { defaultValue: 'Tarifa estimada' })}>{formatCUP(ride.estimated_fare_cup)}</Field>
          <Field label={t('panel_view.ride_final', { defaultValue: 'Tarifa final' })}>{ride.final_fare_cup == null ? '—' : formatCUP(ride.final_fare_cup)}</Field>
          <Field label={t('panel_view.ride_payment', { defaultValue: 'Pago' })}>{ride.payment_method}</Field>
          <Field label={t('panel_view.ride_distance', { defaultValue: 'Distancia (estimada / real)' })}>{km(ride.estimated_distance_m)} / {km(ride.actual_distance_m)}</Field>
          <Field label={t('panel_view.ride_duration', { defaultValue: 'Duración (estimada / real)' })}>{min(ride.estimated_duration_s)} / {min(ride.actual_duration_s)}</Field>
          <Field label={t('panel_view.ride_dispatch_round', { defaultValue: 'Ronda de despacho' })}>{ride.dispatch_round}</Field>
          <Field label={t('panel_view.ride_wait', { defaultValue: 'Espera' })}>{min(ride.wait_time_seconds)}</Field>
          {ride.status === 'canceled' && (
            <Field label={t('panel_view.ride_canceled', { defaultValue: 'Cancelación' })}>
              {rideCancelSummary(t, ride.canceled_by_role, ride.cancellation_reason)}
            </Field>
          )}
        </dl>
      </SectionCard>

      <SectionCard title={t('panel_view.ride_people', { defaultValue: 'Pasajero y conductor' })}>
        <dl className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2">
          <Field label={t('panel_view.ride_customer', { defaultValue: 'Pasajero' })}>
            {customerInfo ? (
              <Link href={`/users/${ride.customer_id}`} className="text-primary-700 hover:underline dark:text-primary-400">
                {customerInfo.name || '—'}
              </Link>
            ) : '—'}
            {customerInfo?.phone ? <span className="block text-ink-muted">{customerInfo.phone}</span> : null}
          </Field>
          <Field label={t('panel_view.ride_driver', { defaultValue: 'Conductor' })}>
            {driverInfo ? (
              <Link href={`/drivers/${driverInfo.id}`} className="text-primary-700 hover:underline dark:text-primary-400">
                {driverInfo.name || '—'}
              </Link>
            ) : t('panel_view.ride_no_driver', { defaultValue: 'Sin conductor' })}
            {driverInfo?.phone ? <span className="block text-ink-muted">{driverInfo.phone}</span> : null}
          </Field>
        </dl>
      </SectionCard>

      <SectionCard title={t('panel_view.ride_timeline', { defaultValue: 'Cronología' })}>
        {transitions.length === 0 ? (
          <p className="px-5 pb-5 text-[13px] text-ink-muted">{t('panel_view.ride_no_timeline', { defaultValue: 'Sin cambios de estado registrados.' })}</p>
        ) : (
          <ol className="flex flex-col gap-2 px-5 pb-5">
            {transitions.map((tr) => (
              <li key={tr.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="w-40 shrink-0 text-ink-muted">{formatAdminDate(tr.created_at)}</span>
                <StatusBadge domain="ride" status={tr.to_status} />
                {tr.reason ? <span className="text-ink-muted">{tr.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      {pricing && (
        <SectionCard title={t('panel_view.ride_pricing', { defaultValue: 'Desglose de tarifa' })}>
          <dl className="grid grid-cols-2 gap-4 px-5 pb-5 sm:grid-cols-4">
            <Field label={t('panel_view.pricing_base', { defaultValue: 'Base' })}>{formatCUP(pricing.base_fare ?? 0)}</Field>
            <Field label={t('panel_view.pricing_per_km', { defaultValue: 'Por km' })}>{formatCUP(pricing.per_km_rate ?? 0)}</Field>
            <Field label={t('panel_view.pricing_per_min', { defaultValue: 'Por minuto' })}>{formatCUP(pricing.per_minute_rate ?? 0)}</Field>
            <Field label={t('panel_view.pricing_total', { defaultValue: 'Total' })}>{formatCUP(pricing.total ?? 0)}</Field>
          </dl>
        </SectionCard>
      )}
    </div>
  );
}
```

Check `RidePricingSnapshot` (`packages/types/src/ride.ts:306`) and `RideTransition` (`:282`) for the field names used here (`base_fare`, `per_km_rate`, `per_minute_rate`, `total`, `to_status`, `reason`); use the names the types have.

- [ ] **Step 2: `DriverDetailReadOnly`**

`apps/admin/src/components/panel/DriverDetailReadOnly.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelReadService, type PanelDriverDetail } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { StatusBadge } from '@/components/data/StatusBadge';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { Field } from './RideDetailReadOnly';

/** A driver as marketing sees it (00663): no wallet, files, selfies, contract, identity or actions. */
export function DriverDetailReadOnly({ driverId }: { driverId: string }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<PanelDriverDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await panelReadService.getDriverDetail(driverId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [driverId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <AdminErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return <AdminTableSkeleton rows={6} columns={2} />;

  const { profile: p, documents, scoreEvents, churn } = data;
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * (v <= 1 ? 100 : 1))} %`);
  const vehicle = [p.vehicle_type, p.vehicle_make, p.vehicle_model, p.vehicle_color, p.vehicle_year]
    .filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-ink">{p.full_name || '—'}</h1>
        <StatusBadge domain="driver" status={p.status} size="md" />
        {p.phone ? <span className="text-[12.5px] text-ink-muted">{p.phone}</span> : null}
      </header>

      <SectionCard title={t('panel_view.driver_profile', { defaultValue: 'Perfil' })}>
        <dl className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('panel_view.driver_signed_up', { defaultValue: 'Alta' })}>{formatAdminDate(p.created_at)}</Field>
          <Field label={t('panel_view.driver_approved', { defaultValue: 'Aprobado' })}>{formatAdminDate(p.approved_at)}</Field>
          <Field label={t('panel_view.driver_last_seen', { defaultValue: 'Última vez en línea' })}>{formatAdminDate(p.last_heartbeat_at)}</Field>
          <Field label={t('panel_view.driver_rating', { defaultValue: 'Calificación' })}>{p.rating_avg == null ? '—' : Number(p.rating_avg).toFixed(2)}</Field>
          <Field label={t('panel_view.driver_rides', { defaultValue: 'Viajes completados' })}>{p.total_rides_completed}</Field>
          <Field label={t('panel_view.driver_acceptance', { defaultValue: 'Tasa de aceptación' })}>{pct(p.acceptance_rate)}</Field>
          <Field label={t('panel_view.driver_area', { defaultValue: 'Municipio' })}>{[p.municipality, p.province].filter(Boolean).join(', ') || '—'}</Field>
          <Field label={t('panel_view.driver_vehicle', { defaultValue: 'Vehículo' })}>{vehicle || '—'}</Field>
          <Field label={t('panel_view.driver_plate', { defaultValue: 'Chapa' })}>{p.plate_number ?? '—'}</Field>
          {p.suspended_at && (
            <Field label={t('panel_view.driver_suspended', { defaultValue: 'Suspendido' })}>
              {formatAdminDate(p.suspended_at)}{p.suspended_reason ? ` · ${p.suspended_reason}` : ''}
            </Field>
          )}
          {churn && (
            <Field label={t('panel_view.driver_churn', { defaultValue: 'Riesgo de abandono' })}>
              {churn.risk_level ?? '—'}
              {churn.days_since_last_ride != null
                ? ` · ${t('panel_view.driver_days_since', { defaultValue: '{{days}} días sin viajes', days: churn.days_since_last_ride })}`
                : ''}
            </Field>
          )}
        </dl>
      </SectionCard>

      <SectionCard
        title={t('panel_view.driver_documents', { defaultValue: 'Documentos' })}
        description={t('panel_view.driver_documents_hint', { defaultValue: 'Qué subió y si está aprobado. Los archivos solo los abre un administrador.' })}
      >
        {documents.length === 0 ? (
          <p className="px-5 pb-5 text-[13px] text-ink-muted">{t('panel_view.driver_no_documents', { defaultValue: 'No subió documentos.' })}</p>
        ) : (
          <ul className="flex flex-col gap-2 px-5 pb-5">
            {documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span className="text-ink">{d.document_type}</span>
                <span className="text-ink-muted">
                  {d.is_verified
                    ? t('panel_view.doc_approved', { defaultValue: 'Aprobado' })
                    : d.rejection_reason
                      ? `${t('panel_view.doc_rejected', { defaultValue: 'Rechazado' })} · ${d.rejection_reason}`
                      : t('panel_view.doc_pending', { defaultValue: 'Pendiente' })}
                  {' · '}{formatAdminDate(d.uploaded_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {scoreEvents.length > 0 && (
        <SectionCard title={t('panel_view.driver_score_events', { defaultValue: 'Eventos de puntaje' })}>
          <ul className="flex flex-col gap-1.5 px-5 pb-5">
            {scoreEvents.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-2 text-[13px]">
                <span className="w-40 shrink-0 text-ink-muted">{formatAdminDate(e.created_at)}</span>
                <span className="text-ink">{e.event_type}</span>
                <span className="text-ink-muted">{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
```

Check `DriverScoreEvent`'s fields in `packages/types/src/driver.ts:83` (`event_type`, `delta`, `created_at`); use its names if they differ.

- [ ] **Step 3: `UserDetailReadOnly`**

`apps/admin/src/components/panel/UserDetailReadOnly.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelReadService, type PanelUserDetail } from '@tricigo/api';
import { formatCUP, getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';
import { Field } from './RideDetailReadOnly';

/** A user as marketing sees it (00663): no wallet, transfers, penalties or actions. */
export function UserDetailReadOnly({ userId }: { userId: string }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<PanelUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await panelReadService.getUserDetail(userId));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <AdminErrorBanner message={error} onRetry={() => void load()} />;
  if (!data) return <AdminTableSkeleton rows={5} columns={2} />;

  const { user: u } = data;
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-ink">{u.full_name || '—'}</h1>
        <span className="text-[12.5px] text-ink-muted">{u.role}</span>
      </header>
      <SectionCard title={t('panel_view.user_profile', { defaultValue: 'Datos' })}>
        <dl className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('panel_view.user_phone', { defaultValue: 'Teléfono' })}>{u.phone ?? '—'}</Field>
          <Field label={t('panel_view.user_email', { defaultValue: 'Correo' })}>{u.email ?? '—'}</Field>
          <Field label={t('panel_view.user_signed_up', { defaultValue: 'Alta' })}>{formatAdminDate(u.created_at)}</Field>
          <Field label={t('panel_view.user_level', { defaultValue: 'Nivel' })}>{u.level ?? '—'}</Field>
          <Field label={t('panel_view.user_active', { defaultValue: 'Cuenta activa' })}>
            {u.is_active ? t('panel_view.yes', { defaultValue: 'Sí' }) : t('panel_view.no', { defaultValue: 'No' })}
          </Field>
        </dl>
      </SectionCard>
      <SectionCard title={t('panel_view.user_rides', { defaultValue: 'Viajes como pasajero' })}>
        <dl className="grid grid-cols-2 gap-4 px-5 pb-5 sm:grid-cols-4">
          <Field label={t('panel_view.user_rides_total', { defaultValue: 'Pedidos' })}>{data.ridesAsCustomer}</Field>
          <Field label={t('panel_view.user_rides_completed', { defaultValue: 'Completados' })}>{data.completedAsCustomer}</Field>
          <Field label={t('panel_view.user_rides_canceled', { defaultValue: 'Cancelados' })}>{data.canceledAsCustomer}</Field>
          <Field label={t('panel_view.user_spent', { defaultValue: 'Gastado en viajes' })}>{formatCUP(data.totalSpentCup)}</Field>
        </dl>
      </SectionCard>
    </div>
  );
}
```

If `User` has no `level` or `is_active` in `packages/types/src/user.ts`, drop that field.

- [ ] **Step 4: Role switch in the three pages**

In each of `rides/[id]/page.tsx`, `drivers/[id]/page.tsx`, `users/[id]/page.tsx`:
1. Rename the existing default export: `export default function RideDetailPage()` → `function AdminRideDetailPage()` (and `DriverDetailPage` → `AdminDriverDetailPage`, `UserDetailPage` → `AdminUserDetailPage`).
2. Add at the end of the file (example for rides; use `DriverDetailReadOnly driverId={id}` and `UserDetailReadOnly userId={id}` in the other two):

```tsx
export default function RideDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { canAct, ready } = useCanAct();
  if (!ready) return null;
  return canAct ? <AdminRideDetailPage /> : <RideDetailReadOnly rideId={id} />;
}
```

3. Add the imports: `import { useCanAct } from '@/lib/useCanAct';` and `import { RideDetailReadOnly } from '@/components/panel/RideDetailReadOnly';` (or the driver/user component).

The admin component keeps every hook, so the hook order never changes: the role decides which component mounts.

- [ ] **Step 5: Type check**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/panel apps/admin/src/app/rides/[id]/page.tsx apps/admin/src/app/drivers/[id]/page.tsx apps/admin/src/app/users/[id]/page.tsx
git commit -m "feat(admin): read-only ride, driver and user detail for marketing"
```

---

## Task 10: Hide actions on the other opened pages

**Files:**
- Modify: `apps/admin/src/app/reviews/page.tsx`, `disputes/page.tsx`, `incidents/page.tsx`, `incidents/[id]/page.tsx`, `lost-found/page.tsx`, `incomplete-drivers/page.tsx`, `pois/page.tsx`, `pois/submissions/page.tsx`

In every file: `import { useCanAct } from '@/lib/useCanAct';` and, at the top of the page component, `const { canAct, ready } = useCanAct();`. Support needs no change: marketing may reply and change status there, and its page has no other action.

- [ ] **Step 1: Reseñas**

`reviews/page.tsx:458`: `rowActions={[…]}` → `rowActions={canAct ? [ …the same array… ] : undefined}`.

- [ ] **Step 2: Disputas**

`disputes/page.tsx`:
- State types: `useState<RideDispute[]>` → `useState<PanelDispute[]>` and `useState<RideDispute | null>` → `useState<PanelDispute | null>`; `handleSelect = (d: RideDispute)` → `(d: PanelDispute)`; `const updated: RideDispute = {` → `const updated: PanelDispute = {`. Import `panelReadService, type PanelDispute` from `@tricigo/api`.
- The fetch (line ~113): read by role, and only once the role is known:

```ts
const data = canAct
  ? await disputeService.getAllDisputes({ status: …same args…, limit: …same… })
  : await panelReadService.getDisputes({ status: …same…, limit: …same… });
```

Add `ready` to the fetch effect's guard (`if (!ready) return;` first line of the effect) and `canAct, ready` to its dependencies.
- `const canResolve =` (line 314): prefix the condition with `canAct &&` (it gates "Asignarme" and the resolve form).
- Evidence (lines ~428, ~454): `selected.evidence_urls.length > 0` → `(selected.evidence_urls?.length ?? 0) > 0` and `selected.evidence_urls.map(` → `(selected.evidence_urls ?? []).map(`; the same for `respondent_evidence_urls`.
- Internal notes section (lines ~597–618): wrap the whole `<section className="px-5 py-4"> … Notas internas … </section>` in `{canAct && ( … )}`.
- `handleSelect`: `setAdminNotes(d.admin_notes ?? '')` stays (undefined becomes '').

- [ ] **Step 3: Incidentes (list)**

`incidents/page.tsx`:
- The fetch (line ~80): `const data = canAct ? await adminService.getIncidents(…same args…) : await panelReadService.getIncidents(…same args…);` with the `ready` guard and dependencies as above.
- `rowActions={[ … ]}` (line ~222) → `rowActions={canAct ? [ …the same array… ] : undefined}`.

- [ ] **Step 4: Incidente (detail)**

`incidents/[id]/page.tsx`:
- In its local incident type (line ~36), make `evidence_urls` optional (`evidence_urls?: string[];`), and `resolution_notes` too if the type has it; render `resolution_notes` only when present.
- The load (line ~72): `const data = canAct ? await adminService.getIncidentDetail(id) : await panelReadService.getIncidentDetail(id);` with the `ready` guard.
- Wrap the action buttons in `{canAct && ( … )}`: the `{/* Actions */}` `<div className="flex gap-2">` block (line ~196) and the review moderation block `{incident.status !== 'resolved' && incident.status !== 'dismissed' && ( <div className="flex gap-2"> … hideReview … )}` (line ~244).
- Evidence (line ~315): `incident.evidence_urls.length > 0` → `(incident.evidence_urls?.length ?? 0) > 0`, and `.map(` on `(incident.evidence_urls ?? [])`.

- [ ] **Step 5: Objetos perdidos**

`lost-found/page.tsx`: the detail panel component takes `onSaveNotes`/`onClose` (line ~267). Add a prop `readOnly: boolean` to it, pass `readOnly={!canAct}`, and inside the component wrap the "Notas internas" title, textarea and the buttons row (lines ~418–445) in `{!readOnly && ( … )}`.

- [ ] **Step 6: Registros incompletos**

`incomplete-drivers/page.tsx:657-664`: wrap the "Marcar contactado" `<button … onClick={() => setContactRow(r)} …>` in `{canAct && ( … )}`. The WhatsApp link and "Copiar mensaje" stay: they do not write anything.

- [ ] **Step 7: Lugares**

`pois/page.tsx`: wrap in `{canAct && ( … )}` the row buttons at lines ~251 (edit), ~258 (deactivate), ~266 (activate), ~275 (unlock), the "create" button at line ~307, and the edit form/modal and both `AdminConfirmModal`s (lines ~400–560; they only open from those buttons, so hiding the buttons is enough, but keep the modals unmounted for marketing too).

`pois/submissions/page.tsx:216-232`: wrap the approve and reject buttons in `{canAct && ( … )}`.

- [ ] **Step 8: Type check and lint**

Run: `cd apps/admin && npx tsc --noEmit && npx eslint --config ../../tools/lint-rules.config.mjs src/app/reviews/page.tsx src/app/disputes/page.tsx src/app/incidents/page.tsx 'src/app/incidents/[id]/page.tsx' src/app/lost-found/page.tsx src/app/incomplete-drivers/page.tsx src/app/pois/page.tsx src/app/pois/submissions/page.tsx src/lib/useCanAct.ts src/lib/rideCancel.ts src/components/panel`
Expected: no errors (warnings that existed before the change are fine; compare with `git stash`).

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/app
git commit -m "feat(admin): marketing sees reviews, disputes, incidents, lost items, sign-ups and places read-only"
```

---

## Task 11: "Fallas del producto" in Reportes

**Files:**
- Create: `apps/admin/src/components/panel/ProductFailuresSection.tsx`
- Modify: `apps/admin/src/app/reports/page.tsx` (after the Wallet section, before the closing `</>` near line 706)

- [ ] **Step 1: The section**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { panelReadService, type ProductFailures } from '@tricigo/api';
import { getErrorMessage } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { AdminErrorBanner } from '@/components/ui/AdminErrorBanner';
import { AdminTableSkeleton } from '@/components/ui/AdminTableSkeleton';
import { formatAdminDate } from '@/lib/formatDate';

const PERIODS = [7, 30, 90] as const;

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : '—';
}

/** Places that do not exist, push reach, app versions and failed payments (00663). */
export function ProductFailuresSection() {
  const { t } = useTranslation('admin');
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [data, setData] = useState<ProductFailures | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    try {
      setData(await panelReadService.getProductFailures(days));
    } catch (e) {
      setError(getErrorMessage(e));
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = (text: string) => <p className="px-5 pb-5 text-[13px] text-ink-muted">{text}</p>;

  return (
    <section className="mb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-ink">{t('product_failures.title', { defaultValue: 'Fallas del producto' })}</h2>
        <div className="flex gap-1" role="group" aria-label={t('product_failures.period', { defaultValue: 'Período' })}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setDays(p)}
              aria-pressed={days === p}
              className={`rounded-full px-3 py-1 text-[12px] font-medium ${days === p ? 'bg-ink text-surface' : 'border border-line bg-surface text-ink hover:bg-surface-sunken'}`}
            >
              {t('product_failures.days', { defaultValue: '{{days}} días', days: p })}
            </button>
          ))}
        </div>
      </div>

      {error ? <AdminErrorBanner message={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <AdminTableSkeleton rows={4} columns={2} /> : null}

      {data && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SectionCard
            title={t('product_failures.places_title', { defaultValue: 'Lugares que la gente buscó y no existen' })}
            description={t('product_failures.places_hint', { defaultValue: 'Lo que escribieron al pedir un viaje y la app no encontró.' })}
          >
            {data.placesNotFound.length === 0 ? empty(t('product_failures.places_empty', { defaultValue: 'Nadie buscó un lugar que no exista en este período.' })) : (
              <ul className="flex flex-col gap-1.5 px-5 pb-5">
                {data.placesNotFound.map((p) => (
                  <li key={p.name} className="flex justify-between gap-3 text-[13px]">
                    <span className="text-ink">{p.name}</span>
                    <span className="shrink-0 text-ink-muted">
                      {t('product_failures.searches', { defaultValue: '{{count}} búsquedas', count: p.searches })} · {formatAdminDate(p.lastSeen)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title={t('product_failures.push_title', { defaultValue: 'A quién le llegan las notificaciones' })}
            description={t('product_failures.push_hint', { defaultValue: 'Personas activas en el período con un celular que puede recibirlas.' })}
          >
            <dl className="grid grid-cols-2 gap-4 px-5 pb-3 text-[13px]">
              <div>
                <dt className="text-ink-muted">{t('product_failures.push_riders', { defaultValue: 'Pasajeros' })}</dt>
                <dd className="text-xl font-bold text-ink">{share(data.pushReach.ridersReachable, data.pushReach.ridersActive)}</dd>
                <dd className="text-ink-muted">{data.pushReach.ridersReachable} / {data.pushReach.ridersActive}</dd>
              </div>
              <div>
                <dt className="text-ink-muted">{t('product_failures.push_drivers', { defaultValue: 'Conductores' })}</dt>
                <dd className="text-xl font-bold text-ink">{share(data.pushReach.driversReachable, data.pushReach.driversActive)}</dd>
                <dd className="text-ink-muted">{data.pushReach.driversReachable} / {data.pushReach.driversActive}</dd>
              </div>
            </dl>
            {data.pushOutcomes.length > 0 && (
              <ul className="flex flex-col gap-1 px-5 pb-5 text-[12.5px] text-ink-muted">
                {data.pushOutcomes.map((o) => (
                  <li key={`${o.app}-${o.outcome}`}>
                    {o.app === 'driver' ? t('product_failures.app_driver', { defaultValue: 'Conductor' }) : t('product_failures.app_client', { defaultValue: 'Pasajero' })}
                    {' · '}
                    {t(`product_failures.outcome_${o.outcome}`, { defaultValue: o.outcome })}: {o.users}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={t('product_failures.versions_title', { defaultValue: 'Versiones de la app en uso' })}>
            {data.appVersions.length === 0 ? empty(t('product_failures.versions_empty', { defaultValue: 'Se llena cuando salga la versión de la app que reporta aperturas.' })) : (
              <ul className="flex flex-col gap-1.5 px-5 pb-5">
                {data.appVersions.map((v) => (
                  <li key={`${v.app}-${v.version}-${v.platform}`} className="flex justify-between gap-3 text-[13px]">
                    <span className="text-ink">
                      {v.app === 'driver' ? t('product_failures.app_driver', { defaultValue: 'Conductor' }) : t('product_failures.app_client', { defaultValue: 'Pasajero' })} {v.version ?? '—'} · {v.platform ?? '—'}
                    </span>
                    <span className="text-ink-muted">{t('product_failures.installs', { defaultValue: '{{count}} instalaciones', count: v.installs })}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={t('product_failures.payments_title', { defaultValue: 'Pagos que fallaron' })}>
            {data.failedPayments.length === 0 ? empty(t('product_failures.payments_empty', { defaultValue: 'No falló ningún pago en este período.' })) : (
              <ul className="flex flex-col gap-1.5 px-5 pb-5">
                {data.failedPayments.map((p) => (
                  <li key={p.reason} className="flex justify-between gap-3 text-[13px]">
                    <span className="text-ink">{p.reason}</span>
                    <span className="shrink-0 text-ink-muted">{t('product_failures.payments_count', { defaultValue: '{{count}} pagos', count: p.payments })}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount it in Reportes**

In `reports/page.tsx`, import `import { ProductFailuresSection } from '@/components/panel/ProductFailuresSection';` and add `<ProductFailuresSection />` right after the closing `</section>` of the Wallet section (the one with `t('reports.section_finance')`), before `</>`.

- [ ] **Step 3: Type check**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/src/components/panel/ProductFailuresSection.tsx apps/admin/src/app/reports/page.tsx
git commit -m "feat(admin): Fallas del producto section in Reportes"
```

---

## Task 12: Texts and docs

**Files:**
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Collect every new key**

Run: `cd apps/admin/src && grep -rhoE "t\('(panel_view|product_failures)\.[a-z_]+'" components/panel lib/rideCancel.ts app | sort -u`
Add each key to the three `admin.json` files, under two new top-level objects `panel_view` and `product_failures`. Spanish uses the `defaultValue` from the code (tuteo, no voseo); English and Portuguese translate it. Keep the `{{days}}`, `{{count}}` placeholders. The `outcome_*` keys: `outcome_registered` "Registrado", `outcome_denied` "Rechazó el permiso", `outcome_blocked` "Bloqueado en ajustes", `outcome_never_asked` "Nunca se le preguntó", `outcome_error` "Error al registrar".

- [ ] **Step 2: Check the JSON and the tuteo guard**

Run: `node -e "for (const l of ['es','en','pt']) JSON.parse(require('fs').readFileSync('packages/i18n/src/locales/'+l+'/admin.json','utf8'))" && cd packages/utils && npx vitest run src/__tests__/copyTuteo.test.ts`
Expected: no output from node; the tuteo test PASS.

- [ ] **Step 3: CLAUDE.md**

Under § "Rol `marketing` en el panel admin (00641/00642, PR #1115)", add a subsection:

```markdown
#### Lo que marketing lee desde 00663

Desde la 00663 marketing también abre en solo lectura Viajes, Conductores, Usuarios, Reseñas, Soporte, Disputas, Incidentes, Objetos perdidos, Registros incompletos, Lugares y Validación, y ve "Fallas del producto" en Reportes. Diseño: `docs/superpowers/specs/2026-10-15-marketing-visibility-design.md`. Ensayo: `supabase/tests/00663/run.sh`.

- **Lo único que escribe es Soporte:** responde (el trigger marca su mensaje como de soporte, salvo en un ticket propio) y cambia el estado del ticket. `tg_support_tickets_client_update_guard` rechaza cualquier otra columna (DETAIL `ticket_column_staff_only`) y pone las fechas.
- **Lo sensible se lee por vistas:** `panel_rides` y `panel_driver_profiles` crecieron; `panel_driver_documents`, `panel_driver_churn_risk`, `panel_ride_disputes` y `panel_incident_reports` son nuevas. Ninguna vista `panel_*` puede tener una columna de la lista oculta de la 00663 (coordenadas, `share_token`, identidad, dirección, antecedentes, archivos, evidencias, reembolsos, notas internas, ganancias, notas al conductor, reparto del pago): el bloque final de la migración falla si aparece. **Una columna nueva en una vista del panel se agrega al final** (`CREATE OR REPLACE VIEW` no deja reordenar) y no puede estar en esa lista.
- **El vehículo va por `panel_driver_profiles`**, nunca por una política en `vehicles` (00644).
- **Las listas de Viajes y Conductores leen las vistas también para admin.** Los detalles de viaje, conductor y usuario montan para marketing un componente de solo lectura (`components/panel/*ReadOnly.tsx`); el de admin no cambia.
- **Una página que se abre a marketing:** sumarla a `MARKETING_ROUTES`, esconder sus acciones con `useCanAct()` y leer solo vistas o tablas con política `*_marketing`. `/rides/[id]/assist` queda cerrada por `MARKETING_DENIED`.
```

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/src/locales CLAUDE.md
git commit -m "docs: texts and rules for the wider marketing view"
```

---

## Task 13: Full verification and push

- [ ] **Step 1: Re-check the migration number** (command at the top of this plan). If 00663 is taken, `git mv` the migration and the test folder to the next free number, update every `00663` inside them (`grep -rl 00663 supabase docs CLAUDE.md apps packages`), and re-run the rehearsal.

- [ ] **Step 2: Rehearsal, RED and GREEN**

Run: `bash supabase/tests/00663/run.sh none; bash supabase/tests/00663/run.sh supabase/migrations/00663_marketing_wider_view.sql`
Expected: the first ends with failures (exit 1); the second ends `N passed, 0 failed` (exit 0).

- [ ] **Step 3: Repo checks**

Run, from the repo root:

```bash
pnpm check-types
pnpm --filter @tricigo/utils test
pnpm --filter @tricigo/api test
pnpm check:migration-grants
```

Expected: all pass. `check:migration-grants` checks that every new view has a GRANT that includes `service_role`; 00663 grants each view explicitly for that reason.

- [ ] **Step 4: Browser check as marketing** (local build against a mock or the rehearsal is not possible for the UI; use a real marketing account only with the owner's OK). Without an account, check the build: `cd apps/admin && npx next build` must list the routes and `ƒ Middleware`.

- [ ] **Step 5: Adversarial re-read of the diff**

`git diff origin/master...HEAD -- apps packages supabase` and check: no admin action reachable from a read-only component; no service method marketing calls that reads `rides`, `driver_profiles`, `vehicles`, `driver_documents`, `ride_disputes` or `incident_reports` directly; every `t(` with Spanish copy uses tuteo.

- [ ] **Step 6: Push and update the PR**

```bash
git push -u origin claude/hopeful-shannon-g3theu
```

Update PR #1163's body: what changed, the rehearsal result, the checks, and the rollout list of Task 14.

---

## Task 14: Rollout (each step needs the owner's OK)

- [ ] **Step 1: Rehearse 00663 in prod inside a rolled-back block**

Through `execute_sql`, run the migration text inside `DO $probe$ BEGIN EXECUTE $mig$<file>$mig$; … RAISE EXCEPTION 'PROBE %', <results>; END $probe$;` with, as Mara-like checks, a real marketing account if one exists (`SELECT id FROM users WHERE role = 'marketing'`), else as an admin: read each new view, call `get_product_failures(30)`, insert a support reply in a test ticket. The final `RAISE` rolls everything back. Confirm by object afterwards that nothing stayed (`to_regclass('public.panel_driver_documents')` is null, md5 of the seven functions are the old ones).

- [ ] **Step 2: Apply 00663 by MCP** (ask the owner with AskUserQuestion first; the file has no DROP or DELETE). Verify by object: the seven md5s are the new ones, the four new views exist with their grants, the ten policies exist, `get_product_failures` answers an admin.

- [ ] **Step 3: Merge PR #1163** after the owner's explicit OK ("¿Autorizo el squash-merge de #1163?"). The merge deploys the panel.

- [ ] **Step 4: Owner test with a marketing account**: open each new page, check no action button shows (except Soporte), answer a test ticket, open Reportes → Fallas del producto.
