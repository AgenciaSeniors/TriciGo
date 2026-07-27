-- ============================================================
-- 00518 — send_gift: a real idempotency key, instead of a 10-second guess
--
-- WHAT WAS THERE
--
-- `send_gift` was NOT unprotected — it already refused to repeat a gift:
--
--     SELECT id INTO v_dup FROM wallet_transfers
--     WHERE from_user_id = … AND to_user_id = … AND amount = …
--       AND kind = 'gift' AND reversal_of IS NULL
--       AND created_at > NOW() - INTERVAL '10 seconds'
--     IF v_dup IS NOT NULL THEN RETURN v_dup; END IF;
--
-- and returning the earlier transfer id is exactly the right replay
-- semantics. The problem is the key: a 10-second window over
-- (from, to, amount) is a heuristic, and it is wrong in BOTH directions.
--
--   Too narrow. `walletService.sendGift` issues a bare `supabase.rpc` with
--   no abort signal, so a stalled request fails on the fetch default —
--   tens of seconds. The RPC committed at t≈0; the user sees the error
--   toast at t≈60s (gift.tsx catches, `finally` re-enables the button) and
--   taps "Enviar regalo" again well outside the window. Second debit. On
--   the Cuban links this product runs on, that is not an exotic path.
--
--   Too wide. Two identical gifts sent deliberately in quick succession —
--   same recipient, same round amount — are indistinguishable from a
--   retry. The second one silently returns the first transfer's id and
--   never happens, while the UI reports success. A dropped gift is quieter
--   than a doubled one, and worse to diagnose.
--
-- Both failures come from inferring intent from shape and timing. A key
-- supplied by the caller states it: the same key means "this is the same
-- gift I already asked for", a different key means "this is another one",
-- and neither depends on a clock.
--
-- WHY THIS IS SAFE EVEN IF THE LOOKUP LOSES A RACE
--
-- `ledger_transactions.idempotency_key` carries a UNIQUE constraint
-- (`ledger_transactions_idempotency_key_key`). Two concurrent calls with
-- the same key cannot both insert: the loser raises unique_violation and
-- its whole transaction — debit, credit, both wallet updates, the
-- wallet_transfers row — rolls back as a unit. The database enforces this,
-- not the SELECT below, which only exists to turn a duplicate into a
-- friendly replay instead of an error.
--
-- BACKWARD COMPATIBLE. The parameter is trailing and defaults to NULL, so
-- installed builds that call the five-argument form keep resolving here and
-- keep their 10-second heuristic (the fallback random key is unchanged).
-- Adding a parameter changes the function's identity, so this is a DROP +
-- CREATE rather than a CREATE OR REPLACE — which would leave a second
-- overload behind and make five-argument calls ambiguous.
--
-- The body is DERIVED FROM THE LIVE DEFINITION rather than retyped. This
-- function is ~6,100 characters and re-transcribing it is how features get
-- silently dropped (see the notify_ride_status_change regression fixed in
-- 00334). Three replacements are applied to whatever is actually running;
-- each anchor was verified to occur EXACTLY ONCE before this was written.
-- ============================================================

DO $patch$
DECLARE
  v_src TEXT;
  v_new TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'public.send_gift(uuid,uuid,integer,text,wallet_account_type)'::regprocedure
  ) INTO v_src;

  -- Idempotent: re-running this migration must not double-apply.
  IF v_src ILIKE '%p_idempotency_key%' THEN
    RAISE NOTICE '00518: send_gift already takes p_idempotency_key; skipping';
    RETURN;
  END IF;

  -- 1) Trailing parameter, defaulted so old callers still resolve.
  v_new := replace(
    v_src,
    'p_from_wallet wallet_account_type DEFAULT NULL::wallet_account_type)',
    'p_from_wallet wallet_account_type DEFAULT NULL::wallet_account_type, p_idempotency_key text DEFAULT NULL::text)'
  );

  -- 2) Key-based replay check, ahead of the existing time-window one. When
  --    a key is supplied this answers definitively and the heuristic below
  --    never gets a say; when it is not, the heuristic is untouched.
  v_new := replace(
    v_new,
    '  SELECT id INTO v_dup',
    '  IF p_idempotency_key IS NOT NULL THEN' || E'\n' ||
    '    SELECT wt.id INTO v_dup' || E'\n' ||
    '    FROM wallet_transfers wt' || E'\n' ||
    '    JOIN ledger_transactions lt ON lt.id = wt.transaction_id' || E'\n' ||
    '    WHERE lt.idempotency_key = p_idempotency_key' || E'\n' ||
    '    LIMIT 1;' || E'\n' ||
    '    IF v_dup IS NOT NULL THEN' || E'\n' ||
    '      RETURN v_dup;' || E'\n' ||
    '    END IF;' || E'\n' ||
    '  END IF;' || E'\n' || E'\n' ||
    '  SELECT id INTO v_dup'
  );

  -- 3) Persist the caller's key so the check above can find it next time.
  --    Without a key this stays the random per-call value it always was.
  v_new := replace(
    v_new,
    '''gift:'' || gen_random_uuid()::TEXT',
    'COALESCE(p_idempotency_key, ''gift:'' || gen_random_uuid()::TEXT)'
  );

  IF v_new = v_src THEN
    RAISE EXCEPTION '00518: no anchor matched — send_gift body changed, patch aborted';
  END IF;

  DROP FUNCTION public.send_gift(uuid, uuid, integer, text, wallet_account_type);
  EXECUTE v_new;

  RAISE NOTICE '00518: send_gift now accepts p_idempotency_key';
END $patch$;

COMMENT ON FUNCTION public.send_gift(uuid, uuid, integer, text, wallet_account_type, text) IS
  'Closed-loop P2P gift. Pass p_idempotency_key (00518) so a retry after a '
  'timeout replays instead of debiting twice, and so two deliberate '
  'identical gifts are not collapsed into one. Omitting it falls back to '
  'the 10-second (from,to,amount) heuristic kept for older builds.';
