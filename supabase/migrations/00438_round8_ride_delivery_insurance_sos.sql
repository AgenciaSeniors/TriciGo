-- 00438_round8_ride_delivery_insurance_sos.sql
-- ============================================================================
-- Pre-launch audit round 8 — DB-only batch (no app rebuild needed):
--   DIC-02 (P1) driver account deletion unblock, DLV-01 (P2) delivery-proof
--   self-validation, DLV-02 (P2, product-decision=enforce) hard cargo proof gate,
--   INS-01 (P2) server-authoritative insurance premium, SOS-01/02 (P2) SOS SMS
--   fan-out throttle.
-- (Deferred: DLV-03 6-digit OTP needs the driver app's 4-digit input widget → v6;
--  DIC-03 wallet auto-zero + PII-02 free-text scrub touch the delete-account EF →
--  separate PR. RT-02 public ride-search channel needs an app rebuild → v6.)
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- DIC-02 (P1): driver account deletion was BROKEN. driver_profiles is CASCADE-
-- deleted with the user, but four children referenced driver_profiles with
-- ON DELETE NO ACTION, so any driver with ≥1 ride (or location event / quest /
-- redemption) could never delete their account (the cascade aborted → the
-- delete-account EF returned 500). Same class as the wallet DIC-01 fix (00422),
-- which was applied to wallet_accounts but never extended here. rides.driver_id is
-- nullable → SET NULL (preserve the ride for the customer, just unlink the driver).
-- The other three are NOT NULL and hold the driver's own operational data (all 0
-- rows in prod) → CASCADE.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.rides DROP CONSTRAINT rides_driver_id_fkey;
ALTER TABLE public.rides ADD CONSTRAINT rides_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES public.driver_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.ride_location_events DROP CONSTRAINT ride_location_events_driver_id_fkey;
ALTER TABLE public.ride_location_events ADD CONSTRAINT ride_location_events_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES public.driver_profiles(id) ON DELETE CASCADE;

ALTER TABLE public.driver_quest_progress DROP CONSTRAINT driver_quest_progress_driver_id_fkey;
ALTER TABLE public.driver_quest_progress ADD CONSTRAINT driver_quest_progress_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES public.driver_profiles(id) ON DELETE CASCADE;

