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
         AND (t.user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')))));
CREATE POLICY "Ticket participants insert messages" ON public.ticket_messages FOR INSERT
  WITH CHECK (sender_id = auth.uid() AND EXISTS (SELECT 1 FROM public.support_tickets t WHERE t.id = ticket_messages.ticket_id
         AND (t.user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')))));
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
