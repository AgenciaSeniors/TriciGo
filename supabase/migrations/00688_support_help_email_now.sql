-- 00688: the "Pide ayuda" e-mail goes out with the push, not at the next minute's digest.
--
-- Measured 2026-11-18 over the 32 help requests since 2026-10-26 (ride_assist, Resend, edge logs):
--   * the push to the support staff leaves 0.9 s after the rider's tap (_support_alert, 00683);
--   * the e-mail waited for notify_support_waiting_rides, the per-minute digest: 0 to 58 s after
--     the tap (median ~25 s), and two riders canceled before it ever went out;
--   * Resend accepted and delivered it 1 to 4 s after it was sent.
-- Operators reach the panel through that e-mail's link, so every second of the digest's wait was
-- a second the rider waited too.
--
-- What changes:
--   * _support_help_email(ride) sends one e-mail for that ride to support_alert_email (the same
--     list as the digest) and stamps ride_assist.help_email_sent_at, so the digest skips it.
--   * request_ride_help calls it right after the push, in the rider's transaction. The e-mail is
--     queued with cron_http_post (label support-help-email, watched by check_cron_http_failures)
--     and leaves when the rider's call commits.
--   * Nothing else: the digest keeps sending the "sin conductor" e-mails, and stays the fallback
--     for a help e-mail that could not be queued (no list, no service key, any error): those
--     leave help_email_sent_at empty, and the next digest sends them as before.
--   * It never fails the rider's call: any error is logged to rpc_attempt_log
--     (rpc_name = '_support_help_email', outcome = 'alert_failed').
--
-- No duplicate e-mail: the digest picks a help ride only with help_email_sent_at empty, and reads
-- ride_assist with a snapshot that cannot see the rider's uncommitted stamp. A digest running
-- during the rider's call sees the ride as before the call (no help yet); one that runs after it
-- sees the stamp.
--
-- request_ride_help is patched in place from the live body (md5 64b18c04..., the 00683 body), so
-- nothing else in it can be lost. Rehearsal: supabase/tests/00688/run.sh.

-- ---------------------------------------------------------------------------------------------
-- 1. The help e-mail for one ride.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._support_help_email(p_ride_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_to_raw  text;
  v_rec     record;
  v_key     text;
  v_rcpt    text;
  v_url     text;
  v_subject text;
  v_html    text;
BEGIN
  v_to_raw := public.get_platform_config_text('support_alert_email', '');
  IF position('@' IN COALESCE(v_to_raw, '')) = 0 THEN
    RETURN;  -- no list: the digest sends nothing either
  END IF;

  SELECT r.id, r.pickup_address, r.dropoff_address,
         public._ride_type_label(r.service_type, r.ride_mode) AS type_label,
         public._ride_short_code(r.id) AS code,
         GREATEST(0, floor(extract(epoch FROM now() - GREATEST(r.created_at, r.scheduled_at)) / 60))::int AS wait_min
    INTO v_rec
  FROM public.ride_assist ra
  JOIN public.rides r ON r.id = ra.ride_id
  WHERE ra.ride_id = p_ride_id
    AND r.status = 'searching'
    AND ra.help_alert_sent_at IS NOT NULL
    AND ra.help_email_sent_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    -- The digest gets the same key, so it would fail too; logged so the gap is visible.
    RAISE WARNING '_support_help_email: no service role key, the help e-mail for ride % was not sent', p_ride_id;
    PERFORM public.log_rpc_attempt('_support_help_email', auth.uid(), p_ride_id, 'alert_failed',
      jsonb_build_object('error', 'no service role key'));
    RETURN;
  END IF;

  v_url := 'https://admin.tricigo.com/rides/' || p_ride_id::text || '/assist';
  v_subject := 'Pasajero pide ayuda · ' || COALESCE(v_rec.type_label, 'Viaje') || ' · ' || COALESCE(v_rec.code, '');
  -- Every value is non-null: one NULL in a || chain blanks the whole body (CLAUDE.md, 00577).
  -- What the rider typed (the addresses) is escaped.
  v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#111">'
    || '<h2 style="color:#ff4d00;border-bottom:2px solid #ff4d00;padding-bottom:8px">'
    || public._html_escape(v_subject) || '</h2>'
    || '<p>El pasajero tocó <b>Pedir ayuda</b>. Lleva ' || v_rec.wait_min::text
    || ' min esperando conductor.</p>'
    || '<p><b>Recorrido:</b> ' || public._html_escape(COALESCE(v_rec.pickup_address, '—'))
    || ' → ' || public._html_escape(COALESCE(v_rec.dropoff_address, '—')) || '</p>'
    || '<p style="margin:24px 0"><a href="' || v_url || '" style="display:inline-block;background:#ff4d00;color:#fff;'
    || 'padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Asistir en el panel</a></p>'
    || '<p style="color:#555;font-size:13px">' || v_url || '</p>'
    || '<p style="color:#777;font-size:12px">Aviso automático de TriciGo (00688): sale en cuanto el pasajero pide ayuda. No responder.</p>'
    || '</body></html>';
  IF v_html IS NULL THEN
    RAISE EXCEPTION 'empty help e-mail';
  END IF;

  FOR v_rcpt IN
    SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
  LOOP
    PERFORM public.cron_http_post('support-help-email',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
      body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', '[TriciGo] ' || v_subject,
                                    -- raw HTML: the legacy path of send-email's resolveTemplate (00503, 00538)
                                    'template', v_html, 'data', '{}'::jsonb));
  END LOOP;

  UPDATE public.ride_assist SET help_email_sent_at = now() WHERE ride_id = p_ride_id;
