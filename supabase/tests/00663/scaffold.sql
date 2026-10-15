-- Scaffold for the 00663 rehearsal (marketing reads more of the admin panel).
-- Runs after supabase/tests/00642/scaffold.sql + 00641 + 00642 (prod's marketing role) and adds
-- what 00663 touches, reduced to the columns the code under test reads, with prod's policies as
-- of 2026-10-15. Coordinates are text stand-ins (no PostGIS): no test reads them, and the views
-- must leave them out by name. The two POI functions read them through stubs of geometry,
-- ST_X, ST_Y and unaccent below; get_product_failures reads each ride's venue through prod's
-- _poi_leading_venue_name (00584), copied below.
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
  -- wait_time_seconds and wait_charge_cup are dead in prod (0 of 246 rides use them); the app
  -- fills wait_time_minutes and wait_time_charge_cup.
  ADD COLUMN IF NOT EXISTS wait_time_seconds integer,
  ADD COLUMN IF NOT EXISTS wait_charge_cup numeric,
  ADD COLUMN IF NOT EXISTS wait_time_minutes integer,
  ADD COLUMN IF NOT EXISTS wait_time_charge_cup integer,
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
  ADD COLUMN IF NOT EXISTS wallet_ratio numeric,
  ADD COLUMN IF NOT EXISTS payment_intent_id uuid;

-- The commission driver_churn_risk subtracts from the earnings it hides.
ALTER TABLE public.ride_pricing_snapshots ADD COLUMN IF NOT EXISTS commission_amount integer;

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
-- Prod's columns, in prod's order (2026-10-15).
CREATE TABLE public.lost_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid, reporter_id uuid NOT NULL, driver_id uuid,
  description text, category text, photo_urls text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'reported',
  driver_response text, driver_found boolean, return_fee_cup integer,
  return_location text, return_notes text, admin_notes text,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
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

-- driver_churn_risk as prod has it (00286): security_invoker, so the RLS of driver_profiles,
-- users and rides applies to whoever reads it. The risk score and level are prod's expressions,
-- written once here instead of three times.
CREATE VIEW public.driver_churn_risk WITH (security_invoker = true) AS
SELECT c.driver_profile_id, c.user_id, c.full_name, c.rating_avg, c.total_rides_completed,
       c.acceptance_rate, c.is_online, c.status, c.days_since_last_ride,
       c.earnings_this_week, c.earnings_last_week, c.churn_risk_score,
       CASE WHEN c.churn_risk_score >= 50 THEN 'high'
            WHEN LEAST(100, GREATEST(0, c.days_points + c.rating_points)) >= 25 THEN 'medium'
            ELSE 'low' END AS risk_level
FROM (
  SELECT b.*, LEAST(100, GREATEST(0, b.days_points + b.rating_points + b.acceptance_points)) AS churn_risk_score
  FROM (
    SELECT dp.id AS driver_profile_id, dp.user_id, u.full_name, dp.rating_avg, dp.total_rides_completed,
           dp.acceptance_rate, dp.is_online, dp.status,
           COALESCE(EXTRACT(days FROM (now() - (SELECT max(r.completed_at) FROM public.rides r
             WHERE r.driver_id = dp.id AND r.status = 'completed'))), 999)::integer AS days_since_last_ride,
           COALESCE((SELECT sum(r.final_fare_cup - COALESCE(rps.commission_amount, round(r.final_fare_cup * 0.15)::integer)
                                + COALESCE(r.tip_amount, 0))
                     FROM public.rides r
                     LEFT JOIN public.ride_pricing_snapshots rps ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
                     WHERE r.driver_id = dp.id AND r.status = 'completed'
                       AND r.completed_at > now() - interval '7 days'), 0)::integer AS earnings_this_week,
           COALESCE((SELECT sum(r.final_fare_cup - COALESCE(rps.commission_amount, round(r.final_fare_cup * 0.15)::integer)
                                + COALESCE(r.tip_amount, 0))
                     FROM public.rides r
                     LEFT JOIN public.ride_pricing_snapshots rps ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
                     WHERE r.driver_id = dp.id AND r.status = 'completed'
                       AND r.completed_at >= now() - interval '14 days'
                       AND r.completed_at <= now() - interval '7 days'), 0)::integer AS earnings_last_week,
           LEAST(40, COALESCE(EXTRACT(days FROM (now() - (SELECT max(r.completed_at) FROM public.rides r
             WHERE r.driver_id = dp.id AND r.status = 'completed'))), 30)::integer * 2) AS days_points,
           CASE WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20 WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10 ELSE 0 END AS rating_points,
           CASE WHEN COALESCE(dp.acceptance_rate, 100) < 50 THEN 20 WHEN COALESCE(dp.acceptance_rate, 100) < 70 THEN 10 ELSE 0 END AS acceptance_points
    FROM public.driver_profiles dp
    LEFT JOIN public.users u ON u.id = dp.user_id
    WHERE dp.status = 'approved'
  ) b
) c;

-- The PostGIS and unaccent pieces the live admin_list_pois and list_poi_submissions call: a
-- geometry that is the text of the point, and an unaccent that changes nothing. In prod
-- unaccent(text) lives in public too (measured 2026-10-15). An identity is enough here: every
-- place name the tests seed is ASCII, so no match depends on removing an accent.
CREATE DOMAIN public.geometry AS text;
CREATE FUNCTION public.st_x(public.geometry) RETURNS double precision LANGUAGE sql IMMUTABLE AS $f$
  SELECT split_part(btrim(split_part($1, '(', 2), ')'), ' ', 1)::double precision
$f$;
CREATE FUNCTION public.st_y(public.geometry) RETURNS double precision LANGUAGE sql IMMUTABLE AS $f$
  SELECT split_part(btrim(split_part($1, '(', 2), ')'), ' ', 2)::double precision
$f$;
CREATE FUNCTION public.unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT $1 $f$;

-- What get_product_failures calls to read a ride's venue: _ride_address_is_placeholder (00546) and
-- _poi_leading_venue_name (00584), copied from those migrations, over a cuba_admin_areas without
-- its polygons and with two of prod's names (without accents: unaccent is an identity here).
CREATE TABLE public.cuba_admin_areas (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, admin_level integer NOT NULL,
  name text NOT NULL, name_es text
);
ALTER TABLE public.cuba_admin_areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY cuba_admin_areas_read ON public.cuba_admin_areas FOR SELECT USING (true);
INSERT INTO public.cuba_admin_areas (admin_level, name, name_es)
  VALUES (4, 'La Habana', 'La Habana'), (6, 'Plaza de la Revolucion', NULL);

CREATE FUNCTION public._ride_address_is_placeholder(p_addr text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    p_addr IS NULL
    OR btrim(p_addr) = ''
    -- coordenadas crudas tipo "23.12638, -82.35472"
    OR p_addr ~ '^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$'
    -- fallback viejo del picker de mapa
    OR p_addr = 'Ubicación seleccionada en el mapa'
    -- fallback del cliente por preset local (el servidor lo mejora si puede)
    OR p_addr LIKE 'Cerca de %'
    -- 00546: textos provisionales de la UI (es / en / pt)
    OR btrim(p_addr) IN (
         'Detectando dirección...',
         'Detecting address...',
         'Detectando endereço...',
         'Origen',
         'Destino',
         'Mi ubicación'
       );
$function$;
REVOKE ALL ON FUNCTION public._ride_address_is_placeholder(text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public._poi_leading_venue_name(p_addr text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
  -- The venue part of a ride address: "Coppelia, Calle 23 e/ L y K, Plaza, La Habana" → "Coppelia".
  -- NULL for placeholders, corner / street forms, zone names, numeric or too-short text.
  SELECT CASE
    WHEN public._ride_address_is_placeholder(p_addr) THEN NULL
    WHEN v.lead IS NULL OR length(v.lead) < 3 OR length(v.lead) > 80 THEN NULL
    WHEN v.lead !~ '[[:alpha:]].*[[:alpha:]]' THEN NULL
    WHEN v.lead ~* '(^|\s)(e/|entre|esq\.?|esquina|y)(\s|$)' THEN NULL
    WHEN v.lead ~* '^(calle|calzada|avenida|ave\.?|av\.?|avda\.?|carretera|camino|callejon|callejón|paseo|linea|línea|km|kilometro|kilómetro|autopista|circunvalacion|circunvalación|reparto|rpto\.?|edificio|edif\.?|apto\.?|apartamento|cerca de)(\s|$)' THEN NULL
    WHEN v.lead ~ '^\d' THEN NULL
    WHEN lower(unaccent(v.lead)) IN (
      'vedado', 'el vedado', 'nuevo vedado', 'miramar', 'centro habana', 'habana vieja', 'la habana vieja', 'cerro',
      'playa', 'marianao', 'la lisa', 'boyeros', 'alamar', 'cojimar', 'santos suarez', 'lawton', 'luyano',
      'la vibora', 'vibora', 'siboney', 'kohly', 'casino deportivo', 'santa fe', 'guanabo', 'regla', 'guanabacoa',
      'la habana', 'habana', 'varadero', 'centro historico', 'reparto flores', 'buenavista', 'buena vista') THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.cuba_admin_areas a
                 WHERE lower(unaccent(a.name)) = lower(unaccent(v.lead))
                    OR lower(unaccent(COALESCE(a.name_es, ''))) = lower(unaccent(v.lead))) THEN NULL
    ELSE v.lead END
  FROM (SELECT NULLIF(btrim(split_part(COALESCE(p_addr, ''), ',', 1)), '') AS lead) v;
$$;
REVOKE ALL ON FUNCTION public._poi_leading_venue_name(text) FROM PUBLIC, anon, authenticated;

-- Prod's review_is_public (00645): a visible review of the ride's driver, for a signed-in user.
CREATE FUNCTION public.review_is_public(p_review_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM reviews rv
    JOIN rides r ON r.id = rv.ride_id
    JOIN driver_profiles dp ON dp.id = r.driver_id
    WHERE rv.id = p_review_id
      AND rv.is_visible = true
      AND dp.user_id = rv.reviewee_id
  );
$function$;
REVOKE ALL ON FUNCTION public.review_is_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_is_public(uuid) TO anon, authenticated, service_role;

-- What prod's support_tickets INSERT guard (00653) asks of a ride: the caller's side of it.
CREATE FUNCTION public._ride_context_for_caller(p_ride_id uuid) RETURNS TABLE (side text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $f$
  SELECT CASE WHEN r.customer_id = auth.uid() THEN 'customer' ELSE 'driver' END
  FROM rides r
  WHERE r.id = p_ride_id
    AND (r.customer_id = auth.uid()
         OR r.driver_id IN (SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid()))
$f$;

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
  USING ((reviewer_id = (SELECT auth.uid())) OR (reviewee_id = (SELECT auth.uid()))
      OR public.is_admin() OR public.review_is_public(id));
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

-- Prod's INSERT guard on support_tickets (00653). It sorts before 00663's UPDATE guard but fires
-- on INSERT only, which 00663's trigger-order check must tell apart.
CREATE FUNCTION public.tg_support_tickets_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.ride_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public._ride_context_for_caller(NEW.ride_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ese viaje no es tuyo.',
      DETAIL = 'ticket_ride_not_yours';
  END IF;

  NEW.status := 'open';
  NEW.priority := 'normal';
  NEW.assigned_to := NULL;
  NEW.resolved_at := NULL;
  NEW.created_at := now();
  NEW.updated_at := NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_support_tickets_client_guard BEFORE INSERT ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_client_guard();

RESET ROLE;
\ir live-bodies.sql
SET ROLE postgres;
CREATE TRIGGER trg_ticket_messages_client_guard BEFORE INSERT ON public.ticket_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_ticket_messages_client_guard();
RESET ROLE;
