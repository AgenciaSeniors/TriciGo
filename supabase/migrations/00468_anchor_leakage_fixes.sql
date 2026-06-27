-- 00468 — Close USD-anchor leakage paths (FX anchor audit, Tema C / PR-FX-3)
--
-- DEPENDS ON 00467 (the anchor-directive mechanism in tg_ledger_maintain_usd_anchor).
-- Apply 00467 before 00468. If applied without 00467, the directives below are simply
-- ignored by the old trigger (it falls back to the today-rate recompute) — no crash,
-- but the leak stays open until 00467 lands.
--
-- The "AUD-005 giveaway" (00446 closed it for promo_credit) is reopened via three paths.
-- Root cause: cross-wallet transfers and admin credits treat every credit as 100% backed
-- USD instead of mirroring the backed/unbacked composition. With 0 unbacked balance in
-- prod today these are dormant, but referrals are ON so unbacked will appear. Fixes use
-- the per-account anchor directive from 00467 to move backed↔backed and unbacked↔unbacked.

-- 1) admin_adjust_wallet: admin credits to anchored wallets are MINTED CUP (the platform
--    received no USD) → route them to unbacked_cup, not the backed anchor, so they don't
--    float with the dollar / draw on platform_fx_reserve. Debits keep the normal
--    unbacked-first-then-anchor path. Non-anchored wallets (driver_cash) unaffected.
CREATE OR REPLACE FUNCTION public.admin_adjust_wallet(p_target_user_id uuid, p_account_type wallet_account_type, p_amount_cup integer, p_reason text, p_admin_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_account_id UUID;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_is_admin BOOLEAN;
  v_metadata jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;
  IF p_target_user_id = p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: an admin cannot adjust their own wallet';
  END IF;
  IF p_amount_cup = 0 THEN
    RAISE EXCEPTION 'Amount cannot be zero';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Reason is required (min 3 chars)';
  END IF;

  -- 00338: corporate_cash allowed. 00396: tricicoin allowed (single-wallet
  -- driver model — this is the balance accept_ride actually checks).
  IF p_account_type NOT IN ('customer_cash', 'driver_cash', 'corporate_cash', 'tricicoin') THEN
    RAISE EXCEPTION 'Unsupported account type: %', p_account_type;
  END IF;

  SELECT id INTO v_account_id FROM wallet_accounts
    WHERE user_id = p_target_user_id AND account_type = p_account_type LIMIT 1;
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (
      p_target_user_id, p_account_type, 0, 0,
      CASE WHEN p_account_type = 'tricicoin' THEN 'TRC' ELSE 'CUP' END,
      true
    )
    RETURNING id INTO v_account_id;
  END IF;

  -- Tema C: a positive admin credit to an anchored wallet is unbacked (no USD received).
  IF p_amount_cup > 0 AND p_account_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN
    v_metadata := jsonb_build_object('anchor_directives', jsonb_build_array(
      jsonb_build_object('account_id', v_account_id, 'unbacked_cup_delta', p_amount_cup)
    ));
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by
  )
  VALUES (
    'admin_adjust:' || gen_random_uuid()::TEXT,
    'adjustment', 'posted', 'admin_action',
    p_admin_user_id, p_reason, v_metadata, p_admin_user_id
  )
  RETURNING id INTO v_tx_id;

  UPDATE wallet_accounts SET balance = balance + p_amount_cup, updated_at = NOW()
  WHERE id = v_account_id RETURNING balance INTO v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount_cup, v_new_balance);

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'adjust_wallet', 'wallet_account', v_account_id::TEXT, p_reason);

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'account_id', v_account_id,
    'amount_cup', p_amount_cup,
    'new_balance', v_new_balance
  );
END;
$function$;

