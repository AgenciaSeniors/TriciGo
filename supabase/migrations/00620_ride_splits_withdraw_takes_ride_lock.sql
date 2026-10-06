-- ============================================================
-- 00620 — fare split: the requester's withdraw takes the ride lock, like an invite
--
-- WHY
--   The requester withdraws an invite with a plain DELETE through RLS
--   (split_delete, 00031), which takes no lock on the ride:
--   1. An invite (tg_ride_splits_guard, 00613) locks the ride, counts who is
--      invited and lowers the other shares to the new equal part. An invite
--      sent while a withdraw had not committed yet still counted the invitee
--      being withdrawn: the shares ended as if the invite had come first,
--      though the withdraw went first. Measured with two sessions: Ana's ride
--      with Beto and Eva invited; Ana withdraws Beto while she invites Fede
--      (two devices). Withdraw and then invite leaves Eva and Fede at
--      33.33 %; at the same time they ended at 25 % and Ana paid 50 %.
--   2. The policy reads the ride's status in the snapshot the DELETE started
--      with. A withdraw that ran while the driver's start of the trip was
--      committing deleted the invite, though the trip had already started.
--   Both windows last as long as one request takes to commit. A wider one:
--   the apps cleared rides.is_split when the last invite was gone, reading
--   and writing in two more requests, while an invite reads is_split and
--   inserts in two requests of its own. An invite sent meanwhile could end
--   on a ride with is_split = false, and complete_ride_and_pay charges the
--   invitees only when is_split is true: the requester pays everything,
--   having been shown less.
--
-- WHAT
--   1. withdraw_split_invite(p_split_id): locks the caller's ride FOR UPDATE,
--      the lock an invite takes, then checks that the trip has not started
--      (searching, accepted, driver_en_route or arrived_at_pickup, the
--      statuses split_delete allows) and deletes the invite if it is not paid
--      or being paid. Accepted invites can still be withdrawn before pickup,
--      as split_delete allows. Returns 'withdrawn', 'gone' (no such invite on
--      a ride of the caller's: never existed, declined, already withdrawn,
--      removed when the ride ended, or someone else's), 'too_late' (the trip
--      started or ended; the invite stays) or 'kept' (marked paid or in
--      payment; it stays). Signed-in users only. It locks the ride and then
--      the split, the order every other writer uses.
--   2. rides.is_split is left alone: once a ride was split it stays split.
--      complete_ride_and_pay moves the same money for a split ride with no
--      accepted invite (the requester pays fare minus 0), and a decline
--      already leaves it that way. The apps stop clearing it from this
--      release on (rideService.removeSplitInvite).
--   split_delete stays: the installed mobile builds withdraw with a direct
--   DELETE, and dropping it would make their "Quitar" answer OK and delete
--   nothing. Drop it once those builds are gone.
--
-- Adds a function. Refuses to replace a function body it did not write.
-- ride_splits had 0 rows when this was written.
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.withdraw_split_invite(uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '6359b3ecf78bc8c348ee8546ef52456c' THEN -- 00620 withdraw
    RAISE EXCEPTION '00620: unexpected body of withdraw_split_invite (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.withdraw_split_invite(p_split_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ride uuid;
  v_status public.ride_status;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'withdraw_split_invite needs a signed-in user';
  END IF;

  SELECT s.ride_id INTO v_ride
  FROM public.ride_splits s JOIN public.rides r ON r.id = s.ride_id
  WHERE s.id = p_split_id AND r.customer_id = v_uid;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  -- The lock an invite takes (tg_ride_splits_guard) before it counts the
  -- invitees: an invite of this ride waits for this withdraw, or this
  -- withdraw waits for it. The locked row is the latest one, so the status
  -- below is the ride's current status. Ride first, then the split.
  SELECT r.status INTO v_status FROM public.rides r
  WHERE r.id = v_ride AND r.customer_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  IF v_status NOT IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup') THEN
    RETURN 'too_late';
  END IF;

  DELETE FROM public.ride_splits d
  WHERE d.id = p_split_id AND d.ride_id = v_ride
    AND d.paid_at IS NULL
    AND d.payment_status = 'pending';
  IF FOUND THEN
    RETURN 'withdrawn';
  END IF;

  PERFORM 1 FROM public.ride_splits k WHERE k.id = p_split_id AND k.ride_id = v_ride;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  RETURN 'kept';
END;
$function$;

REVOKE ALL ON FUNCTION public.withdraw_split_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_split_invite(uuid) TO authenticated, service_role;

-- Assert the end state.
DO $check$
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.withdraw_split_invite(uuid)'::regprocedure) THEN
    RAISE EXCEPTION '00620: withdraw_split_invite is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.withdraw_split_invite(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.withdraw_split_invite(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00620: withdraw_split_invite must be callable by signed-in users only';
  END IF;
END
$check$;

RESET lock_timeout;
