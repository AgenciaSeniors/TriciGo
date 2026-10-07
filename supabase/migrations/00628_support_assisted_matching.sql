-- ============================================================
-- 00628 — support-assisted matching
--
-- When the app cannot find a driver, TriciGo support helps the rider get one, inside the app.
--   * request_ride_help: the rider's "Pedir ayuda" button. Marks the ride and alerts support.
--   * notify_support_waiting_rides (cron, every minute): alerts support once per ride that has
--     waited longer than support_alert_after_s (60 s).
--     An alert is a push to every active admin and super_admin (category system, always
--     delivered) and an e-mail to support_alert_email, both through cron_http_post.
--   * admin_support_waiting_rides, admin_ride_assist_context, admin_ride_assist_candidates:
--     the admin banner and the assist page.
--   * admin_offer_ride_to_driver: an offer the driver accepts in the app as usual.
--   * admin_assign_ride_to_driver: assigns at once, with accept_ride_v2's checks plus the
--     vehicle type, and a reason.
--   * admin_change_ride_service: another vehicle type at a recomputed price, proposed to the
--     rider (get_my_ride_service_proposal, respond_ride_service_proposal) or applied with the
--     rider's WhatsApp consent and a reason.
--
-- A type change rewrites the ride's estimate snapshot, which complete_ride_and_pay charges,
-- through _write_ride_estimate_snapshot, now shared with tg_rides_create_estimate_snapshot,
-- and re-runs the discount trigger. tg_rides_validate_promo_discount gets a one-line patch so
-- that its super_admin bypass does not skip that recompute when this code asks for it.
--
-- Design: docs/superpowers/specs/2026-10-07-support-assisted-matching-design.md
-- Rehearsal: supabase/tests/00628/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- The foreign keys below lock rides (SHARE ROW EXCLUSIVE) until commit. Give up after 10 s rather
-- than queue every ride write behind a long transaction. Outside a transaction block (the local
-- rehearsal's psql) SET LOCAL only prints a warning.
SET LOCAL lock_timeout = '10s';

-- 1. Support tables. Both are lock tables (RLS, no policies): only the SECURITY DEFINER
--    functions below read and write them.

CREATE TABLE IF NOT EXISTS public.ride_assist (
  ride_id            uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  help_requested_at  timestamptz,
  help_alert_sent_at timestamptz,
  wait_alert_sent_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ride_assist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ride_assist FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ride_assist TO service_role;

CREATE TABLE IF NOT EXISTS public.ride_service_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id           uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  from_service_type text NOT NULL,
  to_service_type   text NOT NULL,
  from_fare_cup     integer NOT NULL,
  to_fare_cup       integer NOT NULL CHECK (to_fare_cup > 0),
  proposed_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- A pending row whose expires_at has passed is expired: nothing sweeps it.
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  expires_at        timestamptz NOT NULL,
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ride_service_proposals_one_pending
  ON public.ride_service_proposals (ride_id) WHERE status = 'pending';
ALTER TABLE public.ride_service_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ride_service_proposals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ride_service_proposals TO service_role;

-- 2. Settings (admin: Settings → Platform config).
INSERT INTO public.platform_config (key, value) VALUES
  ('support_alert_enabled', 'true'::jsonb),
  ('support_alert_after_s', '60'::jsonb),
  ('support_offer_ttl_s', '120'::jsonb),
  ('support_proposal_ttl_s', '180'::jsonb)
ON CONFLICT (key) DO NOTHING;
-- Who gets the alert e-mail: starts as the business list. Empty turns the e-mail off.
INSERT INTO public.platform_config (key, value)
SELECT 'support_alert_email', value FROM public.platform_config WHERE key = 'business_notification_email'
ON CONFLICT (key) DO NOTHING;

-- 3. Helpers. None is callable by a client role.

-- The ride code support and the rider talk about: the first 8 characters of the id.
CREATE OR REPLACE FUNCTION public._ride_short_code(p_ride_id uuid)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$ SELECT upper(left(p_ride_id::text, 8)) $$;

-- The vehicle types that can serve a service type: the CASE in find_best_drivers, which the
-- dispatcher uses. Keep the two in step. NULL means any vehicle.
CREATE OR REPLACE FUNCTION public._vehicle_types_for_service(p_service_type text)
RETURNS public.vehicle_type[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::public.vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::public.vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::public.vehicle_type, 'confort'::public.vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::public.vehicle_type]
  END
$$;

-- An active vehicle of the driver can serve the ride: the vehicle filter of find_best_drivers
-- (type, and accepts_cargo for deliveries). Package size and weight are left to support.
CREATE OR REPLACE FUNCTION public._driver_can_serve_ride(p_driver_id uuid, p_service_type text, p_is_delivery boolean)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicles v
    WHERE v.driver_id = p_driver_id
      AND v.is_active
      AND (public._vehicle_types_for_service(p_service_type) IS NULL
           OR v.type = ANY (public._vehicle_types_for_service(p_service_type)))
      AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)
  )
$$;

-- Either user blocked the other. dispatch_ride never offers a ride across such a pair.
CREATE OR REPLACE FUNCTION public._users_blocked(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = p_a AND ub.blocked_id = p_b)
       OR (ub.blocker_id = p_b AND ub.blocked_id = p_a)
  )
$$;

-- For values a user typed (addresses, names) that go into an HTML e-mail.
CREATE OR REPLACE FUNCTION public._html_escape(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

REVOKE ALL ON FUNCTION public._ride_short_code(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._vehicle_types_for_service(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._driver_can_serve_ride(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._users_blocked(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._html_escape(text) FROM PUBLIC, anon, authenticated;
