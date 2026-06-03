-- ============================================================
-- 00375 — Bring the orphan email-notification triggers into git
--          + give gifts their own dedicated email.
--
-- CONTEXT
-- Six email-notification trigger functions were created by hand in
-- production and were NEVER tracked in git (confirmed: `grep` of the
-- repo + git history finds none of them). All six posted to the
-- send-email Edge Function with a `template` key that was NOT in the
-- EF's template registry, so send-email's resolveTemplate() fell back
-- to the legacy "template-string-as-HTML" path and every one of these
-- emails went out with a BODY that was the literal template key:
--
--   trigger / table                       broken template key
--   ------------------------------------- --------------------------
--   trg_send_driver_payout_email          'driver_payout'
--     (wallet_transfers AFTER INSERT)      → this is what made a GIFT
--                                            arrive with body "driver_payout"
--   trg_send_cargo_bonus_email            'driver_payout'
--     (ledger_transactions, cargo_bonus:%)
--   trg_send_delivery_receipt             'delivery_receipt_customer'
--     (rides completed, cargo)
--   trg_send_first_ride_email             'first_ride_celebration'
--     (rides completed, passenger, 1st)
--   trg_send_payment_failed_email         'payment_failed'
--     (payment_intents → failed)
--   trg_send_driver_status_email          'driver_approved' /
--     (driver_profiles status)             'driver_rejected' / 'driver_suspended'
--
-- Same class of bug previously fixed for 'driver_under_review' and
-- 'security_new_device'→'new_device_login' (migration 00365). The fix
-- is fix-forward: the matching templates are now registered in
-- supabase/functions/_shared/email-templates/ (deploy the send-email
-- EF alongside this migration).
--
-- WHAT THIS MIGRATION DOES
--   1. Re-creates the six functions VERBATIM as they exist in prod so
--      they live under version control. The ONLY behavioural change is
--      in send_driver_payout_email(): when the wallet_transfer is a
--      gift (kind='gift', not a reversal) it now sends the dedicated
--      'gift_received' email (who sent it + note) instead of the
--      generic 'driver_payout' "Pago recibido" one.
--   2. Re-asserts the six triggers (DROP IF EXISTS + CREATE) so their
--      wiring is documented in git too. Idempotent.
--
-- No new tables/columns. Depends on the existing helper
-- get_service_role_key() and the pg_net extension (net.http_post),
-- both already present in prod.
-- ============================================================

-- ── 1. wallet_transfers credit → gift_received (gifts) / driver_payout ──
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
  IF NEW.amount IS NULL OR NEW.amount < 5000 THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name, u.role::text
  INTO v_email, v_full_name, v_role
  FROM users u WHERE u.id = NEW.to_user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  IF v_role NOT IN ('driver','super_admin') THEN RETURN NEW; END IF;
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

