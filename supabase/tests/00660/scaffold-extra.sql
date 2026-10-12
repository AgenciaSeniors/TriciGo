-- Additions to the 00659 scaffold (+ the 00659 migration) for the 00660 rehearsal.
-- Columns, tables and seed rows mirror prod (2026-10-12). Live bodies come from
-- live-bodies.sql (run.sh checks each md5 before applying the migration);
-- complete_ride_and_pay, dispatch_ride and cron_http_post are stubs that record
-- their calls.
SET ROLE tricigo_owner;

ALTER TABLE public.users ADD COLUMN phone text, ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE public.driver_profiles
  ADD COLUMN status text NOT NULL DEFAULT 'approved',
  ADD COLUMN is_online boolean NOT NULL DEFAULT false,
  ADD COLUMN auto_offline_at timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz;
ALTER TABLE public.rides
  ADD COLUMN service_type text NOT NULL DEFAULT 'triciclo_basico',
  ADD COLUMN payment_method text NOT NULL DEFAULT 'cash',
  ADD COLUMN estimated_fare_cup integer NOT NULL DEFAULT 3000,
  ADD COLUMN discount_amount_cup integer NOT NULL DEFAULT 0,
  ADD COLUMN estimated_distance_m integer NOT NULL DEFAULT 4000,
  ADD COLUMN estimated_duration_s integer NOT NULL DEFAULT 900,
  ADD COLUMN insurance_selected boolean NOT NULL DEFAULT false,
  ADD COLUMN insurance_premium_cup integer NOT NULL DEFAULT 0,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN searching_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_dispatched_at timestamptz,
  ADD COLUMN driver_custom_rate_cup integer,
  ADD COLUMN driver_gps_unavailable_at timestamptz,
  ADD COLUMN wait_time_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN wait_time_charge_cup integer NOT NULL DEFAULT 0,
  ADD COLUMN final_fare_cup integer,
  ADD COLUMN corporate_account_id uuid,
  ADD COLUMN canceled_by uuid,
  ADD COLUMN pickup_address text NOT NULL DEFAULT 'Capitolio',
  ADD COLUMN dropoff_address text NOT NULL DEFAULT 'Hotel Nacional',
  ADD COLUMN ride_mode text DEFAULT 'passenger',
  ADD COLUMN dispatch_round integer NOT NULL DEFAULT 0;

-- Delivery proof of a cargo ride (only the columns tg_rides_require_delivery_proof reads).
CREATE TABLE public.delivery_details (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  delivery_otp_validated_at timestamptz, delivery_photo_url text);

CREATE TABLE public.service_type_configs (
  slug text PRIMARY KEY, free_wait_minutes integer, per_wait_minute_rate_cup integer);
INSERT INTO public.service_type_configs VALUES ('triciclo_basico', 5, 94);

CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_type text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  per_wait_minute_rate_cup integer, time_window_start time, time_window_end time, day_of_week integer[]);
-- prod's triciclo bands (the afternoon has no wait rate and falls back to the config's 94)
INSERT INTO public.pricing_rules (service_type, per_wait_minute_rate_cup, time_window_start, time_window_end) VALUES
  ('triciclo_basico', 314, '00:00', '06:00'), ('triciclo_basico', 79, '06:00', '12:00'),
  ('triciclo_basico', NULL, '12:00', '18:00'), ('triciclo_basico', 94, '18:00', '00:00');

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
INSERT INTO public.platform_config VALUES ('max_billable_wait_minutes', '20'), ('reoffer_cooldown_s', '120');

CREATE TABLE public.ride_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type text NOT NULL, total integer NOT NULL);

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid NOT NULL REFERENCES public.rides(id),
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id), status text NOT NULL DEFAULT 'pending',
  offered_at timestamptz DEFAULT now(), expires_at timestamptz, responded_at timestamptz);

CREATE TABLE public.stuck_ride_alerts (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('complete_blocked', 'stationary_chat', 'dead_driver_app')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb, detected_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz, resolved_at timestamptz);

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid REFERENCES public.users(id), action text NOT NULL,
  target_type text, target_id text, old_values jsonb, new_values jsonb, reason text, created_at timestamptz DEFAULT now());

CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY, rpc_name text, caller_uid uuid, target_id uuid, outcome text, metadata jsonb,
  created_at timestamptz DEFAULT now());

CREATE TABLE public.ride_assist (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE, help_requested_at timestamptz,
  help_alert_sent_at timestamptz, wait_alert_sent_at timestamptz, help_email_sent_at timestamptz,
  wait_email_sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid REFERENCES public.driver_profiles(id),
  is_active boolean NOT NULL DEFAULT true, make text, model text, color text, plate_number text);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL, to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL, PRIMARY KEY (from_status, to_status));
