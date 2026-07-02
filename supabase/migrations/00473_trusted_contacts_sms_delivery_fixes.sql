-- ============================================================
-- 00473: Trusted contacts — SMS delivery fixes (audit 2026-07-02)
--
-- Findings addressed (first full audit of the trusted-contacts /
-- live-trip-share feature; it had NEVER fired end-to-end in prod):
--
--  A1  Phones were stored raw (local 8-digit "5XXXXXXX" accepted by
--      isValidCubanPhone) and sent as-is to D7 → SMS undeliverable.
--      Fix: normalize server-side on write (mirrors
--      tg_users_normalize_phone / 00461) + idempotent backfill +
--      defensive normalization at send time.
--
--  A2  The "arrived safely" SMS lived client-side and always died
--      with 401 (send-sms EF is service-role-only). Fix: new server
--      trigger notify_trusted_contacts_on_complete.
--
--  A4  notify_trusted_contacts_on_accept drifted from git: prod was
--      hand-patched to tricigo.com (git 00097 still had the dead
--      tricigo.app domain). This migration reconciles the LIVE prod
--      body into git and improves it: RAISE WARNING on failure
--      (00425 pattern), user_id in the payload (sms_log audit),
--      normalized phone at send time.
--
--  A5  share_access_log (00097, "safety forensics") had no writers.
--      Fix: log_share_access RPC, called fire-and-forget by the
--      public tracking page.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Normalize trusted_contacts.phone on write (A1)
--    Mirrors tg_users_normalize_phone (00461). Covers app builds
--    that still save raw local numbers.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_trusted_contacts_normalize_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    NEW.phone := public._normalize_cuban_phone(NEW.phone);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trusted_contacts_normalize_phone ON public.trusted_contacts;
CREATE TRIGGER trg_trusted_contacts_normalize_phone
  BEFORE INSERT OR UPDATE OF phone ON public.trusted_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_trusted_contacts_normalize_phone();

-- Idempotent backfill. Skips rows whose normalized phone would
-- collide with an existing (user_id, phone) sibling.
UPDATE public.trusted_contacts tc
SET phone = public._normalize_cuban_phone(tc.phone),
    updated_at = NOW()
WHERE tc.phone IS DISTINCT FROM public._normalize_cuban_phone(tc.phone)
  AND NOT EXISTS (
    SELECT 1 FROM public.trusted_contacts d
    WHERE d.user_id = tc.user_id
      AND d.id <> tc.id
      AND d.phone = public._normalize_cuban_phone(tc.phone)
  );

-- ------------------------------------------------------------
-- 2) Reconcile notify_trusted_contacts_on_accept (A4)
--    Body reproduced from the LIVE prod function (which already
--    used tricigo.com), with three additions:
--      * phone normalized at send time (legacy rows / old builds)
--      * user_id in the payload so sms_log is attributable
--      * RAISE WARNING instead of a silent swallow (00425 pattern)
--    The trg_notify_trusted_contacts trigger itself is unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_contact RECORD; v_rider_name TEXT; v_share_url TEXT; v_sms_body TEXT; v_payload JSONB;
  v_service_key TEXT;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status <> 'searching' THEN RETURN NEW; END IF;
  IF NEW.share_token IS NULL THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;
  v_share_url := 'https://tricigo.com/track/share/' || NEW.share_token;

  FOR v_contact IN
    SELECT tc.name AS contact_name,
           public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id AND tc.auto_share = true
  LOOP
    v_sms_body := COALESCE(v_rider_name, 'Alguien') || ' ha iniciado un viaje con TriciGo. Sigue en tiempo real: ' || v_share_url;
    v_payload := jsonb_build_object(
      'user_id', NEW.customer_id::text,
      'phone', v_contact.contact_phone,
      'body', v_sms_body,
      'ride_id', NEW.id::text,
      'event_type', 'trusted_contact_share'
    );
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
      headers := jsonb_build_object('Content-Type','application/json','apikey',v_service_key,'Authorization','Bearer '||v_service_key),
      body := v_payload
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block ride acceptance because of a notification failure — but DO log it.
  RAISE WARNING '[notify_trusted_contacts_on_accept] dispatch FAILED for ride % (customer %): % %',
    NEW.id, NEW.customer_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 3) "Arrived safely" SMS on completion (A2)
--    Replaces the dead client-side path (useRide → send-sms with a
--    user JWT → 401). Fires once: the ride FSM allows a single
--    transition into 'completed'.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_contact RECORD; v_rider_name TEXT; v_sms_body TEXT; v_payload JSONB;
  v_service_key TEXT;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;

  FOR v_contact IN
    SELECT public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id AND tc.auto_share = true
  LOOP
    v_sms_body := '✅ ' || COALESCE(v_rider_name, 'Tu contacto') || ' llegó a su destino de forma segura. — TriciGo';
    v_payload := jsonb_build_object(
      'user_id', NEW.customer_id::text,
      'phone', v_contact.contact_phone,
      'body', v_sms_body,
      'ride_id', NEW.id::text,
      'event_type', 'trip_completed_safe'
    );
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
      headers := jsonb_build_object('Content-Type','application/json','apikey',v_service_key,'Authorization','Bearer '||v_service_key),
      body := v_payload
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block ride completion (payment path) because of a notification failure.
  RAISE WARNING '[notify_trusted_contacts_on_complete] dispatch FAILED for ride % (customer %): % %',
    NEW.id, NEW.customer_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_trusted_contacts_complete ON public.rides;
CREATE TRIGGER trg_notify_trusted_contacts_complete
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status <> 'completed')
  EXECUTE FUNCTION public.notify_trusted_contacts_on_complete();

-- ------------------------------------------------------------
-- 4) Wire share_access_log (A5)
--    Fire-and-forget forensics insert from the public tracking
--    page. Only logs tokens that resolve to a live (non-expired)
--    ride, so anon callers cannot spam arbitrary rows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_share_access(p_token TEXT, p_user_agent TEXT DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_ride_id UUID;
BEGIN
  IF p_token IS NULL OR length(p_token) <> 24 THEN RETURN; END IF;

  SELECT id INTO v_ride_id
  FROM rides
  WHERE share_token = p_token
    AND (share_token_expires_at IS NULL OR share_token_expires_at > NOW())
  LIMIT 1;

  IF v_ride_id IS NULL THEN RETURN; END IF;

  INSERT INTO share_access_log (share_token, ride_id, user_agent)
  VALUES (p_token, v_ride_id, left(p_user_agent, 300));
EXCEPTION WHEN OTHERS THEN
  -- Forensics must never break the public tracking page.
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.log_share_access(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_share_access(TEXT, TEXT) TO anon, authenticated, service_role;
