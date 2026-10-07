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

-- 4. The estimate snapshot: one writer for the ride INSERT trigger and the type change.

-- The two live bodies rewritten below must be the ones this migration was written for.
DO $guard$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_rides_create_estimate_snapshot()'::regprocedure;
  IF position('_write_ride_estimate_snapshot' IN v_src) = 0
     AND md5(v_src) <> 'b801283b9dcb6de3e4822992347d962e' THEN
    RAISE EXCEPTION '00628: tg_rides_create_estimate_snapshot is not the body this migration was written for (md5 %)', md5(v_src);
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure;
  IF position('app.force_discount_recompute' IN v_src) = 0
     AND md5(v_src) <> 'd4494bd8ab75ce590e1c42743583aec5' THEN
    RAISE EXCEPTION '00628: tg_rides_validate_promo_discount is not the body this migration was written for (md5 %)', md5(v_src);
  END IF;
END
$guard$;

-- Writes the ride's estimate row, the price contract complete_ride_and_pay charges.
-- The logic is tg_rides_create_estimate_snapshot's body as of 00628 (md5 b801283b…) with NEW
-- renamed p_ride. p_replace = false only writes a ride that has no estimate row yet (the INSERT
-- trigger). p_replace = true rewrites the existing row in place (a type change).
CREATE OR REPLACE FUNCTION public._write_ride_estimate_snapshot(p_ride public.rides, p_replace boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_svc                  RECORD;
  v_commission_rate      NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_eff_per_km           INTEGER;
  v_commission_amount    INTEGER;
  v_rule_id              uuid;
  v_now_t                time;
  v_now_dow              int;
  v_exists               boolean;
BEGIN
  IF p_ride.estimated_fare_cup IS NULL OR p_ride.estimated_fare_cup <= 0 THEN
    RETURN;
  END IF;

  v_exists := EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = p_ride.id AND snapshot_type = 'estimate'
  );
  IF v_exists AND NOT p_replace THEN
    RETURN;
  END IF;

  SELECT * INTO v_svc
  FROM public.service_type_configs
  WHERE slug = p_ride.service_type AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  BEGIN
    v_now_t   := (now() AT TIME ZONE 'America/Havana')::time;
    v_now_dow := EXTRACT(dow FROM now() AT TIME ZONE 'America/Havana')::int;
    SELECT pr.id INTO v_rule_id
    FROM public.pricing_rules pr
    WHERE pr.service_type = p_ride.service_type
      AND pr.is_active = true
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_now_t >= pr.time_window_start AND v_now_t < pr.time_window_end
                ELSE v_now_t >= pr.time_window_start OR v_now_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_now_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_rule_id := NULL;
  END;

  v_eff_per_km := COALESCE(p_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM public.platform_config WHERE key = 'commission_rate';
  -- Guard: 0 / NULL / out-of-range (>=1) is invalid -> fall back to 15%.
  IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
    v_commission_rate := 0.15;
  END IF;

  IF p_ride.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
    FROM public.corporate_accounts WHERE id = p_ride.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(p_ride.estimated_fare_cup * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(p_ride.estimated_fare_cup * v_commission_rate)::int;
  END IF;

  IF v_exists THEN
    UPDATE public.ride_pricing_snapshots SET (
      base_fare, per_km_rate, per_minute_rate,
      distance_m, duration_s, surge_multiplier, subtotal,
      commission_rate, commission_amount, total, pricing_rule_id,
      exchange_rate_usd_cup, total_trc,
      min_fare, corporate_commission_rate, default_commission_rate_snapshot
    ) = (
      v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
      p_ride.estimated_distance_m, p_ride.estimated_duration_s, p_ride.surge_multiplier,
      p_ride.estimated_fare_cup,
      COALESCE(v_corp_commission_rate, v_commission_rate),
      v_commission_amount,
      p_ride.estimated_fare_cup,
      v_rule_id,
      p_ride.exchange_rate_usd_cup, p_ride.estimated_fare_trc,
      v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
    )
    WHERE ride_id = p_ride.id AND snapshot_type = 'estimate';
  ELSE
    INSERT INTO public.ride_pricing_snapshots (
      ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
      distance_m, duration_s, surge_multiplier, subtotal,
      commission_rate, commission_amount, total, pricing_rule_id,
      exchange_rate_usd_cup, total_trc,
      min_fare, corporate_commission_rate, default_commission_rate_snapshot
    ) VALUES (
      p_ride.id, 'estimate',
      v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
      p_ride.estimated_distance_m, p_ride.estimated_duration_s, p_ride.surge_multiplier,
      p_ride.estimated_fare_cup,
      COALESCE(v_corp_commission_rate, v_commission_rate),
      v_commission_amount,
      p_ride.estimated_fare_cup,
      v_rule_id,
      p_ride.exchange_rate_usd_cup, p_ride.estimated_fare_trc,
      v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._write_ride_estimate_snapshot(public.rides, boolean) FROM PUBLIC, anon, authenticated;

-- Same trigger function, same attributes; CREATE OR REPLACE keeps its grants.
CREATE OR REPLACE FUNCTION public.tg_rides_create_estimate_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  -- 00628: the body moved to _write_ride_estimate_snapshot, shared with the type change.
  PERFORM public._write_ride_estimate_snapshot(NEW, false);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_rides_create_estimate_snapshot failed for ride %: % %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

-- 5. tg_rides_validate_promo_discount: its super_admin bypass keeps whatever discount the
--    UPDATE carries, a deliberate escape hatch for support. A type change needs the recompute
--    whoever applies it, so the bypass steps aside while the transaction has
--    app.force_discount_recompute = '1', which only _apply_ride_service_change sets.
--    Patched in place from the live body (CLAUDE.md § "Patch in-place"): nothing else changes.
DO $patch$
DECLARE
  v_src    text;
  v_target constant text := 'IF is_super_admin() THEN';
  v_new    constant text := 'IF is_super_admin() AND COALESCE(current_setting(''app.force_discount_recompute'', true), '''') <> ''1'' THEN';
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure;
  IF position('app.force_discount_recompute' IN v_src) > 0 THEN
    RETURN;  -- already patched
  END IF;
  IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
    RAISE EXCEPTION '00628: the super_admin bypass is not exactly once in tg_rides_validate_promo_discount';
  END IF;
  EXECUTE replace(pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure), v_target, v_new);
END
$patch$;

-- 6. Changing the vehicle type of a searching ride.

-- Why the ride cannot switch to p_service_type at p_fare_cup, or NULL when it can.
CREATE OR REPLACE FUNCTION public._ride_service_change_error(p_ride public.rides, p_service_type text, p_fare_cup integer)
RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_svc public.service_type_configs%ROWTYPE;
BEGIN
  IF p_ride.status <> 'searching' THEN
    RETURN 'ride_not_searching';
  END IF;
  IF COALESCE(p_ride.ride_mode, 'passenger') <> 'passenger' THEN
    RETURN 'cargo_not_supported';
  END IF;
  IF p_ride.corporate_account_id IS NOT NULL THEN
    RETURN 'corporate_not_supported';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ride_waypoints w WHERE w.ride_id = p_ride.id) THEN
    RETURN 'waypoints_not_supported';
  END IF;
  IF p_service_type IS NULL OR p_service_type = p_ride.service_type THEN
    RETURN 'same_service_type';
  END IF;
  SELECT * INTO v_svc FROM public.service_type_configs WHERE slug = p_service_type AND is_active;
  IF NOT FOUND OR p_service_type = 'mensajeria' THEN
    RETURN 'service_type_unavailable';
  END IF;
  IF v_svc.max_passengers > 0 AND COALESCE(p_ride.passenger_count, 1) > v_svc.max_passengers THEN
    RETURN 'too_many_passengers';
  END IF;
  IF p_fare_cup IS NULL OR p_fare_cup < v_svc.min_fare_cup THEN
    RETURN 'fare_below_minimum';
  END IF;
  -- A typo guard: no vehicle type costs five times another for the same trip.
  IF p_fare_cup > 5 * GREATEST(COALESCE(p_ride.estimated_fare_cup, 0), v_svc.min_fare_cup) THEN
    RETURN 'fare_out_of_range';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._ride_service_change_error(public.rides, text, integer) FROM PUBLIC, anon, authenticated;

-- Switches a searching ride to another type at a new fare. The callers check who is calling;
-- this re-checks the ride under its row lock.
CREATE OR REPLACE FUNCTION public._apply_ride_service_change(p_ride_id uuid, p_service_type text, p_fare_cup integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_err  text;
BEGIN
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ride_not_found';
  END IF;
  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);
  IF v_err IS NOT NULL THEN
    RAISE EXCEPTION '%', v_err;
  END IF;

  -- 1. The estimate row first: complete_ride_and_pay charges its total, and the discount
  --    trigger below reads it as the fare base.
  v_ride.service_type       := p_service_type;
  v_ride.estimated_fare_cup := p_fare_cup;
  v_ride.estimated_fare_trc := p_fare_cup;  -- 1 TRC = 1 CUP: cupToTrc is the identity
  PERFORM public._write_ride_estimate_snapshot(v_ride, true);
  IF NOT EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' AND total = p_fare_cup
  ) THEN
    RAISE EXCEPTION 'snapshot_failed';
  END IF;

  -- 2. The ride. Setting discount_amount_cup fires tg_rides_validate_promo_discount, which
  --    recomputes the promo, partner and shared-ride discounts on the new fare and clears
  --    shared_ride off triciclo; the flag makes it do so for a super_admin too.
  --    tg_rides_validate_insurance recomputes the premium on its own. surge_multiplier stays as
  --    it was: a rider may not change it, and the snapshot only records it.
  PERFORM set_config('app.force_discount_recompute', '1', true);
  UPDATE public.rides
     SET service_type        = p_service_type,
         estimated_fare_cup  = p_fare_cup,
         estimated_fare_trc  = p_fare_cup,
         discount_amount_cup = discount_amount_cup
   WHERE id = p_ride_id;
  PERFORM set_config('app.force_discount_recompute', '', true);

  -- 3. Offers made for the old type are void; drivers of the new type get offers.
  UPDATE public.ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';
  UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';
  PERFORM public.dispatch_ride(p_ride_id);
END;
$$;
REVOKE ALL ON FUNCTION public._apply_ride_service_change(uuid, text, integer) FROM PUBLIC, anon, authenticated;

-- Support: propose another type to the rider, or apply it with the rider's WhatsApp consent.
CREATE OR REPLACE FUNCTION public.admin_change_ride_service(
  p_ride_id uuid, p_service_type text, p_fare_cup integer, p_mode text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_admin  uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride   public.rides%ROWTYPE;
  v_err    text;
  v_ttl    integer;
  v_prop   public.ride_service_proposals%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('propose', 'apply') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;
  IF p_mode = 'apply' AND v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_err, 'status', v_ride.status);
  END IF;

  IF p_mode = 'propose' THEN
    v_ttl := GREATEST(60, public.get_platform_config_numeric('support_proposal_ttl_s', 180)::int);
    UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
     WHERE ride_id = p_ride_id AND status = 'pending';
    INSERT INTO public.ride_service_proposals
      (ride_id, from_service_type, to_service_type, from_fare_cup, to_fare_cup, proposed_by, expires_at)
    VALUES
      (p_ride_id, v_ride.service_type, p_service_type, COALESCE(v_ride.estimated_fare_cup, 0), p_fare_cup,
       v_admin, now() + make_interval(secs => v_ttl))
    RETURNING * INTO v_prop;
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
    VALUES (v_admin, 'support_propose_service', 'ride', p_ride_id::text,
            jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup),
            jsonb_build_object('service_type', p_service_type, 'estimated_fare_cup', p_fare_cup, 'proposal_id', v_prop.id),
            v_reason);
    RETURN jsonb_build_object('success', true, 'mode', 'propose',
                              'proposal_id', v_prop.id, 'expires_at', v_prop.expires_at);
  END IF;

  PERFORM public._apply_ride_service_change(p_ride_id, p_service_type, p_fare_cup);
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  SELECT v_admin, 'support_change_service', 'ride', p_ride_id::text,
         jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup,
                            'discount_amount_cup', v_ride.discount_amount_cup),
         jsonb_build_object('service_type', r.service_type, 'estimated_fare_cup', r.estimated_fare_cup,
                            'discount_amount_cup', r.discount_amount_cup),
         v_reason
  FROM public.rides r WHERE r.id = p_ride_id;
  RETURN jsonb_build_object('success', true, 'mode', 'apply');
END;
$$;
REVOKE ALL ON FUNCTION public.admin_change_ride_service(uuid, text, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_change_ride_service(uuid, text, integer, text, text) TO authenticated, service_role;

-- The rider's pending, unexpired proposal for their own searching ride, or NULL.
CREATE OR REPLACE FUNCTION public.get_my_ride_service_proposal(p_ride_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'ride_id', p.ride_id,
    'from_service_type', p.from_service_type, 'to_service_type', p.to_service_type,
    'from_fare_cup', p.from_fare_cup, 'to_fare_cup', p.to_fare_cup,
    'expires_at', p.expires_at)
  FROM public.ride_service_proposals p
  JOIN public.rides r ON r.id = p.ride_id
  WHERE p.ride_id = p_ride_id
    AND r.customer_id = auth.uid()
    AND r.status = 'searching'
    AND p.status = 'pending'
    AND p.expires_at > now()
  ORDER BY p.created_at DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.get_my_ride_service_proposal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_ride_service_proposal(uuid) TO authenticated, service_role;

-- The rider accepts or rejects a proposal.
CREATE OR REPLACE FUNCTION public.respond_ride_service_proposal(p_proposal_id uuid, p_accept boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_ride_id uuid;
  v_ride    public.rides%ROWTYPE;
  v_prop    public.ride_service_proposals%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  SELECT ride_id INTO v_ride_id FROM public.ride_service_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'proposal_not_found');
  END IF;

  -- The ride first, then the proposal: the order every writer of a ride's rows uses.
  SELECT * INTO v_ride FROM public.rides WHERE id = v_ride_id FOR UPDATE;
  IF NOT FOUND OR v_ride.customer_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('error', 'proposal_not_found');
  END IF;
  SELECT * INTO v_prop FROM public.ride_service_proposals WHERE id = p_proposal_id FOR UPDATE;

  IF v_prop.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'proposal_not_pending', 'status', v_prop.status);
  END IF;
  IF v_prop.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'proposal_expired');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;

  IF NOT COALESCE(p_accept, false) THEN
    UPDATE public.ride_service_proposals SET status = 'rejected', responded_at = now() WHERE id = p_proposal_id;
    PERFORM public.log_rpc_attempt('respond_ride_service_proposal', v_uid, v_ride_id, 'rejected',
      jsonb_build_object('proposal_id', p_proposal_id));
    RETURN jsonb_build_object('success', true, 'accepted', false);
  END IF;

  BEGIN
    UPDATE public.ride_service_proposals SET status = 'accepted', responded_at = now() WHERE id = p_proposal_id;
    PERFORM public._apply_ride_service_change(v_ride_id, v_prop.to_service_type, v_prop.to_fare_cup);
  EXCEPTION WHEN raise_exception THEN
    -- _apply_ride_service_change refused (the type's minimum fare went up since the proposal,
    -- for example). Nothing changed and the proposal stays pending.
    PERFORM public.log_rpc_attempt('respond_ride_service_proposal', v_uid, v_ride_id, SQLERRM,
      jsonb_build_object('proposal_id', p_proposal_id));
    RETURN jsonb_build_object('error', SQLERRM);
  END;

  PERFORM public.log_rpc_attempt('respond_ride_service_proposal', v_uid, v_ride_id, 'accepted',
    jsonb_build_object('proposal_id', p_proposal_id, 'service_type', v_prop.to_service_type,
                       'fare_cup', v_prop.to_fare_cup));
  RETURN jsonb_build_object('success', true, 'accepted', true,
                            'service_type', v_prop.to_service_type, 'fare_cup', v_prop.to_fare_cup);
END;
$$;
REVOKE ALL ON FUNCTION public.respond_ride_service_proposal(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_ride_service_proposal(uuid, boolean) TO authenticated, service_role;
