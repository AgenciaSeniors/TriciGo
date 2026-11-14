-- 00681: automatic apology when a ride finds no driver.
-- Spec: docs/superpowers/specs/2026-11-14-missed-ride-auto-apology-design.md. Builds on 00674.
--
-- Every minute, grant_missed_ride_apologies() looks at the passenger rides canceled with no driver
-- after waiting support_alert_after_s (the "Sin chofer" rule) in the last two hours. Each person in
-- 00674's segment who has a confirmed phone and never got the apology coupon (the WhatsApp path
-- shares the once-per-phone claim) gets:
--   - the coupon on their next ride (00674's grant),
--   - a support ticket "waiting_user" with an apology from support,
--   - a push (category system, so a marketing opt-out does not silence it).
-- Every ride it looks at is recorded in missed_ride_auto_apologies with the outcome, so it is never
-- looked at twice. A ride whose block fails is logged in rpc_attempt_log and retried next minute;
-- when every ride of a run fails, the run fails and check_cron_sql_failures reports it.
-- The migration also creates the 10 % grant-only promotion PERDON10 when no grant-only promotion
-- exists. Marketing can edit or pause it in Promociones.

DO $need$
BEGIN
  IF to_regclass('public.promotion_grants') IS NULL
     OR to_regprocedure('public._missed_rider_summary(uuid)') IS NULL
     OR to_regprocedure('public._missed_ride_current_coupon()') IS NULL THEN
    RAISE EXCEPTION '00681 needs 00674 (the apology coupon) applied first';
  END IF;
END
$need$;

-- 1. Settings. The start date keeps the job from writing to people who failed before it existed.
INSERT INTO public.platform_config (key, value) VALUES
  ('missed_ride_auto_apology_enabled', '"true"'::jsonb),
  ('missed_ride_auto_apology_since', to_jsonb(now()))
ON CONFLICT (key) DO NOTHING;

-- 2. The apology promotion, unless one exists (a paused one is a decision: leave it).
INSERT INTO public.promotions (code, type, discount_percent, is_active, is_public, first_ride_only,
                               grant_only, notify_on_publish, title_es)
SELECT 'PERDON10', 'percentage_discount'::public.promotion_type, 10, true, false, false, true, false, 'Cupón de disculpa'
 WHERE NOT EXISTS (SELECT 1 FROM public.promotions WHERE grant_only OR code = 'PERDON10');

-- 3. What the job did with each ride (lock table).
CREATE TABLE IF NOT EXISTS public.missed_ride_auto_apologies (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('granted', 'already_given', 'no_phone', 'no_coupon', 'not_eligible')),
  grant_id uuid REFERENCES public.promotion_grants(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES public.support_tickets(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS missed_ride_auto_apologies_user_idx ON public.missed_ride_auto_apologies (user_id);
ALTER TABLE public.missed_ride_auto_apologies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.missed_ride_auto_apologies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missed_ride_auto_apologies TO service_role;

-- The job's scan, every minute.
SET lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS rides_canceled_no_driver_idx ON public.rides (canceled_at)
  WHERE status = 'canceled' AND driver_id IS NULL;
RESET lock_timeout;

-- 4. The discount, as the apology says it: "10 % de descuento", "12,5 % de descuento",
-- "500 CUP de descuento". NULL when the promotion gives nothing a text can promise.
CREATE OR REPLACE FUNCTION public._apology_discount_text(p_promotion_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
           WHEN p.type = 'fixed_discount' AND p.discount_fixed_cup > 0
             THEN p.discount_fixed_cup::text || ' CUP de descuento'
           WHEN p.type = 'percentage_discount' AND p.discount_percent > 0
             THEN replace(trim_scale(p.discount_percent)::text, '.', ',') || ' % de descuento'
         END
    FROM public.promotions p
   WHERE p.id = p_promotion_id;
$function$;
REVOKE ALL ON FUNCTION public._apology_discount_text(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._apology_discount_text(uuid) TO service_role;

-- 5. The job.
CREATE OR REPLACE FUNCTION public.grant_missed_ride_apologies()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_platform constant uuid := '00000000-0000-0000-0000-000000000001';
  c_push_url constant text := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push';
  v_enabled text;
  v_since timestamptz;
  v_wait interval;
  v_key text;
  v_ride record;
  v_eligible boolean;
  v_coupon uuid;
  v_discount text;
  v_claim text;
  v_grant_id uuid;
  v_ticket_id uuid;
  v_outcome text;
  v_name text;
  v_done integer := 0;
  v_failed integer := 0;
BEGIN
  -- One run at a time: two overlapping runs would race for the same rides.
  IF NOT pg_try_advisory_xact_lock(hashtext('grant_missed_ride_apologies')) THEN
    RETURN 0;
  END IF;

  SELECT value #>> '{}' INTO v_enabled FROM platform_config WHERE key = 'missed_ride_auto_apology_enabled';
  IF lower(coalesce(v_enabled, 'true')) IN ('false', '0', 'off') THEN
    RETURN 0;
  END IF;
  SELECT (value #>> '{}')::timestamptz INTO v_since FROM platform_config WHERE key = 'missed_ride_auto_apology_since';
  IF v_since IS NULL THEN
    RAISE EXCEPTION 'grant_missed_ride_apologies: platform_config.missed_ride_auto_apology_since is missing'
      USING DETAIL = 'missed_ride_apology_no_since';
  END IF;
  v_wait := make_interval(secs => get_platform_config_numeric('support_alert_after_s', 60)::double precision);

  FOR v_ride IN
    SELECT r.id, r.customer_id
      FROM rides r
     WHERE r.status = 'canceled'
       AND r.driver_id IS NULL
       AND COALESCE(r.ride_mode, 'passenger') = 'passenger'
       AND r.canceled_at > GREATEST(v_since, now() - interval '2 hours')
       AND r.canceled_at - GREATEST(r.created_at, COALESCE(r.scheduled_at, r.created_at)) >= v_wait
       AND NOT EXISTS (SELECT 1 FROM missed_ride_auto_apologies a WHERE a.ride_id = r.id)
     ORDER BY r.canceled_at, r.id
     LIMIT 50
  LOOP
    IF v_key IS NULL THEN
      v_key := get_service_role_key();
      IF coalesce(v_key, '') = '' THEN
        RAISE EXCEPTION 'grant_missed_ride_apologies: no service role key in the vault'
          USING DETAIL = 'missed_ride_apology_no_service_key';
      END IF;
    END IF;

    BEGIN
      v_outcome := NULL; v_grant_id := NULL; v_ticket_id := NULL;

      SELECT s.eligible INTO v_eligible FROM _missed_rider_summary(v_ride.customer_id) s;
      IF NOT coalesce(v_eligible, false) THEN
        v_outcome := 'not_eligible';
      ELSIF NOT EXISTS (SELECT 1 FROM auth.users au
                         WHERE au.id = v_ride.customer_id AND au.phone_confirmed_at IS NOT NULL
                           AND coalesce(au.phone, '') <> '') THEN
        v_outcome := 'no_phone';
      ELSIF EXISTS (SELECT 1 FROM promotion_grants g
                     WHERE g.user_id = v_ride.customer_id AND g.source = 'missed_ride') THEN
        v_outcome := 'already_given';
      ELSE
        v_coupon := _missed_ride_current_coupon();
        v_discount := CASE WHEN v_coupon IS NOT NULL THEN _apology_discount_text(v_coupon) END;
        IF v_discount IS NULL THEN
          v_outcome := 'no_coupon';
        ELSE
          v_claim := _claim_reward(v_ride.customer_id, 'missed_ride_coupon');
          IF v_claim = 'taken' THEN
            -- The phone got the apology coupon before, on this or another account.
            v_outcome := 'already_given';
          ELSIF v_claim IS DISTINCT FROM 'claimed' THEN
            v_outcome := 'no_phone';
          ELSE
            INSERT INTO promotion_grants (promotion_id, user_id, source, granted_by)
            VALUES (v_coupon, v_ride.customer_id, 'missed_ride', c_platform)
            RETURNING id INTO v_grant_id;

            SELECT coalesce(split_part(_third_party_person_name(u.full_name), ' ', 1), '')
              INTO v_name FROM users u WHERE u.id = v_ride.customer_id;

            INSERT INTO support_tickets (user_id, ride_id, category, subject, status, priority)
            VALUES (v_ride.customer_id, v_ride.id, 'ride_issue', 'Disculpa por tu viaje sin chofer',
                    'waiting_user', 'low')
            RETURNING id INTO v_ticket_id;
            INSERT INTO ticket_messages (ticket_id, sender_id, message, is_admin)
            VALUES (v_ticket_id, c_platform,
                    CASE WHEN coalesce(v_name, '') <> '' THEN 'Hola ' || v_name || ', ' ELSE 'Hola, ' END
                    || 'sentimos que no encontraras chofer para tu viaje. Para agradecerte la paciencia, '
                    || 'tu próximo viaje tiene ' || v_discount
                    || ': se aplica solo cuando lo pidas. Si necesitas algo más, respóndenos aquí.',
                    true);

            PERFORM cron_http_post('missed-ride-apology',
              url     := c_push_url,
              headers := jsonb_build_object('Content-Type', 'application/json',
                                            'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
              body    := jsonb_build_object(
                           'user_id', v_ride.customer_id::text,
                           'title', 'Perdón, no encontramos chofer',
                           'body', 'Te regalamos ' || v_discount
                                   || ' en tu próximo viaje. Se aplica solo cuando lo pidas.',
                           'category', 'system',
                           'data', jsonb_build_object('event', 'missed_ride_apology',
                                                      'ticket_id', v_ticket_id::text)));
            v_outcome := 'granted';
          END IF;
        END IF;
      END IF;

      INSERT INTO missed_ride_auto_apologies (ride_id, user_id, outcome, grant_id, ticket_id)
      VALUES (v_ride.id, v_ride.customer_id, v_outcome, v_grant_id, v_ticket_id);
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      -- This ride only: its claim, grant, ticket and push are undone, and the next run retries it.
      v_failed := v_failed + 1;
      PERFORM log_rpc_attempt('grant_missed_ride_apologies', NULL, v_ride.id, 'failed',
                              jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
    END;
  END LOOP;

  IF v_failed > 0 AND v_done = 0 THEN
    RAISE EXCEPTION 'grant_missed_ride_apologies: % ride(s) failed, none processed', v_failed
      USING DETAIL = 'missed_ride_apology_all_failed';
  END IF;
  RETURN v_done;
END;
$function$;
REVOKE ALL ON FUNCTION public.grant_missed_ride_apologies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_missed_ride_apologies() TO service_role;

-- 6. Every minute. cron.schedule keeps a paused job paused: switch it back on.
DO $cron$
DECLARE
  v_job bigint;
BEGIN
  v_job := cron.schedule('grant-missed-ride-apologies', '* * * * *', 'SELECT public.grant_missed_ride_apologies();');
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_job AND NOT active) THEN
    PERFORM cron.alter_job(v_job, active := true);
  END IF;
END
$cron$;

-- Pasted from Windows (CRLF), the new bodies carry a carriage return: rewrite them without it.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public._apology_discount_text(uuid)',
                              'public.grant_missed_ride_apologies()']::regprocedure[]
  LOOP
    v_def := pg_catalog.pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 7. Self-checks.
DO $check$
DECLARE
  v_f text;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p
           WHERE p.oid = 'public.grant_missed_ride_apologies()'::regprocedure) THEN
    RAISE EXCEPTION '00681: grant_missed_ride_apologies() must be SECURITY DEFINER';
  END IF;
  FOREACH v_f IN ARRAY ARRAY['public.grant_missed_ride_apologies()', 'public._apology_discount_text(uuid)'] LOOP
    IF pg_catalog.has_function_privilege('anon', v_f, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_f, 'EXECUTE') THEN
      RAISE EXCEPTION '00681: % is open to a client', v_f;
    END IF;
  END LOOP;
  IF pg_catalog.has_table_privilege('anon', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
              WHERE c.oid = 'public.missed_ride_auto_apologies'::regclass) THEN
    RAISE EXCEPTION '00681: missed_ride_auto_apologies is open to a client';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'grant-missed-ride-apologies' AND active) THEN
    RAISE EXCEPTION '00681: the grant-missed-ride-apologies job is not scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.promotions WHERE grant_only) THEN
    RAISE EXCEPTION '00681: no apology promotion exists';
  END IF;
END
$check$;
