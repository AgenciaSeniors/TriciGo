-- ============================================================
-- 00617 — fare split: declining an invite takes the ride lock, like an invite
--
-- WHY
--   An invite (tg_ride_splits_guard, 00613) locks the ride, counts who is
--   already invited and lowers the other shares to the new equal part. The
--   invitee's decline (00614) was a plain DELETE through RLS, which takes no
--   lock on the ride. When the requester invited someone while another
--   invitee's decline had not committed yet, the invite still counted the one
--   leaving. Measured with two sessions: Ana's ride with Beto and Eva invited;
--   Beto declines while Ana invites Fede. One after the other, Eva and Fede
--   end at 33.33 %; at the same time, they end at 25 % and Ana pays 50 %.
--   Nobody is charged more than they were shown (shares are never raised),
--   but the requester pays a part no order of the two actions would give.
--   A policy cannot lock a row, so the decline needs a function.
--
-- WHAT
--   1. decline_split_invite(p_split_id): the caller's own unanswered, unpaid
--      invite is deleted after locking its ride FOR UPDATE, the lock an invite
--      takes. An invite and a decline of the same ride now run one after the
--      other: the invite counts the declined invitee only if it got the ride
--      first, and then the shares end as that order leaves them. Returns
--      'declined', 'gone' (no such invite of the caller's: never existed,
--      withdrawn, removed when the ride ended, or someone else's),
--      'accepted' (already accepted, paid or not; it stays and is charged) or
--      'kept' (marked paid or in payment without being accepted; it stays).
--      Signed-in users only. It locks the ride and then
--      the split, the order the invite, complete_ride_and_pay and the 00616
--      trigger use, so it cannot deadlock with them.
--   2. split_delete_invitee (00614) is dropped: a decline that skips the lock
--      would reopen the race. The requester's split_delete stays as it is.
--      The apps call the function from this release on (rideService
--      .declineSplitInvite); until this migration is applied they fall back
--      to the old DELETE. No installed mobile build reaches the decline: the
--      invite card only lists invites from the next build on (00616).
--
-- Adds a function and drops a policy. Refuses to replace a function body it
-- did not write. ride_splits had 0 rows when this was written.
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.decline_split_invite(uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '582b8dd95b8774f234c0b5c06797f25c' THEN -- 00617 decline
    RAISE EXCEPTION '00617: unexpected body of decline_split_invite (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.decline_split_invite(p_split_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ride uuid;
  v_accepted timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'decline_split_invite needs a signed-in user';
  END IF;

  SELECT s.ride_id INTO v_ride FROM public.ride_splits s
  WHERE s.id = p_split_id AND s.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;

  -- The lock an invite takes (tg_ride_splits_guard) before it counts the
  -- invitees: an invite of this ride waits for this decline, or this decline
  -- waits for it. Ride first, then the split, like every other writer.
  PERFORM 1 FROM public.rides r WHERE r.id = v_ride FOR UPDATE;

  DELETE FROM public.ride_splits d
  WHERE d.id = p_split_id AND d.user_id = v_uid
    AND d.accepted_at IS NULL
    AND d.paid_at IS NULL
    AND d.payment_status = 'pending';
  IF FOUND THEN
    RETURN 'declined';
  END IF;

  SELECT k.accepted_at INTO v_accepted FROM public.ride_splits k
  WHERE k.id = p_split_id AND k.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN 'gone';
  END IF;
  RETURN CASE WHEN v_accepted IS NOT NULL THEN 'accepted' ELSE 'kept' END;
END;
$function$;

REVOKE ALL ON FUNCTION public.decline_split_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decline_split_invite(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS split_delete_invitee ON public.ride_splits;

-- Assert the end state.
DO $check$
DECLARE
  v_deleters text;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.decline_split_invite(uuid)'::regprocedure) THEN
    RAISE EXCEPTION '00617: decline_split_invite is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.decline_split_invite(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.decline_split_invite(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00617: decline_split_invite must be callable by signed-in users only';
  END IF;
  -- Only the requester's policy may delete a split through RLS.
  SELECT string_agg(polname, ',' ORDER BY polname) INTO v_deleters
  FROM pg_policy
  WHERE polrelid = 'public.ride_splits'::regclass AND polcmd IN ('d', '*');
  IF v_deleters IS DISTINCT FROM 'split_delete' THEN
    RAISE EXCEPTION '00617: the policies that delete splits should be split_delete only, found %', v_deleters;
  END IF;
END
$check$;

RESET lock_timeout;
