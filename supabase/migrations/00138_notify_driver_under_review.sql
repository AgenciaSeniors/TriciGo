-- ============================================================
-- Migration 00138: Email admin when driver enters under_review (N3)
--
-- When a driver finishes uploading documents the status transitions
-- from 'pending_verification' to 'under_review'. Previously nobody
-- was notified — the admin only noticed when they reopened the
-- /drivers queue. This trigger fires an email to the business
-- notification address (platform_config.business_notification_email)
-- so the queue gets attention without polling.
--
-- Silent if the business email isn't configured or if the vault key
-- is missing. Never blocks the driver onboarding flow.
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
  -- Only on transition INTO under_review
  IF NEW.status <> 'under_review' OR OLD.status = 'under_review' THEN
    RETURN NEW;
  END IF;

  SELECT value INTO v_biz_email
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

  -- Generic template: send-email falls back to a JSON data render that
  -- still looks like a TriciGo-branded card. Good enough for an ops
  -- heads-up; richer template can be added later.
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

DROP TRIGGER IF EXISTS trg_notify_driver_under_review ON driver_profiles;
CREATE TRIGGER trg_notify_driver_under_review
  AFTER UPDATE OF status ON driver_profiles
  FOR EACH ROW
  WHEN (NEW.status = 'under_review' AND OLD.status IS DISTINCT FROM 'under_review')
  EXECUTE FUNCTION public.notify_driver_under_review();

REVOKE EXECUTE ON FUNCTION public.notify_driver_under_review() FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION public.notify_driver_under_review() IS
  'N3 ride-flow review: emails the business notification address when a driver submits for review.';