-- prod's 19 rows (2026-10-12)
INSERT INTO public.valid_transitions VALUES
  ('accepted','canceled','{customer,driver,admin,super_admin}'), ('accepted','driver_en_route','{driver,admin,super_admin}'),
  ('accepted','searching','{admin,super_admin}'), ('arrived_at_destination','canceled','{admin,super_admin}'),
  ('arrived_at_destination','completed','{driver,admin,super_admin}'), ('arrived_at_destination','disputed','{customer,driver,admin,super_admin}'),
  ('arrived_at_pickup','canceled','{customer,driver,admin,super_admin}'), ('arrived_at_pickup','in_progress','{driver,admin,super_admin}'),
  ('completed','disputed','{customer,driver,admin,super_admin}'), ('disputed','completed','{admin,super_admin}'),
  ('driver_en_route','arrived_at_pickup','{driver,admin,super_admin}'), ('driver_en_route','canceled','{customer,driver,admin,super_admin}'),
  ('driver_en_route','searching','{admin,super_admin}'), ('in_progress','arrived_at_destination','{driver,admin,super_admin}'),
  ('in_progress','canceled','{admin,driver,customer,super_admin}'), ('in_progress','completed','{driver,admin,super_admin}'),
  ('in_progress','disputed','{customer,driver,admin,super_admin}'), ('searching','accepted','{driver,admin,super_admin}'),
  ('searching','canceled','{customer,admin,super_admin}');

CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid, from_status public.ride_status,
  to_status public.ride_status, actor_id uuid, actor_role public.user_role, reason text, metadata jsonb,
  created_at timestamptz DEFAULT now());

GRANT SELECT ON public.ride_pricing_snapshots, public.stuck_ride_alerts, public.vehicles TO authenticated;
GRANT SELECT, UPDATE ON public.rides TO authenticated;

-- Stubs ---------------------------------------------------------------------
-- Every push that goes through cron_http_post lands in net.calls with its job label first.
CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint LANGUAGE sql AS $f$ INSERT INTO net.calls (url, body) VALUES (p_jobname || ' ' || url, body) RETURNING id $f$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC;

-- dispatch_ride: what prod writes on the ride itself (a new round, now), plus a call record.
CREATE TABLE public.dispatch_calls (ride_id uuid, at timestamptz DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog
AS $f$
  UPDATE public.rides SET dispatch_round = dispatch_round + 1, last_dispatched_at = now() WHERE id = p_ride_id;
  INSERT INTO public.dispatch_calls (ride_id) VALUES (p_ride_id) RETURNING jsonb_build_object('ok', true)
$f$;
REVOKE ALL ON FUNCTION public.dispatch_ride(uuid, integer) FROM PUBLIC;

-- complete_ride_and_pay: prod's guards copied, the money part reduced to the fare it charges.
CREATE TABLE public.complete_calls (ride_id uuid, driver_id uuid, distance_m integer, duration_s integer, caller uuid);
CREATE OR REPLACE FUNCTION public.complete_ride_and_pay(p_ride_id uuid, p_driver_id uuid,
  p_actual_distance_m integer, p_actual_duration_s integer)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $f$
DECLARE v_ride public.rides%ROWTYPE; v_total integer; v_wait integer; v_driver_user_id uuid;
BEGIN
  PERFORM set_config('app.trusted_driver_update', '1', true);
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF v_ride IS NULL THEN RAISE EXCEPTION 'Ride not found: %', p_ride_id; END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RAISE EXCEPTION 'Ride % cannot be completed (current: %)', p_ride_id, v_ride.status;
  END IF;
  IF v_ride.driver_id != p_driver_id THEN
    RAISE EXCEPTION 'Driver % is not assigned to ride %', p_driver_id, p_ride_id;
  END IF;
  SELECT user_id INTO v_driver_user_id FROM public.driver_profiles WHERE id = p_driver_id;
  IF NOT public.is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden: only the assigned driver can complete this ride';
  END IF;
  INSERT INTO public.complete_calls VALUES (p_ride_id, p_driver_id, p_actual_distance_m, p_actual_duration_s, auth.uid());
  PERFORM public.calculate_wait_charge(p_ride_id);
  SELECT wait_time_charge_cup INTO v_wait FROM public.rides WHERE id = p_ride_id;
  SELECT total INTO v_total FROM public.ride_pricing_snapshots WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' LIMIT 1;
  UPDATE public.rides SET status = 'completed',
         final_fare_cup = GREATEST(v_total - COALESCE(v_ride.discount_amount_cup, 0), 0) + COALESCE(v_wait, 0)
   WHERE id = p_ride_id;
  -- prod's result carries these keys; a cash ride is all cash.
  RETURN (SELECT jsonb_build_object('success', true, 'final_fare_cup', r.final_fare_cup,
                 'payment_method', r.payment_method,
                 'cash_amount_cup', CASE WHEN r.payment_method = 'cash' THEN r.final_fare_cup ELSE 0 END,
                 'wallet_amount_cup', CASE WHEN r.payment_method = 'cash' THEN 0 ELSE r.final_fare_cup END)
          FROM public.rides r WHERE r.id = p_ride_id);
END $f$;
REVOKE ALL ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) TO authenticated, service_role;

RESET ROLE;

SET ROLE tricigo_owner;
\ir live-bodies-load.sql
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_push_ride_status AFTER UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.notify_ride_status_change();
CREATE TRIGGER trg_driver_profiles_shift_intent BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_shift_intent();
REVOKE ALL ON FUNCTION public.calculate_wait_charge(uuid), public.get_platform_config_numeric(text, numeric),
  public.log_rpc_attempt(text, uuid, uuid, text, jsonb), public._ride_short_code(uuid),
  public.release_rides_from_dead_drivers(), public.tg_driver_profiles_shift_intent() FROM PUBLIC;
RESET ROLE;
