-- ============================================================
-- 00616 — fare split: the invitee sees their invites, and only while the ride is on
--
-- WHY
--   The invitee's "Te invitaron a dividir" card (rider app SplitInviteCard,
--   web SplitInviteBanner) never showed anything. getMySplitInvites read
--   ride_splits with the ride embedded as rides!inner(...), and the rides
--   policies only let the customer, the driver and admins read a ride: for the
--   invitee every ride was invisible, so the inner join dropped every invite
--   (checked in prod as an invitee, in a rolled-back block: 1 split row, 0
--   rows with the ride joined). Nobody could accept or decline a split.
--   The query also had no filter on the ride, and nothing ever removed an
--   invite nobody answered: once readable, invites of rides completed or
--   canceled long ago would show forever, with Aceptar and Rechazar buttons
--   that no longer mean anything. complete_ride_and_pay charges the accepted
--   splits once, when the ride completes, so an invite accepted afterwards is
--   never charged.
--
-- WHAT
--   1. get_my_split_invites(): the caller's unanswered, unpaid invites of
--      rides still in progress, with only what the card shows: share, who
--      invited them, the ride's status, pickup and dropoff addresses and
--      estimated fare. SECURITY DEFINER, so the invitee reads those fields
--      without any access to the rides table. Signed-in users only.
--   2. When a ride reaches completed, canceled or disputed, its unanswered,
--      unpaid invites (accepted_at, paid_at NULL, payment_status 'pending')
--      are deleted. Accepted and paid splits stay: they are the record of who
--      paid. No money moves: payment only reads accepted splits, and the
--      requester already pays the unanswered parts. One trigger covers every
--      path that ends a ride (complete_ride_and_pay, cancel_ride,
--      admin_cancel_ride, the searching-ride crons, disputes…). It never
--      blocks the ride: a failure, or waiting more than 2 s for an invite the
--      invitee is accepting at that moment, leaves a WARNING and the invite in
--      place (get_my_split_invites hides it anyway).
--   The apps call get_my_split_invites from the next build on; until then
--   the card keeps showing nothing, as it always did.
--
-- Adds two functions and a trigger, drops nothing. Refuses to replace a
-- function body it did not write. ride_splits had 0 rows when this was
-- written, so there is nothing to clean up from before.
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.tg_rides_drop_unanswered_split_invites()');
  IF v_md5 IS NOT NULL AND v_md5 <> 'f48cba229ecd02f0caf219f69650b1bb' THEN -- 00616 trigger
    RAISE EXCEPTION '00616: unexpected body of tg_rides_drop_unanswered_split_invites (md5 %), not replacing it', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.get_my_split_invites()');
  IF v_md5 IS NOT NULL AND v_md5 <> '5f2b71ad0929ad378d5a3cf39c0b033b' THEN -- 00616 invites
    RAISE EXCEPTION '00616: unexpected body of get_my_split_invites (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

-- 1. The invitee's card.
CREATE OR REPLACE FUNCTION public.get_my_split_invites()
 RETURNS TABLE(id uuid, ride_id uuid, share_pct numeric, invited_by uuid, inviter_name text,
               created_at timestamp with time zone, ride_status public.ride_status, pickup_address text,
               dropoff_address text, estimated_fare_trc integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  -- As the owner: rides RLS hides the ride from the invitee. Only these
  -- fields leave the function, and only for the caller's own open invites.
  SELECT s.id, s.ride_id, s.share_pct, s.invited_by,
         CASE WHEN u.is_active THEN u.full_name END,
         s.created_at, r.status, r.pickup_address, r.dropoff_address, r.estimated_fare_trc
  FROM public.ride_splits s
  JOIN public.rides r ON r.id = s.ride_id
  LEFT JOIN public.users u ON u.id = s.invited_by
  WHERE s.user_id = (SELECT auth.uid())
    AND s.accepted_at IS NULL
    AND s.paid_at IS NULL
    AND s.payment_status = 'pending'
    AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                     'in_progress', 'arrived_at_destination')
  ORDER BY s.created_at DESC, s.id
  LIMIT 20;
$function$;

REVOKE ALL ON FUNCTION public.get_my_split_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_split_invites() TO authenticated, service_role;

-- 2. Unanswered invites end with the ride.

CREATE OR REPLACE FUNCTION public.tg_rides_drop_unanswered_split_invites()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
BEGIN
  -- As the table owner: whoever ends the ride (the driver, an admin, a cron)
  -- has no right to delete other people's invites through RLS.
  BEGIN
    DELETE FROM public.ride_splits
    WHERE ride_id = NEW.id
      AND accepted_at IS NULL
      AND paid_at IS NULL
      AND payment_status = 'pending';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00616: unanswered split invites of ride % kept: % %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_rides_drop_unanswered_split_invites() FROM PUBLIC, anon, authenticated;

DO $trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.rides'::regclass
                   AND tgname = 'trg_rides_drop_unanswered_split_invites'
                   AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_rides_drop_unanswered_split_invites
      AFTER UPDATE OF status ON public.rides
      FOR EACH ROW
      WHEN (NEW.status IN ('completed', 'canceled', 'disputed')
            AND OLD.status NOT IN ('completed', 'canceled', 'disputed'))
      EXECUTE FUNCTION public.tg_rides_drop_unanswered_split_invites();
  END IF;
END
$trigger$;

-- Assert the end state, whatever created the trigger.
DO $check$
DECLARE
  v_def text;
  v_path text := current_setting('search_path');
BEGIN
  -- pg_get_triggerdef qualifies names by the search_path: compare under a fixed one.
  PERFORM set_config('search_path', 'public', true);
  SELECT pg_get_triggerdef(t.oid) INTO v_def
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.rides'::regclass
    AND t.tgname = 'trg_rides_drop_unanswered_split_invites'
    AND NOT t.tgisinternal AND t.tgenabled = 'O';
  IF v_def IS DISTINCT FROM
     'CREATE TRIGGER trg_rides_drop_unanswered_split_invites AFTER UPDATE OF status ON public.rides '
     || 'FOR EACH ROW WHEN (((new.status = ANY (ARRAY[''completed''::ride_status, ''canceled''::ride_status, '
     || '''disputed''::ride_status])) AND (old.status <> ALL (ARRAY[''completed''::ride_status, '
     || '''canceled''::ride_status, ''disputed''::ride_status])))) '
     || 'EXECUTE FUNCTION tg_rides_drop_unanswered_split_invites()' THEN
    PERFORM set_config('search_path', v_path, true);
    RAISE EXCEPTION '00616: trg_rides_drop_unanswered_split_invites is missing or different: %', v_def;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid = 'public.tg_rides_drop_unanswered_split_invites()'::regprocedure) THEN
    RAISE EXCEPTION '00616: tg_rides_drop_unanswered_split_invites is not SECURITY DEFINER';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid = 'public.get_my_split_invites()'::regprocedure) THEN
    RAISE EXCEPTION '00616: get_my_split_invites is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.get_my_split_invites()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_my_split_invites()', 'EXECUTE') THEN
    RAISE EXCEPTION '00616: get_my_split_invites must be callable by signed-in users only';
  END IF;
  PERFORM set_config('search_path', v_path, true);
END
$check$;

RESET lock_timeout;
