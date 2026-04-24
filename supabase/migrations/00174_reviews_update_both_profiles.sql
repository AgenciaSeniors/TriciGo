-- ============================================================
-- BUG-117: trg_update_customer_rating only updated customer_profiles.
-- When a passenger reviewed a driver (the typical direction), the
-- trigger UPDATE targeted customer_profiles.user_id = driver_user_id
-- which doesn't match (driver is NOT in customer_profiles) — the
-- UPDATE affected 0 rows and driver_profiles.rating_avg never moved
-- from its seeded default.
--
-- Impact: every driver's on-screen rating is stuck at the seed value
-- (5.0 for unseeded / 4.8 for test seeds) regardless of how many 1-star
-- reviews they receive. Customers see the same rating forever. Matching
-- engine uses this field as input, so dispatch decisions are also off.
--
-- Fix: rewrite the trigger function to detect the reviewee's role and
-- update the correct profile table. Covers both directions:
--   passenger rates driver → driver_profiles.rating_avg
--   driver rates passenger → customer_profiles.rating_avg
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_rating_avg()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_reviewee_role TEXT;
  v_avg NUMERIC;
BEGIN
  SELECT role::TEXT INTO v_reviewee_role FROM users WHERE id = NEW.reviewee_id;

  SELECT COALESCE(ROUND(AVG(r.rating)::numeric, 2), 5.00) INTO v_avg
  FROM reviews r
  WHERE r.reviewee_id = NEW.reviewee_id
    AND r.is_visible = true;

  IF v_reviewee_role IN ('driver') THEN
    UPDATE driver_profiles SET rating_avg = v_avg WHERE user_id = NEW.reviewee_id;
  ELSIF v_reviewee_role IN ('customer', 'super_admin', 'admin') THEN
    UPDATE customer_profiles SET rating_avg = v_avg WHERE user_id = NEW.reviewee_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_customer_rating ON public.reviews;
DROP TRIGGER IF EXISTS trg_update_rating_avg ON public.reviews;
CREATE TRIGGER trg_update_rating_avg
AFTER INSERT OR UPDATE ON public.reviews
FOR EACH ROW
EXECUTE FUNCTION public.update_rating_avg();

COMMENT ON TRIGGER trg_update_rating_avg ON public.reviews IS
  'BUG-117: keep driver_profiles.rating_avg / customer_profiles.rating_avg in sync with visible reviews. Replaced the old customer-only trigger.';
