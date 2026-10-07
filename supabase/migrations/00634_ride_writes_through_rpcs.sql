-- 00634: a ride's status, fare and timestamps change only through the ride RPCs.
--
-- The policy r_update lets the rider and the assigned driver UPDATE their ride
-- through PostgREST, and the triggers on rides only partly guard that path.
-- Confirmed in prod on 2026-10-07 with test accounts, rolled back:
--   * the driver set status = 'completed' with final_fare_cup = 1 on a cash
--     ride: completed, no ledger row, so no commission. On a corporate ride
--     handle_corporate_ride_completion would charge the company the fare the
--     driver typed and pay ~85 % of it into the driver's tricicoin;
--   * the driver set driver_arrived_at an hour back and complete_ride_and_pay
--     added 1,840 CUP of waiting time (20 billable minutes x 92) to a 2,000 fare;
--   * the driver moved the ride to arrived_at_pickup with no GPS check, and
--     canceled it without cancel_ride (no reputation event);
--   * the rider set status = 'disputed' in the middle of the ride without
--     opening a dispute, so complete_ride_and_pay can no longer charge it.
-- The FSM trigger cannot tell these raw writes from the RPCs' own, because the
-- RPCs keep the caller's JWT.
--
-- What tells them apart is current_user: inside a SECURITY DEFINER RPC it is
-- the function's owner, and the service role, cron and SQL sessions are other
-- roles. Only a raw PostgREST write from an app reaches the trigger as anon or
-- authenticated. tg_rides_client_write_guard lets such a write change only the
-- columns the apps write directly today (share link, chained rides, fare split)
-- plus one status change: 'completed' -> 'disputed' when the caller has an
-- open dispute on the ride (disputeService.createDispute). Admins keep raw
-- writes. Searched in git back to 2025-12: the last app code that changed a
-- ride's status or fare directly was removed in April 2026 (raw cancel and
-- accept, replaced by cancel_ride and accept_ride_v2).
--
-- A dispute opened during the ride is still recorded, but the ride is no
-- longer frozen in 'disputed': it goes on to complete_ride_and_pay, which
-- charges it. Before this, an admin resolving such a dispute as no_action set
-- it to 'completed' with no charge at all.
--
-- update_ride_status_v2 had EXECUTE for PUBLIC, so anon could call it, and its
-- gate `auth.uid() <> v_driver_user_id` is NULL (not true) when there is no
-- caller or no driver: the probe moved a ride to in_progress as anon. Now it is
-- `IS DISTINCT FROM` and only authenticated and the service role may call it.
--
-- The guard must fire before every other BEFORE UPDATE trigger on rides, which
-- rewrite columns of NEW (coordinates, discounts, insurance premium); a client
-- write would otherwise look like it changed them. Triggers of the same kind
-- fire in name order, and the assertion block checks this one comes first.
-- Rehearsal: supabase/tests/00634/run.sh.

SET lock_timeout = '10s';

-- 1. The guard ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_rides_client_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- The only columns the apps write on a ride directly: the share link, chained
  -- rides and the fare split. Everything else belongs to the ride RPCs.
  c_client_columns CONSTANT text[] := ARRAY[
    'share_token', 'share_token_expires_at', 'next_ride_id', 'is_chained',
    'is_split', 'status', 'updated_at'];
BEGIN
  -- Inside a SECURITY DEFINER RPC current_user is the function's owner, and the
  -- service role, cron and SQL sessions are other roles: only a raw PostgREST
  -- write from an app arrives here as anon or authenticated.
  IF current_user NOT IN ('anon', 'authenticated') OR is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'completed' AND NEW.status = 'disputed'
              AND EXISTS (SELECT 1 FROM ride_disputes d
                          WHERE d.ride_id = NEW.id
                            AND d.opened_by = auth.uid()
                            AND d.status IN ('open', 'under_review', 'escalated'))) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'El estado del viaje solo cambia desde la app: aceptar, llegar, iniciar, terminar o cancelar.',
      DETAIL  = 'ride_status_via_rpc';
  END IF;

  IF (to_jsonb(NEW) - c_client_columns) IS DISTINCT FROM (to_jsonb(OLD) - c_client_columns) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Ese dato del viaje no se puede cambiar desde la app.',
      DETAIL  = 'ride_column_via_rpc';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_rides_client_write_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER rides_client_write_guard
  BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_client_write_guard();

-- Nothing reaches rides through these from PostgREST; TRUNCATE skips RLS.
REVOKE TRUNCATE, TRIGGER ON public.rides FROM anon, authenticated;

-- 2. update_ride_status_v2: NULL-safe gate, no anon ----------------------------
DO $patch$
DECLARE
  c_fn  CONSTANT regprocedure :=
    'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)'::regprocedure;
  c_old CONSTANT text := 'IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN';
  c_new CONSTANT text := 'IF NOT is_admin() AND auth.uid() IS DISTINCT FROM v_driver_user_id THEN';
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = '0127dfedde6c8f7bbb8185a6086a6ae5' THEN
    EXECUTE replace(pg_get_functiondef(c_fn), c_old, c_new);
  ELSIF v_md5 <> '182eeb5721e458b9976c12d7318f09ac' THEN
    RAISE EXCEPTION 'unexpected body of update_ride_status_v2 (md5 %): not patched', v_md5;
  END IF;
END
$patch$;

REVOKE EXECUTE ON FUNCTION public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean)
  TO authenticated, service_role;

-- 3. Pasted from Windows (CRLF), the guard's body would carry \r: recreate it
--    from the catalog without them so its md5 matches git.
DO $crlf$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.tg_rides_client_write_guard()'::regprocedure) INTO v_def;
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

-- 4. Assertions ----------------------------------------------------------------
DO $check$
DECLARE
  c_fn CONSTANT regprocedure :=
    'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)'::regprocedure;
  v_first text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_client_write_guard()'::regprocedure)
     <> 'dadf42ea83ba7ee425208128543162b0' THEN
    RAISE EXCEPTION 'tg_rides_client_write_guard does not have the body of git';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.rides'::regclass AND tgname = 'rides_client_write_guard'
                   AND tgfoid = 'public.tg_rides_client_write_guard()'::regprocedure
                   AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'rides_client_write_guard is missing or disabled';
  END IF;
  -- tgtype bits: 1 = row, 2 = before, 16 = update
  SELECT tgname INTO v_first FROM pg_trigger
  WHERE tgrelid = 'public.rides'::regclass AND NOT tgisinternal
    AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 16) = 16
  ORDER BY tgname COLLATE "C" LIMIT 1;
  IF v_first IS DISTINCT FROM 'rides_client_write_guard' THEN
    RAISE EXCEPTION 'rides_client_write_guard must fire first among BEFORE UPDATE triggers on rides, % fires before it', v_first;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = c_fn) <> '182eeb5721e458b9976c12d7318f09ac' THEN
    RAISE EXCEPTION 'update_ride_status_v2 does not have the patched gate';
  END IF;
  IF has_function_privilege('anon', c_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute update_ride_status_v2';
  END IF;
  IF NOT has_function_privilege('authenticated', c_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost update_ride_status_v2';
  END IF;
END
$check$;

RESET lock_timeout;
