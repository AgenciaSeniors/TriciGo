-- ============================================================
-- 00365 — Fix "new device" login email rendering the raw key as body
--
-- SYMPTOM: on login, users received a security email whose body was
-- literally the string `security_new_device` (sent from noreply@tricigo.com,
-- subject "🔐 Inicio de sesión nuevo — TriciGo"). Verified in prod inbox:
-- good email on 2026-05-08, broken from 2026-05-12 onward.
--
-- ROOT CAUSE: the email is sent by the trigger function
-- public.send_security_new_device_email() (AFTER INSERT ON auth.sessions,
-- trigger trg_send_security_new_device_email) via pg_net → send-email EF.
-- It posted `template: 'security_new_device'`. That key is NOT in the EF's
-- template registry (supabase/functions/_shared/email-templates/index.ts).
-- send-email's resolveTemplate() falls back to treating an UNREGISTERED
-- `template` string as the raw HTML body (legacy "template-as-string" path),
-- so the body became the literal "security_new_device".
-- The registry was reworked on 2026-05-12 (+ PR #311) and the new-device
-- template was registered under the key `new_device_login`, but this orphan
-- trigger function (created manually in prod, never tracked in git) kept
-- calling the old key. Classic "renamed but a caller kept the old key" bug.
--
-- NOTE: this function/trigger were never in the repo. This migration brings
-- the function under version control AND fixes it.
--
-- FIX: call the REGISTERED key `new_device_login` and pass data matching its
-- NewDeviceLoginData shape: { email, date, ip, device, os }. Everything else
-- (the 30-day same-user_agent dedup, the guards, the swallow-all EXCEPTION so
-- a flaky email never blocks login) is preserved verbatim.
-- ============================================================

CREATE OR REPLACE FUNCTION public.send_security_new_device_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_existing_count INTEGER;
  v_user_agent TEXT; v_payload JSONB; v_service_key TEXT; v_headers JSONB;
  v_local TIMESTAMP; v_date_str TEXT;
  v_months TEXT[] := ARRAY['enero','febrero','marzo','abril','mayo','junio',
                           'julio','agosto','septiembre','octubre','noviembre','diciembre'];
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  v_user_agent := COALESCE(NEW.user_agent, '');
  IF v_user_agent = '' THEN RETURN NEW; END IF;

  -- Dedup: skip if this user already had a session with the same user_agent
  -- in the last 30 days (only alert on a genuinely "new" device/UA).
  SELECT COUNT(*) INTO v_existing_count
  FROM auth.sessions s
  WHERE s.user_id = NEW.user_id AND s.id <> NEW.id
    AND s.user_agent = v_user_agent
    AND s.created_at > NOW() - INTERVAL '30 days';
  IF v_existing_count > 0 THEN RETURN NEW; END IF;

  SELECT u.email, u.full_name INTO v_email, v_full_name
  FROM public.users u WHERE u.id = NEW.user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  -- Spanish-formatted local timestamp (America/Havana),
  -- e.g. "01 de junio de 2026, 09:24" — matches the template's "Fecha" row.
  v_local := NEW.created_at AT TIME ZONE 'America/Havana';
  v_date_str := to_char(v_local, 'DD') || ' de '
             || v_months[EXTRACT(MONTH FROM v_local)::int] || ' de '
             || to_char(v_local, 'YYYY') || ', ' || to_char(v_local, 'HH24:MI');

  -- Use the REGISTERED template key 'new_device_login' (was the unregistered
  -- 'security_new_device'). Data keys match NewDeviceLoginData.
  v_payload := jsonb_build_object(
    'template', 'new_device_login',
    'recipient_email', v_email,
    'subject', '🔐 Inicio de sesión nuevo — TriciGo',
    'data', jsonb_build_object(
      'email',  v_email,
      'date',   v_date_str,
      'ip',     COALESCE(NEW.ip::text, ''),
      'device', v_user_agent,
      'os',     ''
    )
  );
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers,
    body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;
