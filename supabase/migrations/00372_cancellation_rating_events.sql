-- ============================================================
-- Cancellation reputation (Phase 1/3) — replace MONEY penalties on
-- cancellation with a hit to the VISIBLE star rating (rating_avg).
--
-- Decisions (user, 2026-06-03):
--   * Punishment = lower visible stars (NOT a separate score).
--   * Zero money in any cancellation (apply_cancellation_fee /
--     apply_cancellation_penalty are decommissioned in 00373).
--   * Applies to BOTH riders and drivers (both have rating_avg).
--   * Operational consequence = lower matching priority (00374:
--     driver rating already weighs 20% in find_best_drivers; the
--     rider gets a soft first-round dispatch gate).
--
-- This migration adds the rating machinery:
--   1. cancellation_rating_events — one row per late cancellation.
--      rating_value NULL = grace (1st in the 24h window): logged for
--      the progressive count, but does NOT pull the average down.
--   2. recompute_user_rating(user_id) — average of visible reviews
--      + cancellation events (within a configurable recovery window).
--   3. apply_user_rating(user_id) — recompute + write to the correct
--      profile table (driver_profiles / customer_profiles) by role.
--   4. update_rating_avg() rewritten to delegate to apply_user_rating
--      (the reviews trigger from 00174 keeps firing it).
--   5. trigger on cancellation_rating_events to keep rating_avg live.
--   6. platform_config defaults (star values, recovery window,
--      rider dispatch gate).
-- ============================================================

-- 1. Events table ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cancellation_rating_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  ride_id       uuid REFERENCES public.rides(id) ON DELETE SET NULL,
  -- NULL = grace (1st late cancel in the rolling 24h window): counted
  -- for the progression but excluded from the rating average.
  rating_value  numeric(3,2)
    CHECK (rating_value IS NULL OR (rating_value >= 1.0 AND rating_value <= 5.0)),
  role_at_event text,                      -- 'customer' | 'driver' (audit)
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One event per (user, ride). cancel_ride only runs once per ride
-- (guarded by the status check) but stay idempotent regardless.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_rating_events_user_ride
  ON public.cancellation_rating_events (user_id, ride_id)
  WHERE ride_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cancellation_rating_events_user_created
  ON public.cancellation_rating_events (user_id, created_at DESC);

ALTER TABLE public.cancellation_rating_events ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner + admins. All writes go through the
-- SECURITY DEFINER cancel_ride RPC, so no INSERT/UPDATE policy.
DROP POLICY IF EXISTS cre_select_own ON public.cancellation_rating_events;
CREATE POLICY cre_select_own ON public.cancellation_rating_events
  FOR SELECT USING (user_id = auth.uid() OR is_admin());

COMMENT ON TABLE public.cancellation_rating_events IS
  'Late-cancellation reputation events. Each row contributes its rating_value as a pseudo-review to recompute_user_rating(). rating_value NULL = grace (no impact).';

-- 2. platform_config defaults -----------------------------------
-- Star value a 2nd / 3rd+ late cancellation contributes (lower = worse).
-- Recovery window: events older than N days stop counting (0 = forever).
-- Rider dispatch gate: below the threshold, the first dispatch round is
-- weaker (fewer drivers, smaller radius) — retries still rescue them.
INSERT INTO public.platform_config (key, value) VALUES
  ('cancel_rating_value_second',      '3.0'),
  ('cancel_rating_value_third',       '2.0'),
  ('cancel_rating_event_window_days', '90'),
  ('low_rating_rider_threshold',      '3.0'),
  ('low_rating_rider_dispatch_limit', '5'),
  ('low_rating_rider_radius_m',       '3000')
ON CONFLICT (key) DO NOTHING;

-- 3. recompute_user_rating --------------------------------------
-- Visible reviews + non-grace cancellation events (within the recovery
-- window), averaged. No prior/bayesian smoothing: a user with no signal
-- keeps the 5.00 seed, and existing ratings are unchanged until a
-- cancellation event lands.
CREATE OR REPLACE FUNCTION public.recompute_user_rating(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_window_days numeric := get_platform_config_numeric('cancel_rating_event_window_days', 90);
  v_sum numeric;
  v_cnt numeric;
BEGIN
  SELECT COALESCE(SUM(s.val), 0), COUNT(s.val)
    INTO v_sum, v_cnt
  FROM (
    SELECT r.rating::numeric AS val
    FROM reviews r
    WHERE r.reviewee_id = p_user_id
      AND r.is_visible = true
    UNION ALL
    SELECT ce.rating_value AS val
    FROM cancellation_rating_events ce
    WHERE ce.user_id = p_user_id
      AND ce.rating_value IS NOT NULL
      AND (v_window_days <= 0
           OR ce.created_at > now() - (v_window_days || ' days')::interval)
  ) s;

  IF v_cnt = 0 THEN
    RETURN 5.00;  -- no signal yet → seed default
  END IF;
  RETURN GREATEST(1.00, LEAST(5.00, ROUND(v_sum / v_cnt, 2)));
END;
$$;

-- 4. apply_user_rating: recompute + write to the right profile --
CREATE OR REPLACE FUNCTION public.apply_user_rating(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_role text;
  v_avg  numeric;
BEGIN
  SELECT role::text INTO v_role FROM users WHERE id = p_user_id;
  v_avg := recompute_user_rating(p_user_id);
  IF v_role = 'driver' THEN
    UPDATE driver_profiles SET rating_avg = v_avg WHERE user_id = p_user_id;
  ELSIF v_role IN ('customer', 'super_admin', 'admin') THEN
    UPDATE customer_profiles SET rating_avg = v_avg WHERE user_id = p_user_id;
  END IF;
END;
$$;

-- 5. update_rating_avg() — now delegates to apply_user_rating ----
-- The reviews trigger trg_update_rating_avg (00174) keeps calling this.
CREATE OR REPLACE FUNCTION public.update_rating_avg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  PERFORM apply_user_rating(NEW.reviewee_id);
  RETURN NEW;
END;
$$;

-- 6. trigger on cancellation_rating_events ----------------------
CREATE OR REPLACE FUNCTION public.tg_cancellation_rating_event_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  PERFORM apply_user_rating(COALESCE(NEW.user_id, OLD.user_id));
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_cancellation_rating_event_apply ON public.cancellation_rating_events;
CREATE TRIGGER trg_cancellation_rating_event_apply
AFTER INSERT OR UPDATE OR DELETE ON public.cancellation_rating_events
FOR EACH ROW EXECUTE FUNCTION public.tg_cancellation_rating_event_apply();
