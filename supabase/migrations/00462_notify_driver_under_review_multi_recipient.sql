-- ============================================================
-- Migration 00462: driver "under_review" ops email → multiple recipients
--
-- The "Nuevo conductor pendiente de aprobación" ops email
-- (notify_driver_under_review, migs 00138 + 00406) fires correctly when a
-- driver transitions to under_review, but it only ever went to a SINGLE
-- address: platform_config.business_notification_email = 'soporte@tricigo.com'.
-- That support mailbox is not actively monitored by the owner, so in practice
-- "no llega ningún correo" para verificar al conductor en el panel.
--
-- Fix:
--   1) Make the trigger send to EACH address in a comma-separated list, so the
--      record copy (soporte@) AND the owner's actionable inbox both receive it.
--      send-email validates `recipient_email` against a single-address regex and
--      passes it straight to Resend `to:`, so a comma string would be rejected —
--      we must loop and POST once per recipient.
--   2) UPSERT the config so the row always exists (00406 used UPDATE-only, which
--      is a no-op if the key was never inserted) and includes the owner inbox.
--
-- The body below is reproduced verbatim from the live function
-- (pg_get_functiondef) — ONLY the send section changed from one PERFORM to a
-- FOREACH loop. Everything else (the #>>'{}' unwrap, the guards, the
-- EXCEPTION WHEN OTHERS THEN RETURN NEW) is unchanged so we never block
-- onboarding and never lose a feature.
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
  v_recipient    TEXT;
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

  -- business_notification_email may hold a comma-separated list of addresses.
  -- send-email accepts a single recipient_email, so POST once per address.
  FOREACH v_recipient IN ARRAY string_to_array(v_biz_email, ',')
  LOOP
    v_recipient := btrim(v_recipient);
    CONTINUE WHEN v_recipient = '';

    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      body    := jsonb_build_object(
        'template',        'driver_under_review',
        'recipient_email', v_recipient,
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
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;  -- Never block onboarding.
END;
$$;

-- Ensure the config row exists (00406 used UPDATE-only, a no-op if the key was
-- never inserted) and route the notification to the support mailbox (record)
-- AND the owner's inbox (action). Editable later from the admin platform-config
-- page; comma-separated, addresses are trimmed by the trigger.
INSERT INTO platform_config (key, value)
VALUES (
  'business_notification_email',
  '"soporte@tricigo.com"'::jsonb
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = NOW();

-- Verification (run manually after apply):
--   SELECT value #>> '{}' AS biz_emails FROM platform_config
--    WHERE key = 'business_notification_email';
--   -- expected: soporte@tricigo.com
--
-- NOTE: recipient kept as soporte@tricigo.com per owner decision. The trigger
-- supports a comma-separated list (loops + POST per address) and the value is
-- editable from the admin platform-config page, so more inboxes can be added
-- later without a code change.
