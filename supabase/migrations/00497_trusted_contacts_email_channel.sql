-- ============================================================
-- 00497: Trusted contacts — email channel (cost saving)
--
-- D7 Networks SMS costs ~$0.05-0.08 per message. To economize,
-- the two NON-emergency trusted-contact notifications (ride
-- ACCEPTED live-tracking link + ride COMPLETED "arrived safely")
-- now prefer EMAIL when the contact has an email on file, and
-- fall back to SMS (the existing behavior) when it does not.
--
-- Policy: SMS is reserved for authentication and emergency. SOS
-- (notify_trusted_contacts_on_sos, 00474/00475) is UNCHANGED and
-- stays 100% SMS.
--
--   * 1) Add optional `email` column to trusted_contacts.
--   * 2) notify_trusted_contacts_on_accept — per-contact branch:
--        email present -> send-email (template trusted_contact_ride_started)
--        else          -> send-sms (verbatim from 00473)
--   * 3) notify_trusted_contacts_on_complete — same branch with
--        template trusted_contact_ride_completed.
--
-- The two send-email templates must be DEPLOYED before this
-- migration is applied (send-email returns 400 for an unregistered
-- template; the trigger swallows the error and that contact is not
-- notified). See the deploy order in the PR body.
--
-- Bodies reproduced verbatim from the LIVE prod functions
-- (00473:75-174) with only the email branch added. Everything else
-- is preserved: SECURITY DEFINER, state guards, _normalize_cuban_phone
-- on the SMS path, get_service_role_key(), and the RAISE WARNING /
-- RETURN NEW guard so a notification failure never blocks the ride.
-- The triggers themselves (trg_notify_trusted_contacts /
-- trg_notify_trusted_contacts_complete) are NOT recreated.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Optional email column
-- ------------------------------------------------------------
ALTER TABLE public.trusted_contacts ADD COLUMN IF NOT EXISTS email TEXT;

-- ------------------------------------------------------------
-- 2) Ride ACCEPTED — email if the contact has one, else SMS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_contact RECORD; v_rider_name TEXT; v_share_url TEXT; v_sms_body TEXT; v_payload JSONB;
  v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status <> 'searching' THEN RETURN NEW; END IF;
  IF NEW.share_token IS NULL THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;
  v_share_url := 'https://tricigo.com/track/share/' || NEW.share_token;
  v_headers := jsonb_build_object('Content-Type','application/json','apikey',v_service_key,'Authorization','Bearer '||v_service_key);

  FOR v_contact IN
    SELECT tc.name AS contact_name,
           tc.email AS contact_email,
           public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id AND tc.auto_share = true
  LOOP
    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN
      -- Cost-saving path: email
      v_payload := jsonb_build_object(
        'template', 'trusted_contact_ride_started',
        'recipient_email', v_contact.contact_email,
        'data', jsonb_build_object(
          'contact_name', COALESCE(v_contact.contact_name, ''),
          'rider_name', COALESCE(v_rider_name, 'Alguien'),
          'share_url', v_share_url
        )
      );
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
        headers := v_headers,
        body := v_payload
      );
    ELSE
      -- Fallback: SMS (verbatim from 00473)
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
        headers := v_headers,
        body := v_payload
      );
    END IF;
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
-- 3) Ride COMPLETED ("arrived safely") — email if present, else SMS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_contact RECORD; v_rider_name TEXT; v_sms_body TEXT; v_payload JSONB;
  v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;
  v_headers := jsonb_build_object('Content-Type','application/json','apikey',v_service_key,'Authorization','Bearer '||v_service_key);

  FOR v_contact IN
    SELECT tc.name AS contact_name,
           tc.email AS contact_email,
           public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id AND tc.auto_share = true
  LOOP
    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN
      -- Cost-saving path: email
      v_payload := jsonb_build_object(
        'template', 'trusted_contact_ride_completed',
        'recipient_email', v_contact.contact_email,
        'data', jsonb_build_object(
          'contact_name', COALESCE(v_contact.contact_name, ''),
          'rider_name', COALESCE(v_rider_name, 'Tu contacto')
        )
      );
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
        headers := v_headers,
        body := v_payload
      );
    ELSE
      -- Fallback: SMS (verbatim from 00473)
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
        headers := v_headers,
        body := v_payload
      );
    END IF;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block ride completion (payment path) because of a notification failure.
  RAISE WARNING '[notify_trusted_contacts_on_complete] dispatch FAILED for ride % (customer %): % %',
    NEW.id, NEW.customer_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;
