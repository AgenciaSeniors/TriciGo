-- 00639: recharges — payment_intents are written by the server only, one
-- NETOPIA transaction per intent, and a refund the wallet cannot cover is
-- recorded instead of failing for ever.
--
-- 1. Any signed-in user could INSERT into payment_intents (policy pi_own_insert,
--    from 00020) with any status, amount, provider and NETOPIA transaction id.
--    No app ever did: every intent is created by the create-*-intent Edge
--    Functions with the service role. Measured in prod on 2026-10-08, rolled
--    back: a rider inserted a 'completed' intent of 9,999,999 CUP carrying the
--    ntpID of a real paid recharge. process-netopia-webhook refuses an IPN whose
--    ntpID belongs to another intent (§2a), so that row made the webhook refuse
--    the refund or chargeback IPN of the real recharge: the money comes back to
--    the card and stays in the wallet. The fake rows also show in the payment
--    history and in the admin's payments list as paid. The policy goes, and
--    anon/authenticated keep only SELECT (UPDATE, DELETE, TRUNCATE went in 00627).
--
-- 2. One NETOPIA transaction id (stripe_payment_intent_id, a Stripe-era name)
--    per intent, as a unique index. §2a checks it on every IPN; the index makes
--    it a fact of the table. Prod has 56 ids and no repeat; sandbox ids
--    (7 digits) and live ids (9 digits) do not overlap.
--
-- 3. process_recharge_refund debits the refunded USD at today's rate. When the
--    rider had already spent the recharge, the debit broke the CHECK
--    wallet_accounts_customer_balance_non_negative (23514, reproduced in prod
--    with a $100 refund on a 46,593 CUP wallet), the webhook answered 500,
--    NETOPIA retried until it gave up, and the refund or chargeback left no
--    trace. Now a rider's wallet gives what it holds, down to zero; the rest is
--    recorded as refund_shortfall_cup in the ledger metadata and in the intent's
--    error_message, the wallet keeps no USD anchor or unbacked CUP (or the next
--    revaluation would rebuild a balance), and ops get an e-mail. Driver
--    (tricicoin) and company (corporate_cash) wallets can go negative and are
--    debited in full, as before. Patched in place on the live body (md5 checked).
--
-- Rehearsal: supabase/tests/00639/run.sh (local Postgres 16, live bodies).

SET lock_timeout = '10s';

-- 1. Clients no longer write payment_intents -----------------------------------
DROP POLICY IF EXISTS pi_own_insert ON public.payment_intents;
REVOKE INSERT, REFERENCES, TRIGGER, TRUNCATE ON public.payment_intents FROM anon, authenticated;

-- 2. One NETOPIA transaction per intent -----------------------------------------
DO $dup$
DECLARE
  v_dups int;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT stripe_payment_intent_id FROM public.payment_intents
    WHERE stripe_payment_intent_id IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION '00639: % provider transaction ids are stored on more than one intent; resolve them before the unique index', v_dups;
  END IF;
