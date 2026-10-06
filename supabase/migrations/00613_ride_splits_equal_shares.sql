-- ============================================================
-- 00613 — fare split: the server shares the fare equally
--
-- WHY
--   The apps chose each invitee's share themselves: the rider app and the web
--   send 100 / (invitees + 2) for the new invitee and never touch the ones
--   already invited. The shares came out 50, 33.33, 25…: with two invitees
--   the requester paid 16.67 % instead of a third, and since 00612 (shares of
--   a ride cannot add up to more than 100 %) a third invite fails. The apps
--   cannot fix the earlier invites themselves: since 00612 a client may not
--   change a share, and split_update only lets the invitee touch their row.
--
-- WHAT (tg_ride_splits_guard, client INSERT only)
--   An invite now gets floor(100 / n) % with 2 decimals, n = the requester +
--   everyone already invited + the new invitee, whatever share the app sends.
--   Every other split of the ride above that share is lowered to it, accepted
--   or not; the requester's part absorbs the rounding (3 people: 33.33, 33.33,
--   33.34). Shares are never raised: an invitee is never charged more than an
--   amount they were shown, whatever app version showed it. So when the
--   requester withdraws an invite, the others keep their share and the
--   requester pays the freed part. Nothing changes once a split of the ride is
--   paid (complete_ride_and_pay is running or done).
--   The lowering UPDATE runs under app.ride_splits_rebalance, a flag the guard
--   trusts like app.trusted_driver_update; it is set only around that UPDATE
--   and restored right after. The ride stays locked (FOR UPDATE) while the
--   invitees are counted, so two invites at once still end equal.
--   Admins, the service key and complete_ride_and_pay keep full control, as in
--   00612: their inserts keep the share they send.
--
-- Old app builds keep working: they send their own share, the server replaces
-- it, and the requester's "Tu parte" (fare / participants) now matches.
-- Refuses to replace a guard body other than 00612's or its own.
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure;
  IF v_md5 NOT IN ('36862c0b2e4bf9a2d505c6d4de288efa',   -- 00612
                   '43e9014cc1d383d833806df8a4a66500') THEN -- 00613 (this file)
    RAISE EXCEPTION '00613: unexpected body of tg_ride_splits_guard (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.tg_ride_splits_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_trusted boolean;
  v_taken numeric;
  v_share numeric;
  v_prev text;
BEGIN
  -- coalesce: an unset GUC reads as NULL, and NOT NULL would skip the guard.
  -- app.ride_splits_rebalance is set only below, around the UPDATE that
  -- lowers the other shares of the ride.
  v_trusted := v_uid IS NULL
               OR public.is_admin()
               OR coalesce(current_setting('app.trusted_driver_update', true), '') = '1'
               OR coalesce(current_setting('app.ride_splits_rebalance', true), '') = '1';

  IF NOT v_trusted THEN
    IF TG_OP = 'INSERT' THEN
      -- An invite starts unanswered; only the invitee accepts it.
      NEW.accepted_at := NULL;
      NEW.paid_at := NULL;
      NEW.amount_trc := NULL;
      NEW.payment_status := 'pending';
      NEW.invited_by := v_uid;

      -- Equal parts for the requester, everyone invited and the new invitee.
      -- The ride lock makes concurrent invites count each other.
      PERFORM 1 FROM public.rides WHERE id = NEW.ride_id FOR UPDATE; -- serializes invites
      SELECT floor(10000.0 / (count(*) + 2)) / 100 INTO v_share
      FROM public.ride_splits WHERE ride_id = NEW.ride_id;
      NEW.share_pct := v_share;

      -- Lower, never raise, the other shares; leave a ride that is being paid.
      IF NOT EXISTS (SELECT 1 FROM public.ride_splits
                     WHERE ride_id = NEW.ride_id
                       AND (payment_status <> 'pending' OR paid_at IS NOT NULL)) THEN
        v_prev := current_setting('app.ride_splits_rebalance', true);
        PERFORM set_config('app.ride_splits_rebalance', '1', true);
        UPDATE public.ride_splits SET share_pct = v_share
        WHERE ride_id = NEW.ride_id AND share_pct > v_share;
        PERFORM set_config('app.ride_splits_rebalance', coalesce(v_prev, ''), true);
      END IF;
    ELSE
      -- The invitee may only accept, once. Everything else stays.
      NEW.id := OLD.id;
      NEW.ride_id := OLD.ride_id;
      NEW.user_id := OLD.user_id;
      NEW.invited_by := OLD.invited_by;
      NEW.share_pct := OLD.share_pct;
      NEW.amount_trc := OLD.amount_trc;
      NEW.payment_status := OLD.payment_status;
      NEW.paid_at := OLD.paid_at;
      NEW.created_at := OLD.created_at;
      IF OLD.accepted_at IS NOT NULL THEN
        NEW.accepted_at := OLD.accepted_at;
      ELSIF NEW.accepted_at IS NOT NULL THEN
        NEW.accepted_at := now();
      END IF;
    END IF;
  END IF;

  -- For everyone: the shares of one ride never add up to more than 100%,
  -- or the requester's part of the fare turns negative.
  IF TG_OP = 'INSERT'
     OR NEW.share_pct IS DISTINCT FROM OLD.share_pct
     OR NEW.ride_id IS DISTINCT FROM OLD.ride_id THEN
    PERFORM 1 FROM public.rides WHERE id = NEW.ride_id FOR UPDATE;
    SELECT coalesce(sum(s.share_pct), 0) INTO v_taken
    FROM public.ride_splits s
    WHERE s.ride_id = NEW.ride_id AND s.id IS DISTINCT FROM NEW.id;
    IF v_taken + NEW.share_pct > 100 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('Las partes de este viaje no pueden sumar más del 100%% (ya hay %s%%).', v_taken),
        DETAIL = 'split_over_100';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_ride_splits_guard() FROM PUBLIC, anon, authenticated;

-- Assert the end state: the trigger 00612 created still calls this function.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.ride_splits'::regclass AND t.tgname = 'trg_ride_splits_guard'
      AND NOT t.tgisinternal AND t.tgenabled = 'O'
      AND (t.tgtype & 2) = 2 AND (t.tgtype & 1) = 1 AND (t.tgtype & (4 | 16)) = (4 | 16)
      AND t.tgfoid = 'public.tg_ride_splits_guard()'::regprocedure) THEN
    RAISE EXCEPTION '00613: trg_ride_splits_guard is missing or wrong';
  END IF;
  IF position('app.ride_splits_rebalance' IN
              (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00613: tg_ride_splits_guard was not replaced';
  END IF;
END
$check$;

RESET lock_timeout;
