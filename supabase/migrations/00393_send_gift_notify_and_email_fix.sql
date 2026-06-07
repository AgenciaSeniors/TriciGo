-- 00393_send_gift_notify_and_email_fix.sql
--
-- Fix two real gaps in the "Regalo" (gift) flow, found 2026-06-06 while
-- testing a 3000 CUP gift that "never arrived":
--
--   * The money DID arrive — the double-entry ledger is correct. This
--     migration does NOT touch the money path.
--   * Gap 1 — NO notification: send_gift never created an in-app
--     notification nor sent a push. wallet_transfers has only fraud +
--     email triggers; send_gift inserts neither a notification row nor
--     calls send-push.
--   * Gap 2 — NO email for this gift: send_driver_payout_email() returns
--     early when amount < 5000 (the gift was 3000) AND when the
--     recipient's role is not driver/super_admin — so a gift to a normal
--     passenger (role 'customer') would never email at all.
--
-- Fix:
--   1) send_gift: after inserting wallet_transfers, call the send-push EF
--      (category 'wallet_credit'). The EF persists the notifications inbox
--      row AND pushes to the recipient's devices, covering both at once.
--      Wrapped in a sub-block with an EXCEPTION handler so a notification
--      failure can NEVER roll back the already-committed gift.
--   2) send_driver_payout_email: handle the gift branch BEFORE the
--      5000-floor and the driver/super_admin role gate, so every gift to an
--      active recipient emails regardless of amount/role. Generic driver
--      payouts keep their floor + role gate unchanged.
--
-- Both functions are reproduced verbatim from the live prod definitions
-- (send_gift = 00391 context-aware-source-wallet version) with only the
-- surgical changes above. Applied to prod via MCP on 2026-06-06.

-- 1) send_gift — notify the recipient (in-app inbox row + push), best-effort
CREATE OR REPLACE FUNCTION public.send_gift(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount integer,
  p_note text DEFAULT NULL::text,
  p_from_wallet wallet_account_type DEFAULT NULL::wallet_account_type
)
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

  SELECT id, balance, is_frozen INTO v_from_account_id, v_from_balance, v_from_frozen
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

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, description, metadata, created_by
  )
  VALUES (
    'gift:' || gen_random_uuid()::TEXT, 'transfer_out', 'posted', 'wallet_transfer',
    COALESCE(p_note, 'Regalo'), jsonb_build_object('kind', 'gift'), p_from_user_id
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
    NULL;  -- best-effort; never fail the committed gift on a notification error
  END;

  RETURN v_transfer_id;
END;
$function$;

-- 2) send_driver_payout_email — gift branch bypasses the 5000-floor + role gate
CREATE OR REPLACE FUNCTION public.send_driver_payout_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_role TEXT; v_balance INTEGER;
  v_from_name TEXT;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN RETURN NEW; END IF;

  SELECT u.email, u.full_name, u.role::text
  INTO v_email, v_full_name, v_role
  FROM users u WHERE u.id = NEW.to_user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;

  -- Gift emails always go out (any positive amount, any active recipient role).
  -- Generic payouts keep the 5000-floor + driver/super_admin role gate (avoids
  -- emailing for trivial internal credits to non-payout accounts).
  IF NOT (NEW.kind = 'gift' AND NEW.reversal_of IS NULL) THEN
    IF NEW.amount < 5000 THEN RETURN NEW; END IF;
    IF v_role NOT IN ('driver','super_admin') THEN RETURN NEW; END IF;
  END IF;

  SELECT balance INTO v_balance FROM wallet_accounts WHERE user_id = NEW.to_user_id LIMIT 1;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  IF NEW.kind = 'gift' AND NEW.reversal_of IS NULL THEN
    -- Dedicated gift email: who sent it + the optional note. Skip
    -- reversals (admin_reverse_gift inserts a compensating row) so we
    -- don't tell the sender "you received a gift" on a refund.
    SELECT full_name INTO v_from_name FROM users WHERE id = NEW.from_user_id LIMIT 1;
    v_payload := jsonb_build_object(
      'template', 'gift_received', 'recipient_email', v_email,
      'subject', '🎁 Recibiste un regalo en TriciGo',
      'data', jsonb_build_object(
        'full_name', COALESCE(v_full_name, ''),
        'amount_cup', NEW.amount,
        'from_name', COALESCE(v_from_name, ''),
        'note', COALESCE(NEW.note, ''),
        'created_at', NEW.created_at,
        'new_balance_cup', COALESCE(v_balance, 0)
      )
    );
  ELSE
    -- Generic wallet credit / payout (also used by cargo bonus).
    v_payload := jsonb_build_object(
      'template', 'driver_payout', 'recipient_email', v_email,
      'subject', 'Pago recibido — TriciGo',
      'data', jsonb_build_object(
        'full_name', COALESCE(v_full_name, ''),
        'amount_cup', NEW.amount, 'description', COALESCE(NEW.note, ''),
        'created_at', NEW.created_at, 'new_balance_cup', COALESCE(v_balance, 0)
      )
    );
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers, body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;