EXCEPTION WHEN OTHERS THEN
  -- An e-mail never fails the rider's button. Nothing above is kept (the queued requests and the
  -- stamp roll back with this block), so the next digest sends it.
  RAISE WARNING '_support_help_email failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
  PERFORM public.log_rpc_attempt('_support_help_email', auth.uid(), p_ride_id, 'alert_failed',
    jsonb_build_object('error', SQLERRM));
END;
$function$;

REVOKE ALL ON FUNCTION public._support_help_email(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._support_help_email(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. request_ride_help sends it right after the push (patched in place from the live body).
-- ---------------------------------------------------------------------------------------------
DO $patch$
DECLARE
  c_old_md5 constant text := '64b18c0490670a3a0163ada4acefd79d';  -- 00683, live on 2026-11-18
  c_target  constant text := E'      PERFORM public._support_alert(p_ride_id, ''help'');\n';
  c_new     constant text := E'      PERFORM public._support_alert(p_ride_id, ''help'');\n'
                          || E'      PERFORM public._support_help_email(p_ride_id);  -- 00688: the e-mail now, not at the next digest\n';
  v_src text;
  v_def text;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid) INTO v_src, v_def
  FROM pg_proc WHERE oid = 'public.request_ride_help(uuid)'::regprocedure;

  IF position('_support_help_email(' IN v_src) > 0 THEN
    RAISE NOTICE '00688: request_ride_help already sends the help e-mail';
    RETURN;
  END IF;
  IF md5(v_src) <> c_old_md5 THEN
    RAISE EXCEPTION '00688: request_ride_help is not the 00683 body (md5 %); refusing to patch it', md5(v_src);
  END IF;
  IF (length(v_def) - length(replace(v_def, c_target, ''))) / length(c_target) <> 1 THEN
    RAISE EXCEPTION '00688: the _support_alert call is not exactly once in request_ride_help';
  END IF;

  EXECUTE replace(v_def, c_target, c_new);
END
$patch$;

-- ---------------------------------------------------------------------------------------------
-- 3. Self-checks.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
  v_n   integer;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.request_ride_help(uuid)'::regprocedure;
  v_n := (length(v_src) - length(replace(v_src, '_support_help_email(', ''))) / length('_support_help_email(');
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00688 check: request_ride_help calls _support_help_email % times', v_n;
  END IF;
  IF position('_support_help_email(' IN v_src) < position('_support_alert(p_ride_id, ''help'')' IN v_src) THEN
    RAISE EXCEPTION '00688 check: the e-mail must go after the push';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.request_ride_help(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00688 check: riders lost EXECUTE on request_ride_help';
  END IF;
  IF has_function_privilege('anon', 'public._support_help_email(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._support_help_email(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00688 check: clients can run _support_help_email';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public._support_help_email(uuid)'::regprocedure) THEN
    RAISE EXCEPTION '00688 check: _support_help_email must be SECURITY DEFINER';
  END IF;
END
$check$;
