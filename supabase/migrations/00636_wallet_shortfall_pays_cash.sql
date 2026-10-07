-- 00636: a wallet-paid ride whose payers can no longer cover the fare is paid
-- as far as the wallets go and the rest in cash; trip insurance is priced only
-- with its feature flag on.
--
-- complete_ride_and_pay debits the rider's customer_cash for a TriciCoin ride
-- without checking the balance, and the CHECK
-- wallet_accounts_customer_balance_non_negative then aborts the completion:
-- the ride stays in_progress, and the driver app retries three times and shows
-- the raw database error. Confirmed in prod on 2026-10-07 with test accounts,
-- rolled back: the rider gifted almost the whole balance during the ride and
-- the completion failed with 23514. Nothing holds the balance while the ride
-- runs, so it can also fall short through the waiting charge, a stop added
-- during the ride, or, on a fare split, a participant who empties the wallet.
--
-- Now:
--   * a TriciCoin ride without a split whose rider cannot cover the fare plus
--     the insurance premium is completed as a mixed ride with wallet_ratio 1:
--     the wallet pays what it holds and the driver collects the rest in cash.
--     payment_method becomes 'mixed', which the rider app, the web, the
--     receipts and the admin already show as "X TriciCoin + Y efectivo", and
--     the driver's tricicoin gets the wallet part minus the commission, as on
--     any mixed ride;
--   * on a split ride every payer (each participant, then the requester) pays
--     from the wallet what it holds, up to its share, and the rest is cash; the
--     ride is marked mixed the same way and the driver's credit drops by the
--     cash part. No wallet pays more than its share. While the wallets cover
--     everything, both paths run exactly as before (v_cash_amount stays NULL in
--     the TriciCoin branch unless a payer falls short);
--   * the mixed branch locks the rider's wallet row before reading it (a gift
--     in flight could otherwise drive it negative) and leaves room for the
--     insurance premium when it caps the wallet part;
--   * enforce_ride_update_columns rejects any payment_method change made with
--     a user's JWT, the RPC's own included (it is SECURITY DEFINER, so it
--     cannot tell them apart). It now lets 'tricicoin' become 'mixed' on a
--     completed ride while complete_ride_and_pay holds the transaction flag
--     app.ride_payment_to_mixed, which it raises only around that UPDATE.
--     A raw client write still cannot touch payment_method: 00634 rejects it
--     before this trigger runs.
--
-- Trip insurance: the apps offer it only with the feature flag
-- trip_insurance_enabled on, and that flag does not exist, but
-- tg_rides_validate_insurance priced insurance_selected = true from any client.
-- On a cash ride complete_ride_and_pay then takes the premium from the
-- driver's tricicoin (probe: the driver lost 400 on a 2,000 ride, commission
-- 300 + premium 100). Insurance is now priced only with the flag on; without
-- it the ride is stored with insurance_selected = false and no premium. No ride
-- has ever selected insurance. Before turning the flag on, decide who pays the
-- premium on a cash ride, and on a wallet ride whose payer cannot cover even
-- the premium: that debit still fails on the balance CHECK (a TriciCoin ride
-- now reserves room for it in the wallet, a split ride does not).
--
-- Rehearsal: in prod inside a rolled-back block, eleven rides completed before
-- and after the patch, with the ledger checked against every balance (see the
-- PR). Before: five of them fail with 23514. After: all eleven complete, and
-- the four without insurance that already completed end exactly as before.

SET lock_timeout = '10s';

