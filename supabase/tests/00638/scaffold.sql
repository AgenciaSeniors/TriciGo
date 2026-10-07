-- Scaffold for the 00638 rehearsal: the two trigger functions exactly as prod
-- serves them (pg_get_functiondef, 2026-10-07; md5(prosrc) 9d170884… / 1432
-- and e702e178… / 1150), their triggers, and stubs for what they call.
-- net.http_post records the request instead of sending it, so the tests can
-- read the push text each trigger would have sent.
-- Owner: tricigo_owner, a non-superuser like prod's postgres.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END
$roles$;

GRANT CREATE, USAGE ON SCHEMA public TO tricigo_owner;
CREATE SCHEMA net AUTHORIZATION tricigo_owner;

SET SESSION AUTHORIZATION tricigo_owner;

CREATE TABLE net.sent (
  id      bigserial PRIMARY KEY,
  url     text,
  headers jsonb,
  body    jsonb
);

CREATE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.sent (url, headers, body) VALUES (url, headers, body) RETURNING id;
$$;

CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $$ SELECT 'test-service-key'::text $$;
CREATE FUNCTION public.get_current_exchange_rate() RETURNS numeric LANGUAGE sql AS $$ SELECT 500::numeric $$;

CREATE TABLE public.payment_intents (
  id         uuid PRIMARY KEY,
  user_id    uuid,
  status     text NOT NULL,
  amount_cup integer,
  amount_usd numeric
);

CREATE TABLE public.rides (
  id                        uuid PRIMARY KEY,
  customer_id               uuid,
  status                    text NOT NULL,
  gps_override_requested_at timestamptz,
  gps_override_confirmed_at timestamptz
);

-- ── prod body, verbatim (pg_get_functiondef) ──
CREATE OR REPLACE FUNCTION public.notify_payment_intent_failure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_title       TEXT;
  v_body        TEXT;
  v_amount_cup  INTEGER;
  v_service_key TEXT;
  v_headers     JSONB;
BEGIN
  IF NEW.status <> 'failed' OR OLD.status = 'failed' THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount_cup := COALESCE(NEW.amount_cup, ROUND(NEW.amount_usd * get_current_exchange_rate())::integer);

  v_title := 'Pago no completado';
  v_body  := 'Tu recarga de ' ||
             CASE WHEN v_amount_cup IS NOT NULL THEN to_char(v_amount_cup, 'FM999G999G990') || ' CUP ' ELSE '' END ||
             'no pudo procesarse. Intentalo nuevamente.';

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := jsonb_build_object(
      'user_id', NEW.user_id::text,
      'title',   v_title,
      'body',    v_body,
      'category', 'payment',
      'data', jsonb_build_object(
        'type',              'payment',
        'payment_intent_id', NEW.id::text,
        'status',            'failed'
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$
;

-- ── prod body, verbatim (pg_get_functiondef) ──
CREATE OR REPLACE FUNCTION public.notify_rider_gps_override_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_service_key TEXT;
  v_headers JSONB;
  v_payload JSONB;
  v_data JSONB;
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_data := jsonb_build_object(
    'type',    'ride',
    'ride_id', NEW.id::text,
    'status',  NEW.status::text
  );

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  v_payload := jsonb_build_object(
    'user_id',  NEW.customer_id::text,
    'title',    '¿Ves a tu conductor?',
    'body',     'Tu conductor dice que está cerca. Abrí la app y confirmá si lo ves.',
    'category', 'ride',
    'data',     v_data
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_rider_gps_override_request] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

-- Grants as in prod: the payment function only for its owner and
-- service_role; the GPS one also keeps PUBLIC's default EXECUTE.
REVOKE EXECUTE ON FUNCTION public.notify_payment_intent_failure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_payment_intent_failure() TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_rider_gps_override_request() TO service_role;

COMMENT ON FUNCTION public.notify_payment_intent_failure() IS
  'C2: Sends push notification when a payment_intent flips to failed. The send-push edge function inserts the inbox row.';
COMMENT ON FUNCTION public.notify_rider_gps_override_request() IS
  '00357: empuja al pasajero un push (send-push) cuando el gate GPS pide confirmar la llegada del conductor. Cubre el gap donde la recogida no avisaba al pasajero con la app en segundo plano.';

-- Triggers as in prod (pg_get_triggerdef).
CREATE TRIGGER trg_notify_payment_intent_failure AFTER UPDATE OF status ON public.payment_intents FOR EACH ROW WHEN (((new.status = 'failed'::text) AND (old.status IS DISTINCT FROM 'failed'::text))) EXECUTE FUNCTION public.notify_payment_intent_failure();
CREATE TRIGGER trg_notify_gps_override AFTER UPDATE OF gps_override_requested_at ON public.rides FOR EACH ROW WHEN (((new.gps_override_requested_at IS NOT NULL) AND (new.gps_override_requested_at IS DISTINCT FROM old.gps_override_requested_at) AND ((new.gps_override_confirmed_at IS NULL) OR (new.gps_override_confirmed_at < new.gps_override_requested_at)))) EXECUTE FUNCTION public.notify_rider_gps_override_request();

RESET SESSION AUTHORIZATION;
