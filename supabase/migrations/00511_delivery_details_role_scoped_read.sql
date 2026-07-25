-- 00511: The driver cannot read the shipment — and the naive fix leaks the
--        proof-of-delivery code. Both are closed here, together, on purpose.
--
-- BUG 1 — the driver reads nothing.
-- The live SELECT policy on delivery_details says:
--     rides.driver_id = auth.uid()
-- but rides.driver_id references driver_profiles(id), NOT users(id). Those are
-- different id spaces, so the disjunct is dead: no driver has ever matched it.
-- Consequence: DeliveryDetailsCard in the driver app renders empty — no
-- recipient name, no phone to call, no special instructions. The driver arrives
-- with a package and does not know who to hand it to.
--
-- The proof this is a bug and not a policy decision: the UPDATE policy on the
-- SAME table (00084, corrected by 00104) already uses the right form —
--     rides.driver_id = (SELECT id FROM driver_profiles WHERE user_id = auth.uid())
-- The two policies disagree about what driver_id means. One of them is wrong.
--
-- BUG 2 — why we cannot simply fix the policy.
-- deliveryService.getDeliveryDetails does `.select('*')`, and delivery_details
-- holds delivery_otp: the 4-digit code the RECIPIENT dictates to the driver at
-- drop-off. Widen the SELECT policy to include the driver and the driver reads
-- the code off their own screen. That defeats the entire proof-of-delivery
-- model — trg_rides_require_delivery_proof (00438) and the +5% cargo bonus
-- (00419) both exist to enforce that the driver could only have obtained the
-- code by actually meeting the recipient.
--
-- THE SHAPE OF THE FIX
-- Two reading paths, split by what each role is allowed to see:
--   * the TABLE stays the "with OTP" path — customer and admin only;
--   * a SECURITY DEFINER RPC with an explicit column list serves all three
--     roles and returns delivery_otp as NULL to the driver.
-- The driver never regains direct table access. If someone later writes
-- `.select('*')` in the driver app, RLS returns zero rows rather than quietly
-- handing over the code — the failure is loud and safe, not silent and unsafe.
--
-- Why RETURNS TABLE with columns spelled out instead of a view with column
-- grants: PostgREST honours column privileges, but then the driver's
-- `select('*')` ERRORS ("permission denied for column delivery_otp") instead of
-- degrading; and since the customer legitimately needs the OTP, one view cannot
-- serve both roles — it would take two objects and two read paths in the
-- service. The explicit signature is also fail-closed by construction: a column
-- added to the table tomorrow is not exposed until someone adds it here.

-- ── Role-scoped read ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_delivery_details_for_ride(p_ride_id UUID)
RETURNS TABLE (
  id                        UUID,
  ride_id                   UUID,
  package_description       TEXT,
  recipient_name            TEXT,
  recipient_phone           TEXT,
  estimated_weight_kg       NUMERIC,
  special_instructions      TEXT,
  package_category          TEXT,
  package_length_cm         INTEGER,
  package_width_cm          INTEGER,
  package_height_cm         INTEGER,
  client_accompanies        BOOLEAN,
  delivery_vehicle_type     TEXT,
  pickup_photo_url          TEXT,
  delivery_photo_url        TEXT,
  delivery_otp              TEXT,
  delivery_otp_validated_at TIMESTAMPTZ,
  created_at                TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_id  UUID;
  v_driver_id    UUID;
  v_is_customer  BOOLEAN := false;
  v_is_driver    BOOLEAN := false;
  v_is_admin     BOOLEAN := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  SELECT r.customer_id, r.driver_id INTO v_customer_id, v_driver_id
  FROM rides r WHERE r.id = p_ride_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- COALESCE on every predicate is load-bearing, not defensive noise. Without
  -- it this gate fails OPEN, and it was caught by exactly that: a caller with
  -- no driver_profiles row makes the sub-select NULL, so `v_driver_id = NULL`
  -- yields NULL rather than false; then `NOT (false OR NULL OR false)` is NULL,
  -- the deny branch never runs, and the function falls through to RETURN QUERY
  -- handing the shipment to a stranger. Three-valued logic turns a deny-by-
  -- default check into an allow-by-accident one.
  v_is_customer := COALESCE(v_customer_id = auth.uid(), false);

  -- The correct comparison: rides.driver_id is a driver_profiles.id.
  IF NOT v_is_customer AND v_driver_id IS NOT NULL THEN
    v_is_driver := COALESCE(v_driver_id = (
      SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid()
    ), false);
  END IF;

  IF NOT v_is_customer AND NOT v_is_driver THEN
    v_is_admin := COALESCE(is_admin(), false);
  END IF;

  -- Return zero rows rather than raising: an unrelated caller learns nothing
  -- about whether the ride exists, and the TS side maps [] to null exactly the
  -- way `.maybeSingle()` already did.
  IF NOT (v_is_customer OR v_is_driver OR v_is_admin) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    dd.id,
    dd.ride_id,
    dd.package_description,
    dd.recipient_name,
    dd.recipient_phone,
    dd.estimated_weight_kg,
    dd.special_instructions,
    dd.package_category,
    dd.package_length_cm,
    dd.package_width_cm,
    dd.package_height_cm,
    dd.client_accompanies,
    dd.delivery_vehicle_type,
    dd.pickup_photo_url,
    dd.delivery_photo_url,
    -- The whole point of this migration: the driver must obtain this code from
    -- the recipient's mouth, never from their own screen.
    CASE WHEN v_is_customer OR v_is_admin THEN dd.delivery_otp ELSE NULL END,
    dd.delivery_otp_validated_at,
    dd.created_at
  FROM delivery_details dd
  WHERE dd.ride_id = p_ride_id;
END;
$function$;

COMMENT ON FUNCTION public.get_delivery_details_for_ride(UUID) IS
  '00511: role-scoped read of delivery_details. Customer and admin see delivery_otp; '
  'the assigned driver sees every other column but gets NULL for the OTP (they must '
  'get it from the recipient at drop-off — see trg_rides_require_delivery_proof, 00438). '
  'Anyone else gets zero rows.';

REVOKE ALL ON FUNCTION public.get_delivery_details_for_ride(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_delivery_details_for_ride(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_delivery_details_for_ride(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_delivery_details_for_ride(UUID) TO service_role;

-- ── Table SELECT: customer + admin only ──────────────────────────────────────
-- Drops the dead `rides.driver_id = auth.uid()` disjunct rather than repairing
-- it. The driver's read now goes exclusively through the RPC above, so direct
-- table access can never expose the OTP.
--
-- NOT touched: the UPDATE policy "Driver updates delivery photo" (00084/00104)
-- already uses the correct driver_profiles lookup and the driver still needs it
-- to record photos.
DROP POLICY IF EXISTS "Ride participants read delivery" ON public.delivery_details;

CREATE POLICY "Rider and admin read delivery" ON public.delivery_details
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = delivery_details.ride_id
        AND r.customer_id = auth.uid()
    )
    OR is_admin()
  );
