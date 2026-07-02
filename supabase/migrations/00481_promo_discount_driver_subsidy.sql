-- 00481: promo discounts are absorbed by the PLATFORM, not the driver.
--
-- Problem (IG-plan readiness review 2026-07-02, confirmed adversarially
-- against the live body of complete_ride_and_pay): driver earnings are
-- computed on the POST-discount fare and no ledger leg compensates the
-- difference — a 100% "first ride free" promo pays the driver 0 CUP.
-- Launching the Instagram plan's "primer viaje gratis" (Pubs 9/11) with
-- that behavior would make founding drivers work for free.
--
-- Fix: in-place patch (canonical pattern for large RPCs — never rewrite
-- the 24k-char body verbatim). A self-contained nested block is inserted
-- right before the stable `UPDATE driver_profiles SET total_rides_completed`
-- tail anchor. After the normal payment legs run, it tops the driver up to
-- what they would have earned WITHOUT the promo:
--
--   promo_disc     = discount_amount_cup − shared_ride_discount_cup
--                    (shared-ride discount is deliberately NOT subsidized:
--                     the driver's compensation there is street cash from
--                     the extra co-riders, by design of mig 00347)
--   gross_no_promo = (fare − shared_disc) + wait_charge
--   driver_should  = gross_no_promo − ROUND(gross_no_promo × default_rate)
--   subsidy        = GREATEST(driver_should − driver_earnings, 0)
--
-- The subsidy moves platform_promotions → driver tricicoin in its own
-- double-entry transaction (idempotency 'promo_subsidy:<ride_id>' — safe
-- against RPC retries). Platform's total promo cost = the full discount
-- (subsidy d×(1−r) + foregone commission d×r). Wrapped defensively: a
-- subsidy failure NEVER blocks ride completion (00394 pattern).
--
-- Preconditions checked below: function exists, anchor unique, not
-- already patched (idempotent re-run).

DO $patch$
DECLARE
  v_src TEXT;
  v_anchor TEXT := 'UPDATE driver_profiles SET total_rides_completed';
  v_block TEXT;
  v_count INTEGER;
BEGIN
  BEGIN
    SELECT pg_get_functiondef('public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure)
    INTO v_src;
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE '00481: complete_ride_and_pay absent; skipping (fresh DB — created later by design)';
    RETURN;
  END;

  IF position('promo_subsidy:' IN v_src) > 0 THEN
    RAISE NOTICE '00481: already patched; skipping';
    RETURN;
  END IF;

  v_count := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00481: anchor occurs % times (expected 1) — body drifted, patch aborted', v_count;
  END IF;

  v_block := $blk$
  -- 00481: promo subsidy — platform absorbs promo discounts, driver made whole.
  DECLARE
    v_promo_disc INTEGER;
    v_gross_no_promo INTEGER;
    v_driver_should INTEGER;
    v_subsidy INTEGER;
    v_subsidy_trc INTEGER;
    v_sub_platform_account UUID;
    v_sub_platform_balance INTEGER;
    v_sub_driver_account UUID;
    v_sub_driver_balance INTEGER;
    v_subsidy_txn UUID;
  BEGIN
    v_promo_disc := GREATEST(
      COALESCE(v_ride.discount_amount_cup, 0) - COALESCE(v_ride.shared_ride_discount_cup, 0), 0);
    IF v_promo_disc > 0 AND v_ride.promo_code_id IS NOT NULL THEN
      v_gross_no_promo := GREATEST(v_fare - COALESCE(v_ride.shared_ride_discount_cup, 0), 0)
                        + COALESCE(v_wait_charge, 0);
      v_driver_should := v_gross_no_promo - ROUND(v_gross_no_promo * v_default_commission_rate);
      v_subsidy := GREATEST(v_driver_should - v_driver_earnings, 0);
      IF v_subsidy > 0 THEN
        v_subsidy_trc := cup_to_trc_centavos(v_subsidy, v_exchange_rate);
        v_sub_driver_account := ensure_wallet_account(v_driver_user_id, 'tricicoin');
        v_sub_platform_account := ensure_wallet_account(v_platform_user_id, 'platform_promotions');
        SELECT balance INTO v_sub_platform_balance
          FROM wallet_accounts WHERE id = v_sub_platform_account FOR UPDATE;
        SELECT balance INTO v_sub_driver_balance
          FROM wallet_accounts WHERE id = v_sub_driver_account FOR UPDATE;
        BEGIN
          INSERT INTO ledger_transactions (
            id, idempotency_key, type, status,
            reference_type, reference_id, description, created_by
          ) VALUES (
            gen_random_uuid(),
            'promo_subsidy:' || p_ride_id::TEXT,
            'promo_credit', 'posted',
            'ride', p_ride_id,
            'Subsidio de promo al conductor - viaje con descuento promocional',
            v_driver_user_id
          )
          RETURNING id INTO v_subsidy_txn;

          INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
          VALUES (v_subsidy_txn, v_sub_platform_account, -v_subsidy_trc, v_sub_platform_balance - v_subsidy_trc);

          INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
          VALUES (v_subsidy_txn, v_sub_driver_account, v_subsidy_trc, v_sub_driver_balance + v_subsidy_trc);

          UPDATE wallet_accounts SET balance = balance - v_subsidy_trc WHERE id = v_sub_platform_account;
          UPDATE wallet_accounts SET balance = balance + v_subsidy_trc WHERE id = v_sub_driver_account;
        EXCEPTION WHEN unique_violation THEN
          NULL; -- subsidy already paid for this ride (idempotent)
        END;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'promo subsidy failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
  END;

  $blk$;

  EXECUTE replace(v_src, v_anchor, v_block || v_anchor);
  RAISE NOTICE '00481: promo subsidy block injected into complete_ride_and_pay';
END $patch$;