-- 2) send_gift: conserve the sender's backed/unbacked composition across the gift, so
--    gifting promo (unbacked) CUP does NOT mint backed USD value in the recipient's
--    anchor. Computes the split at today's rate and pins both legs with directives.
CREATE OR REPLACE FUNCTION public.send_gift(p_from_user_id uuid, p_to_user_id uuid, p_amount integer, p_note text DEFAULT NULL::text, p_from_wallet wallet_account_type DEFAULT NULL::wallet_account_type)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_from_type wallet_account_type;
  v_to_type   wallet_account_type;
  v_from_account_id UUID;
  v_to_account_id   UUID;
  v_from_balance INTEGER;
  v_to_balance   INTEGER;
  v_from_frozen  BOOLEAN;
  v_to_frozen    BOOLEAN;
  v_to_active    BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
  v_dup UUID;
  v_from_unbacked INTEGER;
  v_rate numeric;
  v_unbacked_used INTEGER;
  v_backed_used INTEGER;
  v_backed_usd_cents numeric;
  v_metadata jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only gift from your own wallet';
  END IF;

  IF auth.uid() <> p_from_user_id THEN
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (auth.uid(), 'send_gift_on_behalf', 'user', p_from_user_id::TEXT, COALESCE(p_note, 'Regalo'));
  END IF;

  IF p_amount <= 0 THEN RAISE EXCEPTION 'Gift amount must be positive'; END IF;
  IF p_from_user_id = p_to_user_id THEN RAISE EXCEPTION 'Cannot gift to yourself'; END IF;

  IF p_from_wallet IS NOT NULL
     AND p_from_wallet NOT IN ('customer_cash'::wallet_account_type, 'tricicoin'::wallet_account_type) THEN
    RAISE EXCEPTION 'Invalid gift source wallet: %', p_from_wallet;
  END IF;

  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  SELECT id INTO v_dup
  FROM wallet_transfers
  WHERE from_user_id = p_from_user_id
    AND to_user_id = p_to_user_id
    AND amount = p_amount
    AND kind = 'gift'
    AND reversal_of IS NULL
    AND created_at > NOW() - INTERVAL '10 seconds'
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN v_dup;
  END IF;

  v_from_type := COALESCE(p_from_wallet, _gift_wallet_type(p_from_user_id));
  v_to_type   := _gift_wallet_type(p_to_user_id);

  PERFORM ensure_wallet_account(p_from_user_id, v_from_type);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  SELECT id, balance, is_frozen, COALESCE(unbacked_cup, 0)
    INTO v_from_account_id, v_from_balance, v_from_frozen, v_from_unbacked
    FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type = v_from_type FOR UPDATE;
  IF COALESCE(v_from_frozen, false) THEN
    RAISE EXCEPTION 'Your wallet is frozen';
  END IF;
  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_from_balance, p_amount;
  END IF;

  SELECT id, balance, is_frozen INTO v_to_account_id, v_to_balance, v_to_frozen
    FROM wallet_accounts
    WHERE user_id = p_to_user_id AND account_type = v_to_type FOR UPDATE;
  IF COALESCE(v_to_frozen, false) THEN
    RAISE EXCEPTION 'Recipient wallet is frozen';
  END IF;

  -- Tema C: split the gift into the sender's unbacked-first / backed composition and
  -- pin both legs so unbacked stays unbacked and backed stays backed (conserved value).
  v_rate := public.get_current_exchange_rate();
  v_unbacked_used := LEAST(v_from_unbacked, p_amount);
  v_backed_used := p_amount - v_unbacked_used;
  v_backed_usd_cents := CASE WHEN v_rate > 0 THEN ROUND(v_backed_used / v_rate * 100) ELSE 0 END;
  v_metadata := jsonb_build_object('kind', 'gift', 'anchor_directives', jsonb_build_array(
    jsonb_build_object('account_id', v_from_account_id, 'unbacked_cup_delta', -v_unbacked_used, 'anchor_usd_cents_delta', -v_backed_usd_cents),
    jsonb_build_object('account_id', v_to_account_id,   'unbacked_cup_delta',  v_unbacked_used, 'anchor_usd_cents_delta',  v_backed_usd_cents)
  ));

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, description, metadata, created_by
  )
  VALUES (
    'gift:' || gen_random_uuid()::TEXT, 'transfer_out', 'posted', 'wallet_transfer',
    COALESCE(p_note, 'Regalo'), v_metadata, p_from_user_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_from_account_id, -p_amount, v_from_balance - p_amount);
  UPDATE wallet_accounts SET balance = v_from_balance - p_amount, updated_at = NOW()
    WHERE id = v_from_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_to_balance + p_amount);
  UPDATE wallet_accounts SET balance = v_to_balance + p_amount, updated_at = NOW()
    WHERE id = v_to_account_id;

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (p_from_user_id, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  -- Notify the recipient: in-app inbox row + push (00393). The send-push EF
  -- persists the notifications row AND pushes to the recipient's devices, so
  -- this single call covers both. Wrapped so a notification failure can NEVER
  -- roll back the already-committed gift. (net.http_post only enqueues async.)
  DECLARE
    v_service_key TEXT;
    v_from_name   TEXT;
  BEGIN
    v_service_key := get_service_role_key();
    IF v_service_key IS NOT NULL AND v_service_key <> '' THEN
      SELECT full_name INTO v_from_name FROM users WHERE id = p_from_user_id;
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', v_service_key,
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', p_to_user_id,
          'title', '🎁 Recibiste un regalo',
          'body', COALESCE(NULLIF(v_from_name, ''), 'Alguien')
                  || ' te regaló ' || p_amount::text || ' TriciCoin'
                  || CASE WHEN COALESCE(p_note, '') <> '' THEN ': ' || p_note ELSE '' END,
          'category', 'wallet_credit',
          'data', jsonb_build_object(
            'type', 'wallet_credit',
            'transfer_id', v_transfer_id::text,
            'amount', p_amount::text,
            'from_name', COALESCE(v_from_name, '')
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_transfer_id;
END;
$function$;

-- 3) admin_reverse_gift: mirror the composition when reversing (recipient -> sender),
--    splitting by the recipient's current unbacked/backed so the reversal conserves
--    value the same way the gift did, instead of the old unbacked-first / 100%-backed
--    asymmetry.
CREATE OR REPLACE FUNCTION public.admin_reverse_gift(p_transfer_id uuid, p_admin_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_is_admin BOOLEAN;
  v_orig RECORD;
  v_recip_type wallet_account_type;
  v_sender_type wallet_account_type;
  v_recip_account_id UUID;
  v_sender_account_id UUID;
  v_recip_balance INTEGER;
  v_sender_balance INTEGER;
  v_recip_unbacked INTEGER;
  v_txn_id UUID;
  v_new_transfer_id UUID;
  v_rate numeric;
  v_unbacked_used INTEGER;
  v_backed_used INTEGER;
  v_backed_usd_cents numeric;
  v_metadata jsonb;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  SELECT * INTO v_orig FROM wallet_transfers WHERE id = p_transfer_id;
  IF v_orig.id IS NULL THEN
    RAISE EXCEPTION 'Gift not found';
  END IF;
  IF v_orig.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Gift already reversed';
  END IF;
  IF v_orig.from_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot reverse a platform-originated gift; use admin_adjust_wallet instead';
  END IF;

  v_recip_type  := _gift_wallet_type(v_orig.to_user_id);
  v_sender_type := _gift_wallet_type(v_orig.from_user_id);
  PERFORM ensure_wallet_account(v_orig.to_user_id, v_recip_type);
  PERFORM ensure_wallet_account(v_orig.from_user_id, v_sender_type);

  SELECT id, balance, COALESCE(unbacked_cup, 0) INTO v_recip_account_id, v_recip_balance, v_recip_unbacked
    FROM wallet_accounts
    WHERE user_id = v_orig.to_user_id AND account_type = v_recip_type FOR UPDATE;
  IF v_recip_type <> 'customer_cash' AND v_recip_balance < v_orig.amount THEN
    RAISE EXCEPTION 'Cannot reverse: recipient already spent the gift (balance %, gift %)',
      v_recip_balance, v_orig.amount;
  END IF;

  SELECT id, balance INTO v_sender_account_id, v_sender_balance FROM wallet_accounts
    WHERE user_id = v_orig.from_user_id AND account_type = v_sender_type FOR UPDATE;

  -- Tema C: split by the recipient's composition so the reversal conserves backed/unbacked.
  v_rate := public.get_current_exchange_rate();
  v_unbacked_used := LEAST(v_recip_unbacked, v_orig.amount);
  v_backed_used := v_orig.amount - v_unbacked_used;
  v_backed_usd_cents := CASE WHEN v_rate > 0 THEN ROUND(v_backed_used / v_rate * 100) ELSE 0 END;
  v_metadata := jsonb_build_object('kind', 'gift_reversal', 'reversal_of', p_transfer_id, 'anchor_directives', jsonb_build_array(
    jsonb_build_object('account_id', v_recip_account_id,  'unbacked_cup_delta', -v_unbacked_used, 'anchor_usd_cents_delta', -v_backed_usd_cents),
    jsonb_build_object('account_id', v_sender_account_id, 'unbacked_cup_delta',  v_unbacked_used, 'anchor_usd_cents_delta',  v_backed_usd_cents)
  ));

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by
  )
  VALUES (
    'gift_reversal:' || p_transfer_id::TEXT, 'adjustment', 'posted', 'wallet_transfer',
    p_transfer_id, 'Reversión de regalo',
    v_metadata, p_admin_user_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_recip_account_id, -v_orig.amount, v_recip_balance - v_orig.amount);
  UPDATE wallet_accounts SET balance = v_recip_balance - v_orig.amount, updated_at = NOW()
    WHERE id = v_recip_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_sender_account_id, v_orig.amount, v_sender_balance + v_orig.amount);
  UPDATE wallet_accounts SET balance = v_sender_balance + v_orig.amount, updated_at = NOW()
    WHERE id = v_sender_account_id;

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind, reversal_of)
    VALUES (v_orig.to_user_id, v_orig.from_user_id, v_orig.amount,
            'Reversión de regalo', v_txn_id, 'gift_reversal', p_transfer_id)
  RETURNING id INTO v_new_transfer_id;

  UPDATE wallet_transfers SET reversed_at = NOW(), reversed_by = p_admin_user_id
    WHERE id = p_transfer_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (p_admin_user_id, 'reverse_gift', 'wallet_transfer', p_transfer_id::TEXT, 'Reversión de regalo');

  RETURN v_new_transfer_id;
END;
$function$;
