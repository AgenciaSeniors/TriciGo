-- ============================================================
-- DRV-002 (security audit 2026-05-23, Driver fraud kill chain):
-- tg_driver_profiles_protect_admin_fields (BUG-134 / migration 00191)
-- blinds 18 sensitive fields against direct UPDATEs by the driver
-- (status, identity_number, criminal_record, rating, etc.) BUT does
-- not include two fields that are exploitable today:
--
--   1. custom_per_km_rate_cup — read by accept_ride_v2 (00142:146)
--      as `v_custom_rate`, used as the driver's contractual per-km
--      rate winning over the service default. Persisted into
--      rides.driver_custom_rate_cup, then read by complete_ride_and_pay
--      (00282:138) as the canonical per-km rate for the final fare.
--      An attacker can:
--        supabase.from('driver_profiles')
--          .update({custom_per_km_rate_cup: 9999})
--          .eq('user_id', auth.uid());
--      then accept a normal-priced ride, and at completion the rider
--      pays 9999 CUP/km. The rider saw the service-default estimate
--      at request time, but the post-accept update of estimated_fare
--      shows the inflated number — most riders are committed by then.
--      The trigger MUST treat this field as admin-only.
--
--   2. is_online — currently allowed to toggle freely. The dispatch
--      loop (trg_dispatch_on_driver_online) fires on any is_online =
--      true transition. Combined with DRV-001 (no status check in
--      accept_ride_v2 — fixed in 00287), a pending/suspended/rejected
--      driver can go online and receive offers. 00287 closes the
--      accept side; this migration closes the upstream by rejecting
--      the toggle when status != 'approved'.
--      (Going OFFLINE is still allowed unconditionally so a suspended
--      driver who was previously online can be force-offlined cleanly.)
--
-- Why is_online uses RAISE not OLD/NEW pinning: rejecting loudly
-- surfaces the issue to the client, which lets the UI display a
-- clear "Account not approved" message instead of silently keeping
-- the toggle off (which a client could interpret as a network bug).
-- Telemetry path stays the same — Postgres logs the EXCEPTION with
-- caller's auth.uid().
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Admin bypass — keeps existing admin tooling working.
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  -- Service role / system updates run as 'postgres' or via SECURITY
  -- DEFINER functions; auth.uid() returns NULL in those contexts and
  -- is_admin() above would already have allowed it. Belt-and-suspenders:
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- DRV-002a: is_online gate. Allow toggling OFFLINE unconditionally
  -- (so admins / system processes that force a driver offline work
  -- via this path too). Reject going ONLINE unless status='approved'.
  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved' THEN
    RAISE EXCEPTION 'driver_not_approved_for_online: status=% — cannot go online until approved by admin',
      OLD.status;
  END IF;

  -- For everyone else (drivers updating their own row), pin the
  -- admin-controlled and system-controlled fields to OLD values.
  NEW.status                  := OLD.status;
  NEW.is_financially_eligible := OLD.is_financially_eligible;
  NEW.negative_balance_since  := OLD.negative_balance_since;
  NEW.match_score             := OLD.match_score;
  NEW.acceptance_rate         := OLD.acceptance_rate;
  NEW.total_rides             := OLD.total_rides;
  NEW.total_rides_completed   := OLD.total_rides_completed;
  NEW.total_rides_offered     := OLD.total_rides_offered;
  NEW.rating_avg              := OLD.rating_avg;
  NEW.approved_at             := OLD.approved_at;
  NEW.suspended_at            := OLD.suspended_at;
  NEW.suspended_reason        := OLD.suspended_reason;
  NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
  NEW.quota_blocked           := OLD.quota_blocked;
  NEW.identity_number         := OLD.identity_number;
  NEW.has_criminal_record     := OLD.has_criminal_record;
  NEW.criminal_record_details := OLD.criminal_record_details;
  NEW.user_id                 := OLD.user_id;
  NEW.id                      := OLD.id;
  NEW.created_at              := OLD.created_at;
  -- DRV-002b: custom_per_km_rate_cup is contractual pricing and must
  -- be admin-set. If the driver's UI ever needs to propose a rate,
  -- expose it via an admin-approved workflow (e.g. a column like
  -- `custom_per_km_rate_pending` + admin RPC to promote).
  NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;

  RETURN NEW;
END;
$$;

-- Trigger definition unchanged from 00191; re-declare for completeness.
DROP TRIGGER IF EXISTS trg_driver_profiles_protect_admin_fields ON public.driver_profiles;

CREATE TRIGGER trg_driver_profiles_protect_admin_fields
  BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_driver_profiles_protect_admin_fields();

COMMENT ON TRIGGER trg_driver_profiles_protect_admin_fields ON public.driver_profiles IS
  'BUG-134 + DRV-002: blocks non-admin callers from changing status, KYC, financial-gate, scoring, audit, AND custom_per_km_rate_cup fields on their own driver_profiles row. is_online -> true requires status=approved.';
