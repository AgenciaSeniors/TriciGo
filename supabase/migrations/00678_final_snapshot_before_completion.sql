-- ============================================================
-- 00678 - A company ride pays what the app shows
-- ============================================================
--
-- When a company has a commission of its own (corporate_accounts.commission_percent, which the
-- panel takes from 0 to 15 %), the driver and the platform were paid amounts different from the
-- ones the driver app shows. With 5 % on a 2.381 CUP ride, complete_ride_and_pay answered
-- driver 2.024 and commission 119, and the ledger paid 2.036 and 107 (QA 2026-11-05, error 2).
-- The company paid the right total; the split between driver and platform was off.
--
-- Why: complete_ride_and_pay marks the ride completed (UPDATE rides) and only then writes the
-- 'final' pricing snapshot. handle_corporate_ride_completion is an AFTER UPDATE row trigger on
-- rides, so it fires inside that UPDATE, finds no final snapshot, and works the commission out
-- again from commission_percent, on a fare complete_ride_and_pay had already lowered by the
-- discount. With the snapshot in place it takes the commission complete_ride_and_pay computed,
-- and pays the driver final fare minus that: the same numbers the app shows.
--
-- The fix moves the snapshot insert above the UPDATE. Every value it writes is computed before
-- the UPDATE, and the UPDATE and the distance check between them change none. No trigger reads
-- or writes ride_pricing_snapshots, and handle_corporate_ride_completion is the only trigger
-- that reads the final snapshot. handle_corporate_ride_completion itself does not change.
--
-- What it does not change: a corporate ride completed without complete_ride_and_pay (a direct
-- UPDATE) still has no final snapshot and keeps the old fallback. Every app and panel path goes
-- through complete_ride_and_pay (admin_complete_active_ride included). Prod has 0 companies with
-- a commission of their own, so no past ride was paid wrong.
--
-- Patched in place from the live body (pg_get_functiondef), behind its md5: a body that changed
-- since this was written makes the migration refuse instead of overwriting it. Re-running it is
-- a no-op. The moved text is built from one-line literals, so a copy pasted with carriage
-- returns patches the same bytes. No DROP and no DELETE.

CREATE OR REPLACE FUNCTION pg_temp.m00678_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
                                               p_olds text[], p_news text[])
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_md5 text;
  v_def text;
  i integer;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00678: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00678: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 IS DISTINCT FROM p_new_md5 THEN
    RAISE EXCEPTION '00678: % came out with md5 %, expected %', p_fn, v_md5, p_new_md5;
  END IF;
END
$function$;

DO $patch$
DECLARE
  -- The final snapshot insert, as it is in the live body.
  c_snapshot CONSTANT text := array_to_string(ARRAY[
    '  INSERT INTO ride_pricing_snapshots (',
    '    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,',
    '    distance_m, duration_s, surge_multiplier, subtotal,',
    '    commission_rate, commission_amount, total, pricing_rule_id,',
    '    exchange_rate_usd_cup, total_trc,',
    '    min_fare, corporate_commission_rate, default_commission_rate_snapshot',
    '  ) VALUES (',
    '    p_ride_id, ''final'', v_eff_base_fare, v_eff_per_km,',
    '    v_eff_per_min, v_chargeable_distance_m, p_actual_duration_s,',
    '    v_surge, v_fare, v_commission_rate, v_commission_amount, v_final_fare, v_eff_pricing_rule,',
    '    v_exchange_rate, v_final_fare_trc,',
    '    v_eff_min_fare, v_corp_commission_rate, v_default_commission_rate',
    '  );'], chr(10));
  -- The start of the UPDATE that marks the ride completed.
  c_complete CONSTANT text := array_to_string(ARRAY[
    '  UPDATE rides SET',
    '    status = ''completed'','], chr(10));
  c_comment CONSTANT text := array_to_string(ARRAY[
    '  -- 00678: the final snapshot goes in before the ride is marked completed.',
    '  -- handle_corporate_ride_completion fires on that update and takes its',
    '  -- commission from this snapshot. Written after it, the snapshot was never',
    '  -- there and the trigger worked the commission out on its own.'], chr(10));
BEGIN
  PERFORM pg_temp.m00678_patch('public.complete_ride_and_pay(uuid,uuid,integer,integer)',
    '62298c877be639dbf69545f3c70d654e', '40bdf6f4b152c317d4b0f199f3115d94',
    ARRAY[c_snapshot || chr(10) || chr(10),
          c_complete],
    ARRAY['',
          c_comment || chr(10) || c_snapshot || chr(10) || chr(10) || c_complete]);
END
$patch$;

-- Self-check: the snapshot goes in first, nothing else of the function moved, and the trigger
-- that reads it is the one this was written against.
DO $check$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE oid = 'public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure;
  IF md5(v_src) <> '40bdf6f4b152c317d4b0f199f3115d94' THEN
    RAISE EXCEPTION '00678: complete_ride_and_pay has md5 %', md5(v_src);
  END IF;
  IF position('INSERT INTO ride_pricing_snapshots' IN v_src) > position('UPDATE rides SET' IN v_src) THEN
    RAISE EXCEPTION '00678: the final snapshot still goes in after the ride is completed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.handle_corporate_ride_completion()'::regprocedure)
       <> 'b9aad3bb14cd7a3f25ff0f64a35b2d89' THEN
    RAISE EXCEPTION '00678: handle_corporate_ride_completion changed; check it still reads the final snapshot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.rides'::regclass AND t.tgname = 'trg_corporate_ride_completion'
      AND t.tgfoid = 'public.handle_corporate_ride_completion()'::regprocedure AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION '00678: trg_corporate_ride_completion is not attached as expected';
  END IF;
END
$check$;