END
$dup$;
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_txn_key
  ON public.payment_intents (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
DROP INDEX IF EXISTS public.idx_payment_intents_stripe_pi_id;

-- 3. Refund shortfall -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._alert_recharge_refund_shortfall(
  p_intent_id uuid, p_user_id uuid, p_shortfall_cup integer, p_debited_cup integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
-- 00639: e-mails every address in business_notification_email when a NETOPIA
-- refund or chargeback could not be taken back in full from a rider's wallet.
-- Through cron_http_post, so a send that send-email rejects shows up in
-- check_cron_http_failures. Never raises: the refund is recorded either way.
DECLARE
  v_to_raw      text;
  v_rcpt        text;
  v_service_key text;
  v_headers     jsonb;
  v_subject     text;
  v_html        text;
  v_sent        integer := 0;
BEGIN
  SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
    RAISE WARNING '_alert_recharge_refund_shortfall: business_notification_email unset (intent %)', p_intent_id;
    RETURN 0;
  END IF;

  v_subject := '[TriciGo] Devolución de recarga sin cubrir: ' || COALESCE(p_shortfall_cup, 0) || ' CUP';
  v_html :=
       '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
    || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Devolución de recarga sin cubrir</h2>'
    || '<p>NETOPIA devolvió una recarga (reembolso o contracargo), pero la billetera del pasajero ya no tenía todo el saldo. '
    || 'Se descontó lo que había y el resto quedó sin recuperar.</p>'
    || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Recarga (payment_intent)</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_intent_id::text, '-') || '</td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Usuario</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_user_id::text, '-') || '</td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Descontado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_debited_cup, 0) || ' CUP</td></tr>'
    || '<tr><td style="padding:6px"><b>Sin recuperar</b></td><td style="padding:6px;text-align:right">' || COALESCE(p_shortfall_cup, 0) || ' CUP</td></tr>'
    || '</table>'
    || '<p><b>Qué revisar:</b> la recarga en el panel (Pagos) y si hace falta bloquear la cuenta.</p>'
    || '<p style="color:#777;font-size:12px">Alerta automática de operaciones. No responder.</p>'
    || '</body></html>';

  v_service_key := get_service_role_key();
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key);
  FOR v_rcpt IN
    SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
  LOOP
    PERFORM public.cron_http_post('refund-shortfall-alert',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      -- Raw HTML, accepted by send-email's legacy path.
      body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', v_subject,
                                    'template', v_html, 'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '_alert_recharge_refund_shortfall failed for intent %: % %', p_intent_id, SQLSTATE, SQLERRM;
  RETURN 0;
END;
$function$;
REVOKE ALL ON FUNCTION public._alert_recharge_refund_shortfall(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._alert_recharge_refund_shortfall(uuid, uuid, integer, integer) TO service_role;

DO $patch$
DECLARE
  c_fn  CONSTANT regprocedure := 'public.process_recharge_refund(uuid,jsonb)'::regprocedure;
  c_old_md5 CONSTANT text := '640a94e7d03fe6e84dcb3240a6db4de2';
  c_new_md5 CONSTANT text := 'f9a2baa4b88dd0d68c955725996c6f31';
  -- {text to find, replacement, times it must appear}
  c_edits CONSTANT text[][] := ARRAY[
    [$o1$  v_bal_before integer;
  v_metadata jsonb;
BEGIN
$o1$,
     $n1$  v_bal_before integer;
  v_metadata jsonb;
  v_shortfall integer := 0;
BEGIN
$n1$, '1'],
    [$o2$  ELSE
    v_debit_cup := v_intent.amount_cup;
  END IF;

  INSERT INTO ledger_transactions ($o2$,
     $n2$  ELSE
    v_debit_cup := v_intent.amount_cup;
  END IF;

  -- 00639: a rider's wallet cannot go below zero (CHECK
  -- wallet_accounts_customer_balance_non_negative). If the recharge was
  -- already spent, the debit used to fail, NETOPIA retried for ever and the
  -- refund or chargeback was never recorded. Take what is left, record the
  -- rest as a shortfall, and alert ops. The lock keeps a ride payment from
  -- spending the balance between this read and the debit.
  SELECT balance INTO v_bal_before FROM wallet_accounts WHERE id = v_account_id FOR UPDATE;
  IF v_account_type = 'customer_cash' AND v_debit_cup > GREATEST(v_bal_before, 0) THEN
    v_shortfall := v_debit_cup - GREATEST(v_bal_before, 0);
    v_debit_cup := GREATEST(v_bal_before, 0);
    v_metadata := v_metadata || jsonb_build_object(
      'refund_debited_cup', v_debit_cup,
      'refund_shortfall_cup', v_shortfall);
  END IF;

  INSERT INTO ledger_transactions ($n2$, '1'],
    [$o3$  SELECT balance INTO v_bal_before FROM wallet_accounts WHERE id = v_account_id;
  INSERT INTO ledger_entries$o3$,
     $n3$  INSERT INTO ledger_entries$n3$, '1'],
    [$o4$  UPDATE wallet_accounts SET balance = balance - v_debit_cup, updated_at = NOW()
  WHERE id = v_account_id;

  UPDATE payment_intents SET status = 'refunded',
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
    updated_at = NOW() WHERE id = p_payment_intent_id;
  RETURN v_refund_txn_id;
END;$o4$,
     $n4$  UPDATE wallet_accounts SET balance = balance - v_debit_cup, updated_at = NOW()
  WHERE id = v_account_id;

  IF v_shortfall > 0 THEN
    -- The wallet is empty now: nothing may stay behind to back it, or the
    -- next FX revaluation would rebuild a balance from the leftover anchor.
    UPDATE wallet_accounts
       SET anchor_usd_cents = CASE WHEN anchor_usd_cents IS NULL THEN NULL ELSE 0 END,
           unbacked_cup = 0,
           updated_at = NOW()
     WHERE id = v_account_id;
    PERFORM public._alert_recharge_refund_shortfall(p_payment_intent_id, v_intent.user_id, v_shortfall, v_debit_cup);
  END IF;

  UPDATE payment_intents SET status = 'refunded',
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
    error_message = CASE WHEN v_shortfall > 0
      THEN format('refund_shortfall: %s CUP not recovered from the wallet', v_shortfall)
      ELSE error_message END,
    updated_at = NOW() WHERE id = p_payment_intent_id;
  RETURN v_refund_txn_id;
END;$n4$, '1']
  ];
  v_md5 text;
  v_src text;
  v_old text;
  v_n   int;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = c_new_md5 THEN
    RETURN;
  ELSIF v_md5 IS DISTINCT FROM c_old_md5 THEN
    RAISE EXCEPTION 'unexpected body of process_recharge_refund (md5 %): not patched', v_md5;
  END IF;

  v_src := pg_get_functiondef(c_fn);
  FOR i IN 1 .. array_length(c_edits, 1) LOOP
    -- Pasted from Windows, this file's text would carry \r; the live body has none.
    v_old := replace(c_edits[i][1], chr(13), '');
    v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
    IF v_n <> c_edits[i][3]::int THEN
      RAISE EXCEPTION 'process_recharge_refund edit %: found % times, expected %', i, v_n, c_edits[i][3];
    END IF;
    v_src := replace(v_src, v_old, replace(c_edits[i][2], chr(13), ''));
  END LOOP;
  EXECUTE v_src;
END
$patch$;

-- 4. Pasted from Windows (CRLF), the new helper would carry \r: recreate it from
--    the catalog without them so its md5 matches git.
DO $crlf$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public._alert_recharge_refund_shortfall(uuid,uuid,integer,integer)'::regprocedure) INTO v_def;
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

-- 5. Assertions ----------------------------------------------------------------------
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.payment_intents'::regclass AND polcmd IN ('a', '*', 'w', 'd')) THEN
    RAISE EXCEPTION '00639: payment_intents still has a policy that lets clients write';
  END IF;
  IF has_table_privilege('anon', 'public.payment_intents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payment_intents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.payment_intents', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payment_intents', 'DELETE')
     OR has_table_privilege('authenticated', 'public.payment_intents', 'TRUNCATE') THEN
    RAISE EXCEPTION '00639: anon or authenticated can still write payment_intents';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.payment_intents', 'SELECT') THEN
    RAISE EXCEPTION '00639: authenticated lost SELECT on payment_intents (payment history)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'public.payment_intents_provider_txn_key'::regclass
      AND i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION '00639: unique index on the provider transaction id is missing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.process_recharge_refund(uuid,jsonb)'::regprocedure) <> 'f9a2baa4b88dd0d68c955725996c6f31' THEN
    RAISE EXCEPTION 'process_recharge_refund does not have the body of git';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._alert_recharge_refund_shortfall(uuid,uuid,integer,integer)'::regprocedure) <> '03ef5e2fe4d8d2d563ef762d86dfdaa2' THEN
    RAISE EXCEPTION '_alert_recharge_refund_shortfall does not have the body of git';
  END IF;
  IF has_function_privilege('anon', 'public.process_recharge_refund(uuid,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.process_recharge_refund(uuid,jsonb)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public._alert_recharge_refund_shortfall(uuid,uuid,integer,integer)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._alert_recharge_refund_shortfall(uuid,uuid,integer,integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '00639: a client can execute the refund functions';
  END IF;
END
$check$;

RESET lock_timeout;
