-- The trigger functions 00672 patches and the ones they meet, as pg_get_functiondef printed them
-- from prod on 2026-11-02 (md5 of prosrc in run.sh, OLD_BODIES).

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- 00491 (approval gate): an active vehicle is REQUIRED before a driver can be
  -- marked 'approved'. Placed ABOVE the is_admin()/service-role bypasses on
  -- purpose — the admin approveDriver UPDATE and the auto-admin EF must both be
  -- gated. Fires only on the transition TO approved (re-saving an already
  -- approved profile is unaffected).
  IF NEW.status::text = 'approved'
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved'
     AND NOT EXISTS (
       SELECT 1 FROM vehicles v WHERE v.driver_id = NEW.id AND v.is_active = true
     ) THEN
    RAISE EXCEPTION 'driver_has_no_active_vehicle: cannot approve driver % without a registered active vehicle', NEW.id;
  END IF;

  -- 00491 (online gate): going online also requires an active vehicle. Approval
  -- already requires one, but a vehicle could be deactivated afterwards — this
  -- keeps a vehicle-less driver from ever appearing online (and as a car).
  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND NOT EXISTS (
       SELECT 1 FROM vehicles v WHERE v.driver_id = NEW.id AND v.is_active = true
     ) THEN
    RAISE EXCEPTION 'driver_has_no_active_vehicle_for_online: register an active vehicle before going online (driver %)', NEW.id;
  END IF;

  -- 00650: a vehicle change by an approved driver sends the profile back to
  -- review. tg_vehicles_client_guard sets this setting to the profile id around
  -- its own UPDATE (status -> under_review, is_online -> false); clients cannot
  -- set app.* settings.
  IF coalesce(current_setting('app.vehicle_rereview', true), '') = NEW.id::text THEN
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved' THEN
    RAISE EXCEPTION 'driver_not_approved_for_online: status=% — cannot go online until approved by admin',
      OLD.status;
  END IF;



  IF current_setting('app.trusted_driver_update', true) = '1' THEN
    NEW.status                  := OLD.status;
    NEW.approved_at             := OLD.approved_at;
    NEW.suspended_at            := OLD.suspended_at;
    NEW.suspended_reason        := OLD.suspended_reason;
    NEW.identity_number         := OLD.identity_number;
    NEW.has_criminal_record     := OLD.has_criminal_record;
    NEW.criminal_record_details := OLD.criminal_record_details;
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

  -- Owner during onboarding: allow them to fill their identity fields and
  -- submit for review. Only while NOT yet approved. Everything else stays
  -- protected, and once approved identity_number/status fall back to admin-only.
  IF auth.uid() = NEW.user_id
     AND OLD.status::text IN ('pending_verification', 'rejected', 'under_review') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status::text IN ('pending_verification', 'rejected')
                AND NEW.status::text = 'under_review') THEN
      NEW.status := OLD.status;
    END IF;
    -- 00650: a driver approved before (back in review after a vehicle change)
    -- keeps the identity the admin already checked.
    IF OLD.approved_at IS NOT NULL THEN
      NEW.identity_number         := OLD.identity_number;
      NEW.has_criminal_record     := OLD.has_criminal_record;
      NEW.criminal_record_details := OLD.criminal_record_details;
    END IF;
    NEW.is_financially_eligible := OLD.is_financially_eligible;
    NEW.negative_balance_since  := OLD.negative_balance_since;
    NEW.match_score             := OLD.match_score;
    NEW.acceptance_rate         := OLD.acceptance_rate;
    NEW.total_rides             := OLD.total_rides;
    NEW.total_rides_completed   := OLD.total_rides_completed;
    NEW.total_rides_offered     := OLD.total_rides_offered;
    NEW.rating_avg              := OLD.rating_avg;
    NEW.approved_at             := OLD.approved_at;
    NEW.suspended_at            := OLD.suspended_at;
    NEW.suspended_reason        := OLD.suspended_reason;
    NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
    NEW.quota_blocked           := OLD.quota_blocked;
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

  NEW.status                  := OLD.status;
  NEW.is_financially_eligible := OLD.is_financially_eligible;
  NEW.negative_balance_since  := OLD.negative_balance_since;
  NEW.match_score             := OLD.match_score;
  NEW.acceptance_rate         := OLD.acceptance_rate;
  NEW.total_rides             := OLD.total_rides;
  NEW.total_rides_completed   := OLD.total_rides_completed;
  NEW.total_rides_offered     := OLD.total_rides_offered;
  NEW.rating_avg              := OLD.rating_avg;
  NEW.approved_at             := OLD.approved_at;
  NEW.suspended_at            := OLD.suspended_at;
  NEW.suspended_reason        := OLD.suspended_reason;
  NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
  NEW.quota_blocked           := OLD.quota_blocked;
  NEW.identity_number         := OLD.identity_number;
  NEW.has_criminal_record     := OLD.has_criminal_record;
  NEW.criminal_record_details := OLD.criminal_record_details;
  NEW.user_id                 := OLD.user_id;
  NEW.id                      := OLD.id;
  NEW.created_at              := OLD.created_at;
  NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_verified text;
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- 00599: gifts, diaspora recharges, ride calls and SMS go to users.phone, so
  -- a caller with a JWT that is not an admin may only write the number its
  -- account confirmed by OTP (auth.users.phone with phone_confirmed_at),
  -- stored as E.164. Anything else is put back and logged without the number.
  -- Checked before the trusted branches below, so they cannot open it.
  IF NEW.phone IS DISTINCT FROM OLD.phone AND auth.uid() IS NOT NULL THEN
    IF NOT is_admin() THEN
      SELECT regexp_replace(public._normalize_cuban_phone(au.phone), '\D', '', 'g')
        INTO v_verified
      FROM auth.users au
      WHERE au.id = OLD.id
        AND au.phone_confirmed_at IS NOT NULL;

      IF v_verified <> ''
         AND v_verified = regexp_replace(public._normalize_cuban_phone(NEW.phone), '\D', '', 'g') THEN
        NEW.phone := '+' || v_verified;
      ELSE
        PERFORM log_rpc_attempt('users_phone_guard', auth.uid(), OLD.id, 'reverted',
          jsonb_build_object('reason', CASE
            WHEN btrim(coalesce(NEW.phone, '')) = '' THEN 'cleared'
            WHEN coalesce(v_verified, '') = '' THEN 'no_verified_phone'
            ELSE 'not_the_verified_phone'
          END));
        NEW.phone := OLD.phone;
      END IF;
    END IF;
  END IF;

  -- 00661: team invitations. _team_write_role sets the team role flag around its
  -- single UPDATE (accept_team_invitation, set_team_member_role, remove_team_member).
  -- Only the role passes; what the other branches protect stays as it was.
  IF coalesce(current_setting('app.team_role_change', true), '') = '1' THEN
    NEW.is_active            := OLD.is_active;
    NEW.level                := OLD.level;
    NEW.total_rides          := OLD.total_rides;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_tier_update', true) = '1' THEN
    NEW.role                 := OLD.role;
    NEW.is_active            := OLD.is_active;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_cancel_update', true) = '1' THEN
    NEW.role        := OLD.role;
    NEW.is_active   := OLD.is_active;
    NEW.level       := OLD.level;
    NEW.total_rides := OLD.total_rides;
    NEW.total_spent := OLD.total_spent;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    IF NOT (OLD.role = 'customer' AND NEW.role = 'driver'
            AND EXISTS (SELECT 1 FROM driver_profiles dp
                        WHERE dp.user_id = NEW.id AND dp.status = 'approved')) THEN
      NEW.role := OLD.role;
    END IF;
    NEW.level := OLD.level;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_driver_documents_protect_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      -- 00650: the app uploads to driver-docs/<driver_id>/...; a row pointing
      -- anywhere else (another driver's license) would be reviewed as this
      -- driver's document.
      IF NEW.storage_path IS NULL
         OR left(NEW.storage_path, length('driver-docs/' || NEW.driver_id::text || '/'))
            <> 'driver-docs/' || NEW.driver_id::text || '/'
         OR position('..' IN NEW.storage_path) > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'No se pudo guardar el documento. Vuelve a subirlo desde la app.',
          DETAIL = 'document_path_not_own';
      END IF;
      NEW.is_verified := false;
      NEW.verified_by := NULL;
      NEW.verified_at := NULL;
      NEW.rejection_reason := NULL;
      NEW.verification_notes := NULL;
      NEW.face_match_score := NULL;
      NEW.liveness_passed := NULL;
    ELSE
      NEW.is_verified := OLD.is_verified;
      NEW.verified_by := OLD.verified_by;
      NEW.verified_at := OLD.verified_at;
      NEW.rejection_reason := OLD.rejection_reason;
      NEW.verification_notes := OLD.verification_notes;
      NEW.face_match_score := OLD.face_match_score;
      NEW.liveness_passed := OLD.liveness_passed;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_corporate_update', true) = '1' THEN
    NEW.status              := OLD.status;
    NEW.commission_percent  := OLD.commission_percent;
    NEW.monthly_budget_trc  := OLD.monthly_budget_trc;
    NEW.per_ride_cap_trc    := OLD.per_ride_cap_trc;
    NEW.is_fleet_owner      := OLD.is_fleet_owner;
    NEW.approved_at         := OLD.approved_at;
    NEW.suspended_at        := OLD.suspended_at;
    NEW.suspended_reason    := OLD.suspended_reason;
    NEW.created_by          := OLD.created_by;
    NEW.id                  := OLD.id;
    NEW.created_at          := OLD.created_at;
    RETURN NEW;
  END IF;

  -- 00625: monthly_budget_trc and per_ride_cap_trc are the company's to set
  -- (RLS lets only its active admins update the row).
  NEW.status              := OLD.status;
  NEW.commission_percent  := OLD.commission_percent;
  NEW.current_month_spent := OLD.current_month_spent;
  NEW.is_fleet_owner      := OLD.is_fleet_owner;
  NEW.approved_at         := OLD.approved_at;
  NEW.suspended_at        := OLD.suspended_at;
  NEW.suspended_reason    := OLD.suspended_reason;
  NEW.created_by          := OLD.created_by;
  NEW.id                  := OLD.id;
  NEW.created_at          := OLD.created_at;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status          := 'pending_review';
    NEW.driver_id       := NULL;
    NEW.signed_up_at    := NULL;
    NEW.reviewed_at     := NULL;
    NEW.reviewed_by     := NULL;
    NEW.rejected_reason := NULL;
    RETURN NEW;
  ELSE
    NEW.status       := OLD.status;
    NEW.driver_id    := OLD.driver_id;
    NEW.signed_up_at := OLD.signed_up_at;
    NEW.reviewed_at  := OLD.reviewed_at;
    NEW.reviewed_by  := OLD.reviewed_by;
    -- 00600: the rejection reason is the admin's text. Once the admin has
    -- reviewed the invitation, what they reviewed and the fleet it is for
    -- stay as reviewed; to change them, the owner deletes it and invites again.
    NEW.rejected_reason := OLD.rejected_reason;
    IF OLD.status IS DISTINCT FROM 'pending_review' THEN
      NEW.fleet_id              := OLD.fleet_id;
      NEW.driver_name           := OLD.driver_name;
      NEW.driver_phone          := OLD.driver_phone;
      NEW.driver_email          := OLD.driver_email;
      NEW.driver_license_number := OLD.driver_license_number;
      NEW.driver_id_number      := OLD.driver_id_number;
      NEW.license_doc_path      := OLD.license_doc_path;
    END IF;
    RETURN NEW;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_driver_documents_validate_mime()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_allowed_mimes CONSTANT TEXT[] := ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/pdf'
  ];
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.mime_type IS NULL OR length(trim(NEW.mime_type)) = 0 THEN
    RAISE EXCEPTION 'driver_documents.mime_type is required';
  END IF;

  IF NOT (LOWER(NEW.mime_type) = ANY(v_allowed_mimes)) THEN
    RAISE EXCEPTION 'driver_documents.mime_type "%" is not in the allowed whitelist (%)',
      NEW.mime_type, array_to_string(v_allowed_mimes, ', ');
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ensure_driver_role_and_tricicoin_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    -- Promote ONLY plain customers; leave admin/super_admin alone.
    -- Their elevated role takes precedence over the driver flag —
    -- the effective_role logic in 00143 already treats them as
    -- driver for ride transitions when they own the driver_profile.
    UPDATE users
       SET role = 'driver'
     WHERE id = NEW.user_id
       AND role NOT IN ('driver', 'admin', 'super_admin', 'marketing', 'operator');

    -- Wallet provisioning is safe for any role (admins testing
    -- as drivers still need a tricicoin wallet to accept rides).
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (NEW.user_id, 'tricicoin'::wallet_account_type, 0)
    ON CONFLICT (user_id, account_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_driver_outreach_log_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.admin_id := auth.uid();
    NEW.created_at := now();
  END IF;
  NEW.note := nullif(btrim(NEW.note), '');
  RETURN NEW;
END;
$function$
;
