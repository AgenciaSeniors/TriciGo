-- 00449_deletion_settle_positive_and_cancel_counter_trust.sql
-- Pre-launch audit 2026-06-20 — AUD-011 (P2) + AUD-014 (P3). Both dormant (0 deletions / 0 cancel events).
--
-- AUD-011: settle_and_scrub_for_deletion zeroes wallets WHERE balance <> 0, so a NEGATIVE driver
-- balance (allowed since 00115) matched: it credited the user wallet +|debt| to 0 and REDUCED
-- platform_revenue by |debt| (labelled "unclaimed funds"). A driver could offboard to write off
-- commission/insurance debt against platform_revenue. Fix: settle only POSITIVE balances; leave
-- negatives to the FK ON DELETE SET NULL (00422) so debt is an orphaned-wallet loss, never confiscated.
--
-- AUD-014: cancel_ride increments users.cancellation_count / last_cancellation_at, but it is
-- SECURITY DEFINER running in the canceller's (non-admin) auth context, so tg_users_protect_admin_fields
-- reverts both columns (its non-admin AND its trusted_tier_update branches both reset them) — the
-- lifetime cancel counter is frozen. Fix (trust-flag pattern, cf. 00411/00412): cancel_ride sets a
-- transaction-local GUC app.trusted_cancel_update; the protect trigger honours it for ONLY those two
-- columns while still protecting role/level/etc. PostgREST clients cannot set_config, so it can't be forged.

-- ── AUD-011: settle only positive balances (reproduced from the live body, 00439). ──
CREATE OR REPLACE FUNCTION public.settle_and_scrub_for_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_platform_acct uuid;
  v_acct RECORD;
  v_tx uuid;
  v_plat_balance integer;
  v_zeroed integer := 0;
  v_scrubbed jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  IF p_user_id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099') THEN
    RAISE EXCEPTION 'cannot settle a system account';
  END IF;

  v_platform_acct := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_revenue');

  FOR v_acct IN
    SELECT id, balance FROM wallet_accounts WHERE user_id = p_user_id AND balance > 0 FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1 FROM ledger_transactions
      WHERE idempotency_key = 'account_deletion_zero:' || v_acct.id::text
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES ('account_deletion_zero:' || v_acct.id::text, 'adjustment', 'posted', 'account_deletion', p_user_id,
            'Saldo no reclamado movido a platform_revenue al borrar la cuenta',
            '00000000-0000-0000-0000-000000000001')
    RETURNING id INTO v_tx;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_tx, v_acct.id, -v_acct.balance, 0);
    UPDATE wallet_accounts SET balance = 0 WHERE id = v_acct.id;

    SELECT balance INTO v_plat_balance FROM wallet_accounts WHERE id = v_platform_acct FOR UPDATE;
    UPDATE wallet_accounts SET balance = balance + v_acct.balance WHERE id = v_platform_acct;
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_tx, v_platform_acct, v_acct.balance, v_plat_balance + v_acct.balance);

    v_zeroed := v_zeroed + 1;
  END LOOP;

  UPDATE ride_messages SET body = '[cuenta eliminada]' WHERE sender_id = p_user_id AND body IS NOT NULL AND body <> '[cuenta eliminada]';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('ride_messages', v_n);

  UPDATE reviews SET comment = NULL WHERE reviewer_id = p_user_id AND comment IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('reviews', v_n);

  UPDATE incident_reports SET description = '[cuenta eliminada]' WHERE reported_by = p_user_id AND description IS NOT NULL AND description <> '[cuenta eliminada]';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('incident_reports', v_n);

  UPDATE support_tickets SET subject = '[cuenta eliminada]', description = '[cuenta eliminada]' WHERE user_id = p_user_id AND (subject <> '[cuenta eliminada]' OR description <> '[cuenta eliminada]');
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('support_tickets', v_n);

  UPDATE ticket_messages SET message = '[cuenta eliminada]' WHERE sender_id = p_user_id AND message IS NOT NULL AND message <> '[cuenta eliminada]';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('ticket_messages', v_n);

  RETURN jsonb_build_object('wallets_zeroed', v_zeroed, 'scrubbed', v_scrubbed);
END;
$function$;

-- ── AUD-014a: protect trigger honours app.trusted_cancel_update for the two cancel columns only. ──
CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_tier_update', true) = '1' THEN
    NEW.role                 := OLD.role;
    NEW.is_active            := OLD.is_active;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    RETURN NEW;
  END IF;

  -- AUD-014: cancel_ride owns cancellation_count + last_cancellation_at. Allow only those two to
  -- change; everything else (role/level/total_rides/total_spent/…) stays protected.
  IF current_setting('app.trusted_cancel_update', true) = '1' THEN
    NEW.role        := OLD.role;
    NEW.is_active   := OLD.is_active;
    NEW.level       := OLD.level;
    NEW.total_rides := OLD.total_rides;
    NEW.total_spent := OLD.total_spent;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    NEW.role  := OLD.role;
    NEW.level := OLD.level;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$function$;

-- ── AUD-014b: cancel_ride sets the trust flag before its counter UPDATE (patch-in-place;
--    don't reproduce the large RPC verbatim → no risk of losing features). Idempotent. ──
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p WHERE p.proname = 'cancel_ride' AND p.pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF v_src IS NULL THEN
    RAISE NOTICE 'cancel_ride absent; skipping patch';
    RETURN;
  END IF;

  IF position('app.trusted_cancel_update' IN v_src) > 0 THEN
    RAISE NOTICE 'cancel_ride already sets app.trusted_cancel_update; skipping';
    RETURN;
  END IF;

  v_src := replace(
    v_src,
    E'UPDATE users\n       SET cancellation_count = COALESCE(cancellation_count, 0) + 1,',
    E'PERFORM set_config(''app.trusted_cancel_update'', ''1'', true);\n    UPDATE users\n       SET cancellation_count = COALESCE(cancellation_count, 0) + 1,'
  );

  IF position('app.trusted_cancel_update' IN v_src) = 0 THEN
    RAISE EXCEPTION 'cancel_ride patch did not match the expected UPDATE users block — aborting (manual review needed)';
  END IF;

  EXECUTE v_src;
  RAISE NOTICE 'cancel_ride patched: app.trusted_cancel_update set before the cancellation counter UPDATE';
END $patch$;
