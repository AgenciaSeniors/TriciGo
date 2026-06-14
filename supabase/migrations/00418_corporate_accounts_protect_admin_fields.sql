-- 00418_corporate_accounts_protect_admin_fields.sql
-- ============================================================================
-- RLS gap found by the multi-agent audit (2026-06-14): the corp-admin UPDATE
-- policy corporate_accounts_corp_admin_update (mig 00027) has with_check=NULL
-- AND corporate_accounts has NO BEFORE-UPDATE protect trigger (unlike
-- users/driver_profiles which both have one). With with_check NULL Postgres
-- reuses only the USING qual for the post-update check, which re-tests corp-admin
-- membership but does NOT constrain which columns changed. So a corporate
-- employee with role='admin' could UPDATE their own corporate_accounts row to set
-- commission_percent=0, monthly_budget_trc=huge, per_ride_cap_trc=huge,
-- current_month_spent=0, status='active', suspended_at=NULL, is_fleet_owner=true
-- — bypassing platform-set financial governance. Bounded today (0 corporate
-- accounts in prod, corp-admin role is admin/service-seeded), but a real
-- trust-boundary gap that becomes exploitable once corporate goes live.
--
-- Fix: a BEFORE UPDATE protect trigger mirroring tg_driver_profiles_protect_admin_fields.
-- For a non-admin authenticated caller it reverts the platform-governed columns
-- to OLD. is_admin() and service-role (auth.uid() IS NULL) write freely.
--
-- TRUST FLAG (same class as the tier/KPI fixes 00411/00412): current_month_spent
-- is legitimately incremented by handle_corporate_ride_completion — an AFTER
-- UPDATE trigger on rides that runs as the (non-admin) driver who completed the
-- ride. Without a trust flag the protect trigger would revert that increment and
-- corporate spend tracking would silently freeze. So handle_corporate_ride_completion
-- sets app.trusted_corporate_update='1' (transaction-local; PostgREST clients
-- cannot run set_config) right before its UPDATE, and the protect trigger honors
-- that flag ONLY for current_month_spent.
-- ============================================================================

-- 1) Protect trigger: revert platform-governed columns for non-admin self-service.
CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Admins edit governance freely.
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  -- Service-role / system writes (no request JWT) are trusted.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Trusted system path: handle_corporate_ride_completion increments
  -- current_month_spent as the non-admin driver. Honor ONLY that column; keep
  -- every other governed column protected.
  IF current_setting('app.trusted_corporate_update', true) = '1' THEN
    NEW.status              := OLD.status;
    NEW.commission_percent  := OLD.commission_percent;
    NEW.monthly_budget_trc  := OLD.monthly_budget_trc;
    NEW.per_ride_cap_trc    := OLD.per_ride_cap_trc;
    NEW.is_fleet_owner      := OLD.is_fleet_owner;
    NEW.approved_at         := OLD.approved_at;
    NEW.suspended_at        := OLD.suspended_at;
    NEW.suspended_reason    := OLD.suspended_reason;
    NEW.created_by          := OLD.created_by;
    NEW.id                  := OLD.id;
    NEW.created_at          := OLD.created_at;
    -- current_month_spent intentionally NOT reverted (this is the trusted path).
    RETURN NEW;
  END IF;

  -- Corp-admin self-service (non-admin, no trust flag): revert ALL
  -- platform-governed financial/governance columns. Corp-admin may still edit
  -- name, contact_email, contact_phone, tax_id, allowed_hours_*, allowed_service_types.
  NEW.status              := OLD.status;
  NEW.commission_percent  := OLD.commission_percent;
  NEW.monthly_budget_trc  := OLD.monthly_budget_trc;
  NEW.per_ride_cap_trc    := OLD.per_ride_cap_trc;
  NEW.current_month_spent := OLD.current_month_spent;
  NEW.is_fleet_owner      := OLD.is_fleet_owner;
  NEW.approved_at         := OLD.approved_at;
  NEW.suspended_at        := OLD.suspended_at;
  NEW.suspended_reason    := OLD.suspended_reason;
  NEW.created_by          := OLD.created_by;
  NEW.id                  := OLD.id;
  NEW.created_at          := OLD.created_at;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_corporate_accounts_protect_admin_fields ON public.corporate_accounts;
CREATE TRIGGER trg_corporate_accounts_protect_admin_fields
  BEFORE UPDATE ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_accounts_protect_admin_fields();

-- 2) Mark the legitimate system writer as trusted (in-place patch of the live
--    body so no feature is lost). Idempotent + safe on a fresh DB where the
--    function does not exist yet (it is created by an earlier migration).
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.handle_corporate_ride_completion()'::regprocedure) INTO v_src;
  IF v_src IS NOT NULL
     AND position('app.trusted_corporate_update' IN v_src) = 0
     AND position('UPDATE corporate_accounts' IN v_src) > 0 THEN
    v_src := replace(
      v_src,
      'UPDATE corporate_accounts',
      'PERFORM set_config(''app.trusted_corporate_update'', ''1'', true);' || E'\n    UPDATE corporate_accounts'
    );
    EXECUTE v_src;
    RAISE NOTICE 'handle_corporate_ride_completion patched: sets app.trusted_corporate_update before its UPDATE';
  ELSE
    RAISE NOTICE 'handle_corporate_ride_completion already patched or no UPDATE found; skipping';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'handle_corporate_ride_completion absent; skipping (will be created + patched by re-run after its migration)';
END $patch$;