-- 1. complete_ride_and_pay -----------------------------------------------------
DO $patch$
DECLARE
  c_fn  CONSTANT regprocedure := 'public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure;
  c_old_md5 CONSTANT text := '3f7746b2603fedae3cd3d0d84073233e';
  c_new_md5 CONSTANT text := 'dc8ddf9007b362ec0629d32a16d94920';
  -- {text to find, replacement, times it must appear}
  c_edits CONSTANT text[][] := ARRAY[
    -- a TriciCoin ride without a split that the wallet cannot cover goes mixed
    [$o1$  IF v_payment_method_text = 'tricicoin' THEN
$o1$,
     $n1$  -- 00636: a TriciCoin ride whose rider can no longer cover the fare is
  -- completed as a mixed ride: the wallet pays what it holds, the rest is cash.
  IF v_payment_method_text = 'tricicoin' AND NOT COALESCE(v_ride.is_split, false) THEN
    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
    IF COALESCE(v_customer_balance, 0) < v_final_fare_trc + v_insurance_premium_trc THEN
      v_payment_method_text := 'mixed';
      v_ride.payment_method := 'mixed';
      v_ride.wallet_ratio := 1;
      PERFORM set_config('app.ride_payment_to_mixed', '1', true);
      UPDATE rides SET payment_method = 'mixed', wallet_ratio = 1 WHERE id = p_ride_id;
      PERFORM set_config('app.ride_payment_to_mixed', '', true);
    END IF;
  END IF;

  IF v_payment_method_text = 'tricicoin' THEN
$n1$, '1'],
    -- mixed: lock the rider's wallet before reading it
    [$o2$    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
    SELECT balance INTO v_driver_tricicoin_balance$o2$,
     $n2$    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
    SELECT balance INTO v_driver_tricicoin_balance$n2$, '1'],
    -- mixed: leave room for the insurance premium
    [$o3$    v_wallet_amount := LEAST(GREATEST(v_wallet_amount, 0), v_customer_balance);$o3$,
     $n3$    v_wallet_amount := LEAST(GREATEST(v_wallet_amount, 0), GREATEST(v_customer_balance - v_insurance_premium_trc, 0));$n3$, '1'],
    -- split: a participant's wallet pays what it holds, up to its share
    [$o4$        SELECT balance INTO v_split_balance FROM wallet_accounts WHERE id = v_split_account_id FOR UPDATE;
$o4$,
     $n4$        SELECT balance INTO v_split_balance FROM wallet_accounts WHERE id = v_split_account_id FOR UPDATE;
        -- 00636: each payer's wallet pays what it holds, up to its share; the rest is cash.
        IF v_split_amount > GREATEST(COALESCE(v_split_balance, 0), 0) THEN
          v_cash_amount := COALESCE(v_cash_amount, 0) + v_split_amount - GREATEST(COALESCE(v_split_balance, 0), 0);
          v_split_amount := GREATEST(COALESCE(v_split_balance, 0), 0);
        END IF;
$n4$, '1'],
    -- split: the requester too; any cash part makes the ride mixed
    [$o5$        v_requester_amount := v_final_fare_trc - v_split_total;
$o5$,
     $n5$        v_requester_amount := v_final_fare_trc - v_split_total;
        IF v_requester_amount > GREATEST(COALESCE(v_customer_balance, 0), 0) THEN
          v_cash_amount := COALESCE(v_cash_amount, 0) + v_requester_amount - GREATEST(COALESCE(v_customer_balance, 0), 0);
          v_requester_amount := GREATEST(COALESCE(v_customer_balance, 0), 0);
        END IF;
        IF v_cash_amount > 0 THEN
          v_wallet_amount := v_final_fare_trc - v_cash_amount;
          v_ride.payment_method := 'mixed';
          PERFORM set_config('app.ride_payment_to_mixed', '1', true);
          UPDATE rides SET payment_method = 'mixed',
            wallet_ratio = ROUND(v_wallet_amount::numeric / v_final_fare_trc, 4),
            wallet_amount_cup = v_wallet_amount,
            cash_amount_cup = v_cash_amount
          WHERE id = p_ride_id;
          PERFORM set_config('app.ride_payment_to_mixed', '', true);
        END IF;
$n5$, '1'],
    -- TriciCoin branch (split and not): the driver collects the cash part, so
    -- its credit drops by it. v_cash_amount is NULL unless a payer fell short.
    [$o6$VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);$o6$,
     $n6$VALUES (v_txn_id, v_driver_account_id, v_driver_earnings - COALESCE(v_cash_amount, 0), v_driver_balance + v_driver_earnings - COALESCE(v_cash_amount, 0));$n6$, '2'],
    [$o7$UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;$o7$,
     $n7$UPDATE wallet_accounts SET balance = balance + v_driver_earnings - COALESCE(v_cash_amount, 0) WHERE id = v_driver_account_id;$n7$, '2']
  ];
  v_md5 text;
  v_src text;
  v_n   int;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = c_new_md5 THEN
    RETURN;
  ELSIF v_md5 IS DISTINCT FROM c_old_md5 THEN
    RAISE EXCEPTION 'unexpected body of complete_ride_and_pay (md5 %): not patched', v_md5;
  END IF;

  v_src := pg_get_functiondef(c_fn);
  FOR i IN 1 .. array_length(c_edits, 1) LOOP
    v_n := (length(v_src) - length(replace(v_src, c_edits[i][1], ''))) / length(c_edits[i][1]);
    IF v_n <> c_edits[i][3]::int THEN
      RAISE EXCEPTION 'complete_ride_and_pay edit %: found % times, expected %', i, v_n, c_edits[i][3];
    END IF;
    v_src := replace(v_src, c_edits[i][1], c_edits[i][2]);
  END LOOP;
  EXECUTE v_src;
