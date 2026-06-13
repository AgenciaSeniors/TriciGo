-- 00409_ride_flow_p3_db_cleanup.sql
-- Ride-flow audit — Fase 3 (P3 limpieza, lado DB). Verified read-only against
-- the LIVE prod objects. Plan: ~/.claude/plans/haz-un-analisis-para-dapper-conway.md
--
--   #10 valid_transitions: completed->disputed missing -> opening a dispute on a
--       completed ride would throw (dispute row inserted, status UPDATE rejected).
--       Latent behind formal_disputes_enabled=false; add it before enabling.
--   #14 Drop the zombie Stripe trigger (provider removed; the 'stripe' enum value
--       stays for back-compat but no ride uses it).
--   #15 Drop the dead driver-cancel scoring trigger: it compared NEW.canceled_by
--       (users.id) to NEW.driver_id (driver_profiles.id) -> never equal -> never
--       fired. Cancellation reputation is now handled by cancel_ride via
--       cancellation_rating_events, so this path is redundant.
--   #16 Make the completion-fired scoring/audit triggers defensive so a failure
--       there can never roll back ride completion (the email/SMS/push triggers
--       were already defensive; these were not).

-- ============================================================================
-- #10 — Allow completed -> disputed (dispute button is shown on completed rides).
-- ============================================================================
DELETE FROM valid_transitions
 WHERE from_status = 'completed' AND to_status = 'disputed';
INSERT INTO valid_transitions (from_status, to_status, allowed_roles)
VALUES ('completed', 'disputed',
        ARRAY['customer','driver','admin','super_admin']::user_role[]);

-- ============================================================================
-- #14 — Drop the zombie Stripe payment-status trigger + its function.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_ride_stripe_payment_status ON public.rides;
DROP FUNCTION IF EXISTS public.set_ride_payment_status_for_stripe();

-- ============================================================================
-- #15 — Drop the dead driver-cancel scoring trigger + its function.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_ride_canceled_score ON public.rides;
DROP FUNCTION IF EXISTS public.trg_ride_canceled_score();

-- ============================================================================
-- #16 — Defensive scoring/audit on completion.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_ride_completed_score()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_user_id UUID;
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' AND NEW.driver_id IS NOT NULL THEN
    -- rides.driver_id is driver_profiles.id, but update_driver_score expects users.id
    SELECT user_id INTO v_user_id FROM driver_profiles WHERE id = NEW.driver_id;
    IF v_user_id IS NOT NULL THEN
      PERFORM update_driver_score(v_user_id, 'ride_completed',
        jsonb_build_object('ride_id', NEW.id));
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 00409: driver scoring must never roll back ride completion.
  RAISE WARNING 'trg_ride_completed_score failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO audit_log (table_name, record_id, operation, old_values, new_values, changed_by)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id::TEXT, OLD.id::TEXT),
    TG_OP,
    CASE WHEN TG_OP IN ('DELETE', 'UPDATE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- 00409: an audit-log failure must never roll back the underlying operation.
  RAISE WARNING 'record_audit failed for %.%: % %',
    TG_TABLE_NAME, COALESCE(NEW.id::TEXT, OLD.id::TEXT), SQLSTATE, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
