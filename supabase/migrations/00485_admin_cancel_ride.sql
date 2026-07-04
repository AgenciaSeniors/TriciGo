-- 00485: admin can cancel any active ride from the panel (incl. in_progress).
--
-- Review 2026-07-04: today NO ONE can cancel an `in_progress` ride —
-- `valid_transitions` has no in_progress→canceled row, the client hides its
-- cancel button, and the admin panel exposes zero cancellation capability
-- (admin.service has no method). A stuck ride (e.g. Dariel Acosta Hernández's,
-- cancelled by hand via SQL) could only be fixed by a manual UPDATE as postgres.
--
-- Fix: a dedicated admin RPC that cancels any active ride WITHOUT touching
-- either party's reputation (no cancellation_rating_events row) and WITHOUT
-- moving money (an in_progress ride never charged — complete_ride_and_pay does).
-- The user-facing cancel_ride RPC stays untouched (it gates to customer/driver
-- and applies the reputational penalty).
--
-- Two pieces:
--   1. Open the FSM for admins only: add in_progress→canceled and
--      arrived_at_destination→canceled for {admin, super_admin}. This does NOT
--      let customers/drivers cancel those states — their role isn't in the
--      allowed_roles array. The other active states already list admin roles.
--   2. admin_cancel_ride(uuid, text): is_admin()-gated, supersedes pending
--      offers, audits into admin_actions. The internal UPDATE fires
--      enforce_ride_transition with the admin's auth.uid() (SECURITY DEFINER
--      does NOT change auth.uid()), which now passes thanks to (1);
--      enforce_ride_update_columns returns early for is_admin().

-- 1. Open the FSM to admin/super_admin for the two missing active states.
--    Idempotent: union roles if the row already exists.
INSERT INTO valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('in_progress',            'canceled', ARRAY['admin','super_admin']::user_role[]),
  ('arrived_at_destination', 'canceled', ARRAY['admin','super_admin']::user_role[])
ON CONFLICT (from_status, to_status)
DO UPDATE SET allowed_roles = (
  SELECT ARRAY(
    SELECT DISTINCT unnest(valid_transitions.allowed_roles || EXCLUDED.allowed_roles)
  )
);

-- 2. admin_cancel_ride — cancel any active ride, no reputation hit, audited.
CREATE OR REPLACE FUNCTION public.admin_cancel_ride(
  p_ride_id uuid,
  p_reason  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_ride  rides%ROWTYPE;
BEGIN
  -- auth.uid() is still the caller's uid inside a SECURITY DEFINER function.
  IF NOT is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  IF v_ride.status IN ('completed', 'canceled') THEN
    RETURN jsonb_build_object('error', 'ride_already_closed', 'status', v_ride.status);
  END IF;

  -- Fires enforce_ride_transition (role=admin, now valid via step 1) and
  -- enforce_ride_update_columns (returns early for is_admin()).
  -- Deliberately NO cancellation_rating_events insert → neither party's
  -- rating_avg changes. Deliberately NO wallet/ledger touch → no money moved.
  UPDATE rides SET
    status              = 'canceled',
    canceled_at         = now(),
    canceled_by         = v_admin,
    cancellation_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'admin_cancel')
  WHERE id = p_ride_id;

  -- Release any pending offers so drivers stop seeing this ride.
  UPDATE ride_offers SET status = 'superseded', responded_at = now()
  WHERE ride_id = p_ride_id AND status = 'pending';

  -- Audit trail.
  INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (
    v_admin, 'cancel_ride', 'ride', p_ride_id::text,
    jsonb_build_object('status', v_ride.status),
    jsonb_build_object('status', 'canceled'),
    p_reason
  );

  RETURN jsonb_build_object(
    'success',         true,
    'ride_id',         p_ride_id,
    'previous_status', v_ride.status
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_cancel_ride(uuid, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_cancel_ride(uuid, text) TO authenticated;
