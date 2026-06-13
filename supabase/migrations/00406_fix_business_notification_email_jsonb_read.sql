-- ============================================================
-- Migration 00406: fix notify_driver_under_review jsonb read
--
-- The "nuevo conductor pendiente de aprobación" ops email (00138)
-- reads platform_config.value into a TEXT variable with a bare
-- `SELECT value INTO v_biz_email`. But platform_config.value is
-- JSONB — so the assignment uses the canonical jsonb→text cast,
-- which KEEPS the surrounding quotes:
--
--   jsonb '"soporte@tricigo.com"'  →  text '"soporte@tricigo.com"'
--
-- That quoted string would be sent verbatim as `recipient_email`,
-- producing an invalid address. It also broke the empty-skip guard:
-- an empty config reads as text '""' (2 chars), which is NOT '' , so
-- `v_biz_email = ''` never matched and the trigger fell through to a
-- doomed send (swallowed by the EXCEPTION handler). The bug was never
-- noticed because business_notification_email was always empty — the
-- email had simply never fired.
--
-- Fix: unwrap the JSONB scalar with `#>> '{}'` so v_biz_email holds
-- the plain string. This also makes the empty-skip work (jsonb '""'
-- #>> '{}' = '').  Only that one line changes vs the live 00138 body.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_driver_under_review()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_driver_name  TEXT;
  v_driver_phone TEXT;
  v_driver_email TEXT;
  v_biz_email    TEXT;
  v_service_key  TEXT;
  v_headers      JSONB;
BEGIN
  IF NEW.status <> 'under_review' OR OLD.status = 'under_review' THEN
    RETURN NEW;
  END IF;

  -- platform_config.value is JSONB — unwrap the scalar string so we
  -- don't carry the surrounding quotes into the recipient address.
  SELECT value #>> '{}' INTO v_biz_email
  FROM platform_config
  WHERE key = 'business_notification_email'
  LIMIT 1;

  IF v_biz_email IS NULL OR v_biz_email = '' THEN
    RETURN NEW;  -- Not configured; skip silently.
  END IF;

  SELECT full_name, phone, email
  INTO v_driver_name, v_driver_phone, v_driver_email
  FROM users
  WHERE id = NEW.user_id
  LIMIT 1;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;  -- No vault secret; skip silently.
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers,
    body    := jsonb_build_object(
      'template',        'driver_under_review',
      'recipient_email', v_biz_email,
      'subject',         'Nuevo conductor pendiente de aprobación — TriciGo',
      'locale',          'es',
      'data', jsonb_build_object(
        'driver_id',     NEW.id::text,
        'user_id',       NEW.user_id::text,
        'full_name',     COALESCE(v_driver_name, '—'),
        'phone',         COALESCE(v_driver_phone, '—'),
        'email',         COALESCE(v_driver_email, '—'),
        'submitted_at',  NOW()
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;  -- Never block onboarding.
END;
$$;

-- Enable the ops email by pointing it at the support mailbox (same one
-- that already receives the driver-contract admin copy). Stored as a
-- JSON string to match the JSONB column. Editable later from the admin
-- platform-config page or with another UPDATE.
UPDATE platform_config
SET value = '"soporte@tricigo.com"'::jsonb, updated_at = NOW()
WHERE key = 'business_notification_email';

-- Verification (run manually after apply):
--   SELECT value #>> '{}' AS biz_email FROM platform_config
--    WHERE key = 'business_notification_email';
--   -- expected: soporte@tricigo.com  (no quotes)