END
$patch$;

-- 2. tg_rides_validate_insurance: priced only with the feature flag on ----------
DO $patch$
DECLARE
  c_fn  CONSTANT regprocedure := 'public.tg_rides_validate_insurance()'::regprocedure;
  c_old CONSTANT text := $o$    WHERE service_type = NEW.service_type AND is_active = true
$o$;
  c_new CONSTANT text := $n$    WHERE service_type = NEW.service_type AND is_active = true
      AND EXISTS (SELECT 1 FROM feature_flags f WHERE f.key = 'trip_insurance_enabled' AND f.value IS TRUE)
$n$;
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = '4d5516aca57a3b81076fdad9fdb6f9f6' THEN
    EXECUTE replace(pg_get_functiondef(c_fn), c_old, c_new);
  ELSIF v_md5 <> '37cce0bf95b284f388d6aef1973f8a4d' THEN
    RAISE EXCEPTION 'unexpected body of tg_rides_validate_insurance (md5 %): not patched', v_md5;
  END IF;
END
$patch$;

-- 3. enforce_ride_update_columns: let complete_ride_and_pay make a completed
--    TriciCoin ride mixed. It runs as SECURITY DEFINER, so current_user cannot
--    tell the RPC from a client; complete_ride_and_pay raises its own flag just
--    around that UPDATE (a raw client write cannot change payment_method at
--    all: 00634 rejects it first).
DO $patch$
DECLARE
  c_fn  CONSTANT regprocedure := 'public.enforce_ride_update_columns()'::regprocedure;
  c_old CONSTANT text := $o$  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
$o$;
  c_new CONSTANT text := $n$  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method
     AND NOT (OLD.status = 'completed' AND OLD.payment_method = 'tricicoin'
              AND NEW.payment_method = 'mixed'
              AND COALESCE(current_setting('app.ride_payment_to_mixed', true), '') = '1') THEN
$n$;
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = 'c181b9e3e630e306a329de56398033f5' THEN
    EXECUTE replace(pg_get_functiondef(c_fn), c_old, c_new);
  ELSIF v_md5 <> '31af7a0b024555f25320def803642dba' THEN
    RAISE EXCEPTION 'unexpected body of enforce_ride_update_columns (md5 %): not patched', v_md5;
  END IF;
END
$patch$;

-- 4. Pasted from Windows (CRLF), the inserted text would carry \r: recreate the
--    three functions from the catalog without them so their md5 matches git.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure,
                              'public.tg_rides_validate_insurance()'::regprocedure,
                              'public.enforce_ride_update_columns()'::regprocedure] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 5. Assertions ------------------------------------------------------------------
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure) <> 'dc8ddf9007b362ec0629d32a16d94920' THEN
    RAISE EXCEPTION 'complete_ride_and_pay does not have the body of git';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.tg_rides_validate_insurance()'::regprocedure) <> '37cce0bf95b284f388d6aef1973f8a4d' THEN
    RAISE EXCEPTION 'tg_rides_validate_insurance does not have the body of git';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.enforce_ride_update_columns()'::regprocedure) <> '31af7a0b024555f25320def803642dba' THEN
    RAISE EXCEPTION 'enforce_ride_update_columns does not have the body of git';
  END IF;
  IF has_function_privilege('anon', 'public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute complete_ride_and_pay';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost complete_ride_and_pay';
  END IF;
END
$check$;

RESET lock_timeout;