-- ── 2. ledger cargo bonus → driver_payout ────────────────────────
CREATE OR REPLACE FUNCTION public.send_cargo_bonus_email_from_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_balance INTEGER; v_amount INTEGER;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.idempotency_key NOT LIKE 'cargo_bonus:%' THEN RETURN NEW; END IF;
  IF NEW.status::text <> 'posted' THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.created_by LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  SELECT le.amount, le.balance_after INTO v_amount, v_balance FROM ledger_entries le WHERE le.transaction_id = NEW.id LIMIT 1;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'driver_payout', 'recipient_email', v_email,
    'subject', 'Bonus cargo recibido - TriciGo',
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''), 'amount_cup', COALESCE(v_amount, 0),
      'description', 'Bonus mensajeria +5% por entrega completa con codigo + foto',
      'created_at', NEW.created_at, 'new_balance_cup', COALESCE(v_balance, 0))
  );
  v_headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key);
  PERFORM net.http_post(url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email', headers := v_headers, body := v_payload);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- ── 3. cargo delivery completed → delivery_receipt_customer ──────
CREATE OR REPLACE FUNCTION public.send_delivery_receipt_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_email TEXT; v_customer_name TEXT; v_driver_name TEXT;
  v_dd RECORD; v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.ride_mode <> 'cargo' OR NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_customer_email, v_customer_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;
  IF v_customer_email IS NULL OR v_customer_email = '' THEN RETURN NEW; END IF;
  IF NEW.driver_id IS NOT NULL THEN
    SELECT u.full_name INTO v_driver_name
    FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
    WHERE dp.id = NEW.driver_id LIMIT 1;
  END IF;
  SELECT recipient_name, package_category::text AS package_category,
    delivery_photo_url, delivery_otp_validated_at
  INTO v_dd FROM delivery_details WHERE ride_id = NEW.id LIMIT 1;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'delivery_receipt_customer',
    'recipient_email', v_customer_email,
    'subject', 'Tu envío llegó — recibo TriciGo',
    'data', jsonb_build_object(
      'completed_at', NEW.completed_at,
      'pickup_address', NEW.pickup_address,
      'dropoff_address', NEW.dropoff_address,
      'driver_name', COALESCE(v_driver_name, ''),
      'recipient_name', COALESCE(v_dd.recipient_name, ''),
      'package_category', COALESCE(v_dd.package_category, ''),
      'delivery_photo_url', v_dd.delivery_photo_url,
      'delivery_otp_validated_at', v_dd.delivery_otp_validated_at,
      'final_fare', COALESCE(NEW.final_fare_cup, NEW.estimated_fare_cup, 0)
    )
  );
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers, body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- ── 4. first passenger ride → first_ride_celebration ─────────────
CREATE OR REPLACE FUNCTION public.send_first_ride_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_count INTEGER;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  SELECT COUNT(*) INTO v_count FROM rides r WHERE r.customer_id = NEW.customer_id AND r.status = 'completed';
  IF v_count <> 1 THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'first_ride_celebration', 'recipient_email', v_email,
    'subject', '🎉 Tu primer viaje — TriciGo',
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''))
  );
  v_headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key,'apikey',v_service_key);
  PERFORM net.http_post(url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email', headers := v_headers, body := v_payload);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- ── 5. payment_intents failed → payment_failed ───────────────────
CREATE OR REPLACE FUNCTION public.send_payment_failed_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_amount INTEGER;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'failed' OR OLD.status = 'failed' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  v_amount := COALESCE(NEW.amount_cup, ROUND(NEW.amount_usd * 100)::integer);
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'payment_failed', 'recipient_email', v_email,
    'subject', 'No pudimos procesar tu pago — TriciGo',
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''), 'amount_cup', v_amount, 'reason', '')
  );
  v_headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key,'apikey',v_service_key);
  PERFORM net.http_post(url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email', headers := v_headers, body := v_payload);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- ── 6. driver_profiles status → driver_approved/rejected/suspended ──
CREATE OR REPLACE FUNCTION public.send_driver_status_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_template TEXT; v_subject TEXT;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB; v_reason TEXT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  IF NEW.status::text = 'approved' THEN
    v_template := 'driver_approved'; v_subject := '¡Tu cuenta TriciGo Conductor fue aprobada!';
  ELSIF NEW.status::text = 'rejected' THEN
    v_template := 'driver_rejected'; v_subject := 'Tu solicitud TriciGo Conductor — actualización';
    v_reason := '';
  ELSIF NEW.status::text = 'suspended' THEN
    v_template := 'driver_suspended'; v_subject := 'Tu cuenta TriciGo Conductor fue suspendida';
    v_reason := COALESCE(NEW.suspended_reason, '');
  ELSE
    RETURN NEW;
  END IF;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', v_template, 'recipient_email', v_email, 'subject', v_subject,
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''), 'reason', COALESCE(v_reason, ''))
  );
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

-- ── Triggers (verbatim from prod; idempotent re-assert) ──────────
DROP TRIGGER IF EXISTS trg_send_driver_payout_email ON public.wallet_transfers;
CREATE TRIGGER trg_send_driver_payout_email
  AFTER INSERT ON public.wallet_transfers
  FOR EACH ROW EXECUTE FUNCTION send_driver_payout_email();

DROP TRIGGER IF EXISTS trg_send_cargo_bonus_email ON public.ledger_transactions;
CREATE TRIGGER trg_send_cargo_bonus_email
  AFTER INSERT ON public.ledger_transactions
  FOR EACH ROW WHEN (new.idempotency_key ~~ 'cargo_bonus:%'::text)
  EXECUTE FUNCTION send_cargo_bonus_email_from_ledger();

DROP TRIGGER IF EXISTS trg_send_delivery_receipt ON public.rides;
CREATE TRIGGER trg_send_delivery_receipt
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (
    new.status = 'completed'::ride_status
    AND new.ride_mode = 'cargo'::text
    AND old.status IS DISTINCT FROM 'completed'::ride_status
  )
  EXECUTE FUNCTION send_delivery_receipt_email();

DROP TRIGGER IF EXISTS trg_send_first_ride_email ON public.rides;
CREATE TRIGGER trg_send_first_ride_email
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (
    new.status = 'completed'::ride_status
    AND old.status IS DISTINCT FROM 'completed'::ride_status
    AND new.ride_mode = 'passenger'::text
  )
  EXECUTE FUNCTION send_first_ride_email();

DROP TRIGGER IF EXISTS trg_send_payment_failed_email ON public.payment_intents;
CREATE TRIGGER trg_send_payment_failed_email
  AFTER UPDATE OF status ON public.payment_intents
  FOR EACH ROW WHEN (
    new.status = 'failed'::text
    AND old.status IS DISTINCT FROM 'failed'::text
  )
  EXECUTE FUNCTION send_payment_failed_email();

DROP TRIGGER IF EXISTS trg_send_driver_status_email ON public.driver_profiles;
CREATE TRIGGER trg_send_driver_status_email
  AFTER UPDATE OF status ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION send_driver_status_email();
