-- 00411_tier_runtime_fix.sql
-- ============================================================================
-- Fix: the loyalty tier (users.level / users.total_rides) NEVER updates in
-- runtime — no user levels up from their rides. Only the one-time backfill
-- (migs 00370/00371) ever populated it.
--
-- Root cause (verified in prod 2026-06-13 via rolled-back E2E):
--   `recompute_user_level` (SECURITY DEFINER) does
--     UPDATE users SET total_rides = ..., level = GREATEST(level, ...)
--   but the BEFORE-UPDATE trigger `tg_users_protect_admin_fields` REVERTS
--     NEW.level := OLD.level;  NEW.total_rides := OLD.total_rides;
--   for any authenticated non-admin caller. In the real flow
--   `complete_ride_and_pay` is invoked by the DRIVER (auth.uid() = driver),
--   so the protect trigger reverts the tier write -> neither rider nor driver
--   ever levels up. The backfill worked only because it ran as service-role
--   (auth.uid() IS NULL — the branch the trigger lets through).
--   Proof: recompute_user_level(carlos) as service-role -> total_rides 120->6;
--          same call impersonating Carlos (authenticated) -> 120->120 (reverted).
--
-- Fix: `recompute_user_level` marks its single UPDATE as trusted via a
-- transaction-local GUC `app.trusted_tier_update`. The client CANNOT set this
-- (PostgREST cannot run set_config; only server-side SECURITY DEFINER functions
-- can), so it is safe as an authorization signal. `tg_users_protect_admin_fields`
-- honors the flag for level + total_rides ONLY, still protecting role,
-- is_active, total_spent, cancellation_count, id, created_at against tampering.
-- ============================================================================

-- 1) recompute_user_level — flag the trusted tier update around the UPDATE.
--    (Body reproduced verbatim from the live prod function; only the two
--     set_config() lines around the UPDATE are new.)
CREATE OR REPLACE FUNCTION public.recompute_user_level(p_user_id uuid)
 RETURNS user_level
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trips int;
  v_new   user_level;
  v_final user_level;
BEGIN
  SELECT
      (SELECT count(*) FROM rides r
        WHERE r.customer_id = p_user_id AND r.status = 'completed')
    + (SELECT count(*) FROM rides r
        JOIN driver_profiles dp ON dp.id = r.driver_id
        WHERE dp.user_id = p_user_id AND r.status = 'completed')
  INTO v_trips;

  v_new := (CASE
    WHEN v_trips >= get_platform_config_numeric('tier_diamante_min_trips', 100) THEN 'diamante'
    WHEN v_trips >= get_platform_config_numeric('tier_platino_min_trips',   50) THEN 'platino'
    WHEN v_trips >= get_platform_config_numeric('tier_oro_min_trips',       20) THEN 'oro'
    WHEN v_trips >= get_platform_config_numeric('tier_plata_min_trips',      5) THEN 'plata'
    ELSE 'bronce'
  END)::user_level;

  -- Trusted-tier-update signal: this is the ONLY legitimate automatic writer of
  -- users.level / users.total_rides. Signal trust for the single UPDATE below so
  -- the protect-admin-fields trigger doesn't revert it for non-admin callers,
  -- then clear it immediately (it is transaction-local regardless).
  PERFORM set_config('app.trusted_tier_update', '1', true);

  UPDATE users
     SET total_rides = v_trips,
         level       = GREATEST(level, v_new)
   WHERE id = p_user_id
  RETURNING level INTO v_final;

  PERFORM set_config('app.trusted_tier_update', 'off', true);

  RETURN v_final;
END;
$function$;

-- 2) tg_users_protect_admin_fields — honor the trusted flag for level +
--    total_rides only. (Body reproduced verbatim from the live prod function;
--    only the new `trusted_tier_update` branch is added, before is_admin.)
CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- Trusted tier update (set ONLY by recompute_user_level, a SECURITY DEFINER
  -- function the client cannot invoke set_config from): allow level + total_rides
  -- through while still protecting every other admin-only field. Without this,
  -- the loyalty tier never updates in runtime (see migration header).
  IF current_setting('app.trusted_tier_update', true) = '1' THEN
    NEW.role                 := OLD.role;
    NEW.is_active            := OLD.is_active;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    -- level + total_rides intentionally NOT reverted (managed by recompute_user_level).
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    NEW.role  := OLD.role;
    NEW.level := OLD.level;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$function$;
