-- 00415_lost_item_push_and_admin_gift_double_entry.sql
-- ============================================================================
-- Two bugs found by the money/notification bug-class sweep (2026-06-13), both
-- of classes already fixed this session:
--
-- 1) notify_lost_item_change (PROX class, like mig 00402): the trigger's 4
--    net.http_post calls to send-push used a HARDCODED legacy HS256 service_role
--    JWT in the Authorization header (and no apikey header). The project migrated
--    to asymmetric ES256 signing keys and the legacy HS256 keys are disabled, so
--    send-push rejects the JWT with 401 and the "lost item" push notifications
--    never send. It was the ONLY of 10 send-push DB functions not using
--    get_service_role_key(). Fix: build the header with the live key
--    (get_service_role_key() + apikey + Authorization Bearer), like the other 9,
--    with a NULL guard so a missing key never blocks the row change.
--
-- 2) admin_send_gift (double-entry class, like the cargo bonus in mig 00414):
--    the admin (platform-originated) gift credited the recipient's wallet with a
--    SINGLE ledger_entry and no offsetting debit -> the transaction's entries sum
--    to +p_amount, minting TriciCoin with no counterparty. Latent (admin_gift:%
--    = 0 txns in prod). The identical case (referral) is solved by
--    admin_reward_referral with two balanced entries debiting platform_promotions.
--    Fix: debit platform_promotions for the gift (may go negative) so the two
--    ledger_entries net to 0.
--
-- DB-only; both bodies reproduced from the live prod functions, only the header
-- construction (1) and the platform debit (2) are new.
-- ============================================================================

-- 1) notify_lost_item_change — use the live service-role key for send-push.
CREATE OR REPLACE FUNCTION public.notify_lost_item_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_service_key text := get_service_role_key();
  v_headers jsonb;
BEGIN
  -- No service key (local dev / test) -> skip push, never block the row change.
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', v_service_key,
    'Authorization', 'Bearer ' || v_service_key
  );

  IF TG_OP = 'INSERT' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.driver_id::text,
        'title', 'Objeto perdido reportado',
        'body', 'Un pasajero reportó un objeto perdido en tu último viaje',
        'data', jsonb_build_object('route', '/trip/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
    RETURN NEW;
  END IF;

  IF NEW.driver_found IS NOT NULL AND (OLD.driver_found IS NULL) THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', CASE WHEN NEW.driver_found THEN 'Objeto encontrado' ELSE 'Objeto no encontrado' END,
        'body', CASE WHEN NEW.driver_found THEN 'El conductor encontró tu objeto. Se coordinará la devolución.' ELSE 'El conductor no encontró el objeto en el vehículo.' END,
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  IF NEW.status = 'return_arranged' AND OLD.status != 'return_arranged' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Devolución coordinada',
        'body', 'Se ha coordinado la devolución de tu objeto',
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  IF NEW.status = 'returned' AND OLD.status != 'returned' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Objeto devuelto',
        'body', 'Tu objeto ha sido devuelto exitosamente',
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) admin_send_gift — double-entry: debit platform_promotions (verbatim body +
--    the platform debit; 2 new declared vars).
CREATE OR REPLACE FUNCTION public.admin_send_gift(p_to_user_id uuid, p_amount integer, p_note text, p_admin_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_is_admin BOOLEAN;
  v_to_type  wallet_account_type;
  v_to_account_id UUID;
  v_new_balance INTEGER;
  v_to_active BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
  v_platform_account_id UUID;
  v_platform_balance INTEGER;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Gift amount must be positive';
  END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 3 THEN
    RAISE EXCEPTION 'Reason/note is required (min 3 chars)';
  END IF;
  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  v_to_type := _gift_wallet_type(p_to_user_id);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  -- 00415: double-entry — the platform funds the admin gift from
  -- platform_promotions (may go negative), like admin_reward_referral. Without
  -- this debit the gift minted TriciCoin with no counterparty.
  v_platform_account_id := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_promotions');
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by
  )
  VALUES (
    'admin_gift:' || gen_random_uuid()::TEXT, 'promo_credit', 'posted', 'admin_action',
    p_admin_user_id, p_note, jsonb_build_object('kind', 'gift', 'admin', true), p_admin_user_id
  )
  RETURNING id INTO v_txn_id;

  -- Debit the platform promotions wallet (funding side).
  UPDATE wallet_accounts SET balance = balance - p_amount, updated_at = NOW() WHERE id = v_platform_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, -p_amount, v_platform_balance - p_amount);

  -- Credit the recipient (receiving side).
  UPDATE wallet_accounts SET balance = balance + p_amount, updated_at = NOW()
    WHERE user_id = p_to_user_id AND account_type = v_to_type
  RETURNING id, balance INTO v_to_account_id, v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_new_balance);

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (NULL, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (p_admin_user_id, 'send_gift', 'user', p_to_user_id::TEXT, p_note);

  RETURN v_transfer_id;
END;
$function$;