ALTER TABLE public.wallet_redemptions DROP CONSTRAINT wallet_redemptions_driver_id_fkey;
ALTER TABLE public.wallet_redemptions ADD CONSTRAINT wallet_redemptions_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES public.driver_profiles(id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- DLV-01 (P2): the driver could write delivery_details.delivery_otp_validated_at
-- directly via PostgREST (the "Driver updates delivery photo" UPDATE policy has no
-- column restriction), self-validating the recipient OTP — defeating proof-of-
-- delivery and self-unlocking the cargo bonus. Lock delivery_otp /
-- delivery_otp_validated_at to the validate_delivery_otp RPC (which now stamps a
-- trusted flag) + admin; the driver keeps photo-URL writes.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_delivery_details_protect_otp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_delivery_update', true) = '1' THEN RETURN NEW; END IF;

  -- Non-trusted (driver/customer) writes may NOT change the OTP or its validation.
  NEW.delivery_otp              := OLD.delivery_otp;
  NEW.delivery_otp_validated_at := OLD.delivery_otp_validated_at;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_delivery_details_protect_otp ON public.delivery_details;
CREATE TRIGGER trg_delivery_details_protect_otp
  BEFORE UPDATE ON public.delivery_details
  FOR EACH ROW EXECUTE FUNCTION public.tg_delivery_details_protect_otp();

-- validate_delivery_otp stamps the trusted flag before its UPDATE (body verbatim otherwise).
CREATE OR REPLACE FUNCTION public.validate_delivery_otp(p_ride_id uuid, p_otp text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_stored_otp text; v_driver_user uuid; v_allowed boolean;
BEGIN
  SELECT dd.delivery_otp, dp.user_id INTO v_stored_otp, v_driver_user
  FROM rides r
  LEFT JOIN delivery_details dd ON dd.ride_id = r.id
  LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id AND r.ride_mode = 'cargo' LIMIT 1;

  IF v_driver_user IS NULL OR v_driver_user <> auth.uid() THEN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin','super_admin')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
  END IF;

  SELECT allowed INTO v_allowed FROM check_rate_limit('delivery_otp:' || p_ride_id::text, 5, 600);
  IF NOT COALESCE(v_allowed, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'too_many_attempts');
  END IF;

  IF v_stored_otp IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_otp_set'); END IF;
  IF v_stored_otp <> p_otp THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_otp'); END IF;

  -- DLV-01: authorize the protected write of delivery_otp_validated_at.
  PERFORM set_config('app.trusted_delivery_update', '1', true);
  UPDATE delivery_details SET delivery_otp_validated_at = NOW() WHERE ride_id = p_ride_id;
  RETURN jsonb_build_object('success', true);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- DLV-02 (P2, product decision = ENFORCE): a cargo ride could be marked
-- 'completed' (and the fare charged) WITHOUT recipient OTP + delivery photo — the
-- proof only gated the bonus. Add a hard server gate: a non-admin completion of a
-- cargo ride requires delivery_otp_validated_at + delivery_photo_url.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_rides_require_delivery_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF NEW.ride_mode = 'cargo'
     AND NEW.status::text = 'completed'
     AND OLD.status::text IS DISTINCT FROM 'completed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM delivery_details dd
      WHERE dd.ride_id = NEW.id
        AND dd.delivery_otp_validated_at IS NOT NULL
        AND dd.delivery_photo_url IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'cargo_delivery_proof_required: recipient OTP and delivery photo are required to complete a cargo ride';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rides_require_delivery_proof ON public.rides;
CREATE TRIGGER trg_rides_require_delivery_proof
  BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_require_delivery_proof();

-- ─────────────────────────────────────────────────────────────────────────
-- INS-01 (P2): insurance_premium_cup was client-trusted — a rider could set
-- insurance_selected=true with insurance_premium_cup=0 to obtain coverage for free
-- (or an inflated/mismatched value), because nothing recomputed it server-side
-- (no trigger; complete_ride_and_pay reads the column verbatim). Mirror
-- tg_rides_validate_promo_discount: recompute the premium server-side from
-- trip_insurance_configs on every INSERT/UPDATE. Dormant today (0 insured rides)
-- but this is the contract once insurance is enabled.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_rides_validate_insurance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pct numeric;
  v_min integer;
BEGIN
  IF NEW.insurance_selected IS TRUE THEN
    SELECT premium_pct, min_premium_cup INTO v_pct, v_min
    FROM trip_insurance_configs
    WHERE service_type = NEW.service_type AND is_active = true
    LIMIT 1;

    IF v_pct IS NULL THEN
      -- No active insurance config for this service → cannot insure.
      NEW.insurance_selected   := false;
      NEW.insurance_premium_cup := 0;
    ELSE
      NEW.insurance_premium_cup := GREATEST(
        COALESCE(v_min, 0),
        ROUND(COALESCE(NEW.estimated_fare_cup, 0) * v_pct)
      )::integer;
    END IF;
  ELSE
    NEW.insurance_premium_cup := 0;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rides_validate_insurance ON public.rides;
CREATE TRIGGER trg_rides_validate_insurance
  BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_insurance();

-- ─────────────────────────────────────────────────────────────────────────
-- SOS-01/02 (P2): the SOS trusted-contact SMS fan-out (notify_trusted_contacts_on_sos)
-- had NO rate-limit on its primary trigger path → an attacker could loop SOS inserts
-- to burn D7 SMS credit, or use it as an unsolicited-SMS gateway (arbitrary trusted-
-- contact phone + attacker-controlled reporter name echoed into the body). Add a DB
-- throttle: at most 1 SOS fan-out per user per 60s (the incident still records; only
-- the broadcast is suppressed). Body otherwise verbatim.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_sos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_contact RECORD;
  v_reporter_name TEXT;
  v_share_url TEXT;
  v_sms_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_share_token TEXT;
  v_allowed BOOLEAN;
BEGIN
  IF NEW.type <> 'sos' THEN
    RETURN NEW;
  END IF;

  -- SOS-01/02: throttle the fan-out (D7 SMS-cost / unsolicited-SMS-gateway abuse).
  SELECT allowed INTO v_allowed FROM check_rate_limit('sos:' || NEW.reported_by::text, 1, 60);
  IF NOT COALESCE(v_allowed, true) THEN
    RAISE WARNING '[notify_trusted_contacts_on_sos] throttled SOS fan-out for user % (incident %)', NEW.reported_by, NEW.id;
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_reporter_name FROM users WHERE id = NEW.reported_by;

  IF NEW.ride_id IS NOT NULL THEN
    SELECT share_token INTO v_share_token FROM rides WHERE id = NEW.ride_id;
  END IF;

  IF v_share_token IS NOT NULL THEN
    v_share_url := 'https://tricigo.com/track/share/' || v_share_token;
  ELSE
    v_share_url := '';
  END IF;

  FOR v_contact IN
    SELECT DISTINCT tc.name AS contact_name, tc.phone AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.reported_by
      AND (tc.auto_share = true OR tc.is_emergency = true)
  LOOP
    v_sms_body := '🚨 ALERTA SOS · TriciGo: ' ||
                  COALESCE(v_reporter_name, 'Un contacto tuyo') ||
                  ' activó el botón de emergencia.' ||
                  CASE WHEN v_share_url <> '' THEN ' Seguilo en: ' || v_share_url ELSE '' END ||
                  ' Llamá al 106 si es urgente.';

    v_payload := jsonb_build_object(
      'phone', v_contact.contact_phone,
      'body', v_sms_body,
      'ride_id', NEW.ride_id,
      'incident_id', NEW.id::text,
      'event_type', 'sos_alert'
    );

    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', v_service_key,
        'Authorization', 'Bearer ' || v_service_key
      ),
      body := v_payload
    );
  END LOOP;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_trusted_contacts_on_sos] SOS dispatch FAILED for incident % (user %): % %',
    NEW.id, NEW.reported_by, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;
