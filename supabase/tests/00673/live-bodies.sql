-- The functions 00673 patches and the ones they meet, as pg_get_functiondef printed them from prod on
-- 2026-11-02 (md5 of prosrc in run.sh, OLD_BODIES), with prod's EXECUTE grants at the end.

CREATE OR REPLACE FUNCTION public._normalize_cuban_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_digits text;
BEGIN
  IF p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  v_digits := regexp_replace(p_phone, '\D', '', 'g');
  -- Bare local mobile: 8 digits starting with 5 (legacy) or 6 (new 63/64)
  IF v_digits ~ '^[56]\d{7}$' THEN
    RETURN '+53' || v_digits;
  -- With country code, no +: 53 followed by the 8-digit subscriber number
  ELSIF v_digits ~ '^53\d{8}$' THEN
    RETURN '+' || v_digits;
  END IF;
  RETURN p_phone;
END;
$function$;

CREATE OR REPLACE FUNCTION public._ops_target_refusal(p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF p_user_id IS NOT NULL AND p_user_id = auth.uid() THEN
    RETURN 'self_action';
  END IF;
  IF NOT public.is_admin()
     AND COALESCE((SELECT u.role::text FROM public.users u WHERE u.id = p_user_id), 'customer')
         NOT IN ('customer', 'driver') THEN
    RETURN 'target_is_staff';
  END IF;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public._ops_user_push(p_rpc text, p_target uuid, p_user_id uuid, p_title text, p_body text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.notification_preferences np
             WHERE np.user_id = p_user_id AND np.driver_approval IS FALSE) THEN
    RETURN;
  END IF;
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_target, 'push_failed',
        jsonb_build_object('user_id', p_user_id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('ops-driver-review',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object('user_ids', jsonb_build_array(p_user_id::text), 'title', p_title,
                                      'body', p_body, 'data', COALESCE(p_data, '{}'::jsonb)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_target, 'push_failed',
      jsonb_build_object('user_id', p_user_id, 'error', SQLERRM));
  END;
END
$function$;

CREATE OR REPLACE FUNCTION public._ride_context_for_caller(p_ride_id uuid)
 RETURNS TABLE(caller_role text, ride_status ride_status, other_user_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE WHEN r.customer_id = auth.uid() THEN 'customer' ELSE 'driver' END,
         r.status,
         CASE WHEN r.customer_id = auth.uid() THEN dp.user_id ELSE r.customer_id END
  FROM public.rides r
  LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id
    AND auth.uid() IS NOT NULL
    AND (r.customer_id = auth.uid() OR dp.user_id = auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ride_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Marketing rides as a passenger: its rights over a ride are a customer's
  -- (or a driver's, below, when it owns the approved driver profile).
  -- 00671: inside an ops function acting on this ride (_ops_allow), the operator moves it as
  -- an admin.
  IF v_user_role = 'operator' AND public._ops_acting_on(NEW.id) THEN
    v_user_role := 'admin';
  ELSIF v_user_role IN ('marketing', 'operator') THEN
    v_user_role := 'customer';
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin')
     AND NEW.driver_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = NEW.driver_id
         AND dp.user_id = auth.uid()
         AND dp.status = 'approved'
     ) THEN
    v_user_role := 'driver';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid uuid;
  v_is_admin   boolean;
  v_is_customer boolean;
  v_is_driver  boolean;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RETURN NEW;
  END IF;
  -- 00671: ops staff inside an ops function acting on this ride.
  SELECT is_admin() OR public._ops_acting_on(NEW.id) INTO v_is_admin;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;
  v_is_customer := (OLD.customer_id = v_caller_uid);
  v_is_driver := (OLD.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = OLD.driver_id AND user_id = v_caller_uid
  ));
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'cannot modify customer_id';
  END IF;

  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    IF OLD.driver_id IS NULL
       AND NEW.driver_id IS NOT NULL
       AND OLD.status = 'searching'
       AND NEW.status = 'accepted' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
    END IF;
  END IF;

  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    IF OLD.final_fare_cup IS NULL
       AND NEW.final_fare_cup IS NOT NULL
       AND OLD.status IN ('in_progress','arrived_at_destination')
       AND NEW.status = 'completed' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
    END IF;
  END IF;

  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method
     AND NOT (OLD.status = 'completed' AND OLD.payment_method = 'tricicoin'
              AND NEW.payment_method = 'mixed'
              AND COALESCE(current_setting('app.ride_payment_to_mixed', true), '') = '1') THEN
    RAISE EXCEPTION 'cannot modify payment_method on active ride';
  END IF;
  IF NEW.cancellation_fee_cup IS DISTINCT FROM OLD.cancellation_fee_cup
     OR NEW.cancellation_fee_trc IS DISTINCT FROM OLD.cancellation_fee_trc THEN
    RAISE EXCEPTION 'cannot modify cancellation_fee (use cancel_ride RPC)';
  END IF;
  IF v_is_driver AND NOT v_is_customer THEN
    IF NEW.estimated_fare_cup IS DISTINCT FROM OLD.estimated_fare_cup
       OR NEW.estimated_fare_trc IS DISTINCT FROM OLD.estimated_fare_trc
       OR NEW.estimated_distance_m IS DISTINCT FROM OLD.estimated_distance_m
       OR NEW.estimated_duration_s IS DISTINCT FROM OLD.estimated_duration_s THEN
      RAISE EXCEPTION 'driver cannot modify ride estimates';
    END IF;
    IF NEW.pickup_location::text IS DISTINCT FROM OLD.pickup_location::text
       OR NEW.dropoff_location::text IS DISTINCT FROM OLD.dropoff_location::text
       OR NEW.pickup_address IS DISTINCT FROM OLD.pickup_address
       OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address
       OR NEW.pickup_notes IS DISTINCT FROM OLD.pickup_notes
       OR NEW.dropoff_notes IS DISTINCT FROM OLD.dropoff_notes THEN
      RAISE EXCEPTION 'driver cannot modify pickup/dropoff';
    END IF;
  END IF;
  IF v_is_customer AND NOT v_is_driver THEN
    IF NEW.driver_arrived_at IS DISTINCT FROM OLD.driver_arrived_at
       OR NEW.pickup_at IS DISTINCT FROM OLD.pickup_at
       OR NEW.arrived_at_destination_at IS DISTINCT FROM OLD.arrived_at_destination_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
      RAISE EXCEPTION 'customer cannot modify driver timestamps';
    END IF;
    IF NEW.actual_distance_m IS DISTINCT FROM OLD.actual_distance_m
       OR NEW.actual_duration_s IS DISTINCT FROM OLD.actual_duration_s THEN
      RAISE EXCEPTION 'customer cannot modify actuals';
    END IF;
    -- CLI-001: pricing fields used as source of truth by complete_ride_and_pay
    IF NEW.surge_multiplier IS DISTINCT FROM OLD.surge_multiplier
       OR NEW.driver_custom_rate_cup IS DISTINCT FROM OLD.driver_custom_rate_cup
       OR NEW.wallet_ratio IS DISTINCT FROM OLD.wallet_ratio
       OR NEW.insurance_premium_cup IS DISTINCT FROM OLD.insurance_premium_cup
       OR NEW.wait_time_charge_cup IS DISTINCT FROM OLD.wait_time_charge_cup THEN
      RAISE EXCEPTION 'customer cannot modify pricing fields (surge_multiplier, driver_custom_rate_cup, wallet_ratio, insurance_premium_cup, wait_time_charge_cup)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_rides_client_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- The only columns the apps write on a ride directly: the share link, chained
  -- rides and the fare split. Everything else belongs to the ride RPCs.
  c_client_columns CONSTANT text[] := ARRAY[
    'share_token', 'share_token_expires_at', 'next_ride_id', 'is_chained',
    'is_split', 'status', 'updated_at'];
BEGIN
  -- Inside a SECURITY DEFINER RPC current_user is the function's owner, and the
  -- service role, cron and SQL sessions are other roles: only a raw PostgREST
  -- write from an app arrives here as anon or authenticated.
  IF current_user NOT IN ('anon', 'authenticated') OR is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'completed' AND NEW.status = 'disputed'
              AND EXISTS (SELECT 1 FROM ride_disputes d
                          WHERE d.ride_id = NEW.id
                            AND d.opened_by = auth.uid()
                            AND d.status IN ('open', 'under_review', 'escalated'))) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'El estado del viaje solo cambia desde la app: aceptar, llegar, iniciar, terminar o cancelar.',
      DETAIL  = 'ride_status_via_rpc';
  END IF;

  IF (to_jsonb(NEW) - c_client_columns) IS DISTINCT FROM (to_jsonb(OLD) - c_client_columns) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Ese dato del viaje no se puede cambiar desde la app.',
      DETAIL  = 'ride_column_via_rpc';
  END IF;

  RETURN NEW;
END;
$function$;

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

  -- 00672: ops staff inside an ops function acting on this profile (ops_set_driver_status).
  IF is_admin() OR public._ops_acting_on(NEW.id) THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_inactive_stays_offline()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.is_online AND NOT OLD.is_online
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND NOT u.is_active) THEN
    NEW.is_online := false;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_shift_intent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- auth.uid() presente = lo hizo una persona (el conductor o un admin), no el
  -- cron (service_role, auth.uid() NULL). Su intención manda: se borra la marca.
  IF NEW.is_online IS DISTINCT FROM OLD.is_online AND auth.uid() IS NOT NULL THEN
    NEW.auto_offline_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

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

  -- 00672: ops_set_driver_status approving this user's driver profile. Only the customer ->
  -- driver step of ensure_driver_role_and_tricicoin_on_approval passes, as for an admin.
  IF public._ops_acting_on(NEW.id) THEN
    IF NOT (OLD.role = 'customer' AND NEW.role = 'driver'
            AND EXISTS (SELECT 1 FROM driver_profiles dp
                        WHERE dp.user_id = NEW.id AND dp.status = 'approved')) THEN
      NEW.role := OLD.role;
    END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.tg_ride_disputes_protect_columns()
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
    RETURN NEW;  -- service-role / SECDEF (e.g. process_dispute_refund)
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'under_review' THEN
    NEW.status := OLD.status;
  END IF;
  NEW.id                      := OLD.id;
  NEW.ride_id                 := OLD.ride_id;
  NEW.opened_by               := OLD.opened_by;
  NEW.reason                  := OLD.reason;
  NEW.description             := OLD.description;
  NEW.evidence_urls           := OLD.evidence_urls;
  NEW.priority                := OLD.priority;
  NEW.respondent_id           := OLD.respondent_id;
  NEW.resolution              := OLD.resolution;
  NEW.resolution_notes        := OLD.resolution_notes;
  NEW.refund_amount_trc       := OLD.refund_amount_trc;
  NEW.refund_transaction_id   := OLD.refund_transaction_id;
  NEW.assigned_to             := OLD.assigned_to;
  NEW.admin_notes             := OLD.admin_notes;
  NEW.sla_first_response_at   := OLD.sla_first_response_at;
  NEW.sla_resolution_deadline := OLD.sla_resolution_deadline;
  NEW.support_ticket_id       := OLD.support_ticket_id;
  NEW.incident_report_id      := OLD.incident_report_id;
  NEW.created_at              := OLD.created_at;
  NEW.resolved_at             := OLD.resolved_at;
  NEW.ride_estimated_fare_trc := OLD.ride_estimated_fare_trc;
  NEW.ride_final_fare_trc     := OLD.ride_final_fare_trc;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_support_tickets_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.ride_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public._ride_context_for_caller(NEW.ride_id)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ese viaje no es tuyo.',
      DETAIL = 'ticket_ride_not_yours';
  END IF;

  NEW.status := 'open';
  NEW.priority := 'normal';
  NEW.assigned_to := NULL;
  NEW.resolved_at := NULL;
  NEW.created_at := now();
  NEW.updated_at := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_support_tickets_client_update_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_free constant text[] := ARRAY['status', 'resolved_at', 'updated_at'];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - c_free) IS DISTINCT FROM (to_jsonb(OLD) - c_free) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Solo puedes cambiar el estado del ticket.',
      DETAIL = 'ticket_column_staff_only';
  END IF;
  IF NEW.status IS NULL OR NEW.status NOT IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ese estado de ticket no existe.',
      DETAIL = 'ticket_status_invalid';
  END IF;
  NEW.updated_at := now();
  IF NEW.status IN ('resolved', 'closed') THEN
    -- From resolved to closed the date stays; a ticket that was resolved without one gets it now.
    NEW.resolved_at := CASE WHEN OLD.status IN ('resolved', 'closed') THEN coalesce(OLD.resolved_at, now()) ELSE now() END;
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.tg_ticket_messages_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  -- Marketing answers tickets as support (00663), except in a ticket of its own.
  IF public.is_marketing() AND NOT EXISTS (
    SELECT 1 FROM public.support_tickets t WHERE t.id = NEW.ticket_id AND t.user_id = auth.uid()
  ) THEN
    NEW.is_admin := true;
  ELSE
    NEW.is_admin := false;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_lost_items_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ctx record;
  v_count int;
  v_changed text[];
  v_allowed text[];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_ctx FROM public._ride_context_for_caller(NEW.ride_id);
    IF NOT FOUND OR v_ctx.caller_role <> 'customer' OR v_ctx.other_user_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Solo puedes reportar objetos perdidos en tus viajes con conductor.',
        DETAIL = 'lost_item_not_your_ride';
    END IF;

    SELECT count(*) INTO v_count FROM public.lost_items
     WHERE ride_id = NEW.ride_id AND reporter_id = v_uid;
    IF v_count >= 5 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Ya reportaste varios objetos en este viaje. Escríbele a soporte.',
        DETAIL = 'lost_item_limit';
    END IF;

    NEW.reporter_id := v_uid;
    NEW.driver_id := v_ctx.other_user_id;
    NEW.status := 'reported';
    NEW.driver_found := NULL;
    NEW.driver_response := NULL;
    NEW.return_fee_cup := NULL;
    NEW.return_location := NULL;
    NEW.return_notes := NULL;
    NEW.admin_notes := NULL;
    NEW.resolved_by := NULL;
    NEW.resolved_at := NULL;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: which columns changed (updated_at belongs to its own trigger).
  SELECT coalesce(array_agg(n.key), '{}') INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n
   WHERE n.key <> 'updated_at' AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);

  IF v_uid IS NOT DISTINCT FROM OLD.driver_id THEN
    v_allowed := ARRAY['driver_found', 'driver_response', 'status', 'return_fee_cup',
                       'return_location', 'return_notes', 'resolved_by', 'resolved_at'];
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (NEW.status IN ('found', 'not_found') AND OLD.status IN ('reported', 'found', 'not_found'))
      OR (NEW.status = 'return_arranged' AND OLD.status IN ('found', 'return_arranged'))
      OR (NEW.status = 'returned' AND OLD.status IN ('found', 'return_arranged'))) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Ese cambio de estado no es posible para este reporte.',
        DETAIL = 'lost_item_status';
    END IF;
    IF NEW.return_fee_cup IS NOT NULL AND NEW.return_fee_cup < 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'El costo de devolución no puede ser negativo.',
        DETAIL = 'lost_item_fee';
    END IF;
    IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
      NEW.resolved_by := v_uid;
      NEW.resolved_at := now();
    ELSE
      NEW.resolved_by := OLD.resolved_by;
      NEW.resolved_at := OLD.resolved_at;
    END IF;
  ELSIF v_uid IS NOT DISTINCT FROM OLD.reporter_id THEN
    v_allowed := ARRAY['description', 'category', 'photo_urls'];
    IF cardinality(v_changed) > 0 AND OLD.status <> 'reported' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'El conductor ya respondió: este reporte no se puede editar.',
        DETAIL = 'lost_item_locked';
    END IF;
  ELSE
    v_allowed := '{}';
  END IF;

  -- The driver's resolved_by/resolved_at were set above, whatever was sent.
  IF EXISTS (SELECT 1 FROM unnest(v_changed) c WHERE c <> ALL (v_allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No puedes cambiar ese dato del reporte.',
      DETAIL = 'lost_item_column';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_incident_reports_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_other uuid;
  v_sos boolean := NEW.type::text = 'sos';
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.ride_id IS NOT NULL THEN
    SELECT c.other_user_id INTO v_other FROM public._ride_context_for_caller(NEW.ride_id) c;
    IF NOT FOUND THEN
      IF NOT v_sos THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'Solo puedes reportar viajes en los que participaste.',
          DETAIL = 'incident_not_your_ride';
      END IF;
      -- An SOS always goes through, without someone else's ride: its share
      -- link would be texted to the reporter's own contacts.
      NEW.ride_id := NULL;
    END IF;
  END IF;

  IF NEW.against_user_id IS NOT NULL
     AND (NEW.ride_id IS NULL OR NEW.against_user_id IS DISTINCT FROM v_other) THEN
    IF NOT v_sos THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Solo puedes reportar a la otra persona del viaje.',
        DETAIL = 'incident_wrong_party';
    END IF;
    NEW.against_user_id := NULL;
  END IF;

  NEW.status := 'open';
  NEW.severity := CASE WHEN v_sos THEN 'critical' ELSE 'medium' END;
  NEW.resolved_by := NULL;
  NEW.resolved_at := NULL;
  NEW.resolution_notes := NULL;
  NEW.review_id := NULL;
  NEW.created_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_reviews_client_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.comment := NULLIF(btrim(NEW.comment), '');
  IF char_length(NEW.comment) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'El comentario puede tener hasta 1000 caracteres.',
      DETAIL = 'review_comment_length';
  END IF;

  -- Featuring and hiding a review are moderation; the date is the server's.
  NEW.is_featured := false;
  NEW.is_visible := true;
  NEW.created_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_rating_avg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM apply_user_rating(NEW.reviewee_id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_user_active(p_user_id uuid, p_active boolean, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     public.user_role;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_sessions integer := 0;
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un administrador puede bloquear o desbloquear cuentas.', DETAIL = 'not_admin';
  END IF;
  IF p_user_id IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Faltan datos para cambiar el estado de la cuenta.', DETAIL = 'missing_argument';
  END IF;
  IF p_user_id = v_caller THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'No puedes bloquear tu propia cuenta.', DETAIL = 'self';
  END IF;
  -- ...0001 owns the platform wallets and ...0099 the anonymized rows; 00604
  -- banned both until 2999. Unblocking either would lift that ban.
  IF p_user_id IN ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000099'::uuid) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Las cuentas del sistema no se pueden bloquear ni desbloquear.', DETAIL = 'system_account';
  END IF;

  SELECT u.role INTO v_role FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'La cuenta no existe.', DETAIL = 'not_found';
  END IF;
  IF v_role IN ('admin', 'super_admin') AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un super admin puede bloquear o desbloquear a otro administrador.', DETAIL = 'target_is_staff';
  END IF;
  IF NOT p_active AND v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Escribe el motivo del bloqueo.', DETAIL = 'reason_required';
  END IF;

  IF p_active THEN
    UPDATE public.users SET is_active = true WHERE id = p_user_id;
    UPDATE auth.users SET banned_until = NULL WHERE id = p_user_id;
  ELSE
    UPDATE public.users SET is_active = false WHERE id = p_user_id;
    -- GoTrue refuses the login and the token refresh of a banned user. 100
    -- years is what GoTrue itself stores for its longest ban ('876000h').
    UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = p_user_id;
    WITH s AS (DELETE FROM auth.sessions WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_sessions FROM s;
    -- Refresh tokens with a session went with it (ON DELETE CASCADE); these
    -- are the ones without one.
    DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
    UPDATE public.driver_profiles SET is_online = false, auto_offline_at = NULL
    WHERE user_id = p_user_id AND (is_online OR auto_offline_at IS NOT NULL);
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (v_caller, CASE WHEN p_active THEN 'unblock_user' ELSE 'block_user' END,
          'user', p_user_id::text, v_reason);

  RETURN jsonb_build_object('user_id', p_user_id, 'is_active', p_active, 'sessions_closed', v_sessions);
END;
$function$;

CREATE OR REPLACE FUNCTION public.detect_collusion_reviews()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_days  integer := COALESCE(get_platform_config_numeric('collusion_pair_window_days', 180), 180)::integer;
  v_min_cancels  integer := COALESCE(get_platform_config_numeric('collusion_pair_min_cancels', 2), 2)::integer;
  v_min_score    numeric := COALESCE(get_platform_config_numeric('collusion_review_min_score', 40), 40);
  v_cooldown     integer := COALESCE(get_platform_config_numeric('collusion_dismiss_cooldown_days', 30), 30)::integer;
  v_exempt       text[] := ARRAY['no_show','passenger_gone','breakdown','safety','emergency'];
  v_count        integer := 0;
  v_score        numeric;
  rec            record;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  FOR rec IN
    SELECT p.customer_id, p.driver_id,
           count(*)                                                          AS pair_cancel_count,
           count(*) FILTER (WHERE p.rc IS NULL OR NOT (p.rc = ANY(v_exempt))) AS nonexempt_count,
           count(*) FILTER (WHERE p.rc = ANY(v_exempt))                       AS exempt_count,
           array_agg(p.ride_id)                                              AS ride_ids
    FROM (
      SELECT r.customer_id, r.driver_id, r.id AS ride_id, r.cancellation_reason_code AS rc
      FROM rides r
      JOIN driver_profiles dp ON dp.id = r.driver_id
      JOIN users du ON du.id = dp.user_id
      JOIN users cu ON cu.id = r.customer_id
      WHERE r.status = 'canceled'
        AND r.driver_id IS NOT NULL AND r.customer_id IS NOT NULL
        AND r.driver_arrived_at IS NOT NULL
        AND r.canceled_at > now() - (v_window_days || ' days')::interval
        AND du.is_test = false AND cu.is_test = false
    ) p
    GROUP BY p.customer_id, p.driver_id
    HAVING count(*) >= v_min_cancels
  LOOP
    IF EXISTS (
      SELECT 1 FROM cancellation_reviews cr
      WHERE cr.driver_id = rec.driver_id AND cr.customer_id = rec.customer_id
        AND cr.status = 'dismissed'
        AND cr.reviewed_at > now() - (v_cooldown || ' days')::interval
    ) THEN
      CONTINUE;
    END IF;

    v_score := LEAST(100, 40 + 20 * (rec.nonexempt_count - 1) + 5 * rec.exempt_count);
    IF v_score < v_min_score THEN CONTINUE; END IF;

    INSERT INTO cancellation_reviews (driver_id, customer_id, signal_type, risk_score, signals, ride_ids, status)
    VALUES (
      rec.driver_id, rec.customer_id, 'repeated_pair', v_score,
      jsonb_build_object(
        'pair_cancel_count', rec.pair_cancel_count,
        'nonexempt_count', rec.nonexempt_count,
        'exempt_count', rec.exempt_count,
        'window_days', v_window_days
      ),
      rec.ride_ids, 'pending'
    )
    ON CONFLICT (driver_id, customer_id) WHERE status = 'pending'
    DO UPDATE SET
      risk_score  = EXCLUDED.risk_score,
      signals     = EXCLUDED.signals,
      signal_type = EXCLUDED.signal_type,
      ride_ids    = (SELECT array_agg(DISTINCT e) FROM unnest(cancellation_reviews.ride_ids || EXCLUDED.ride_ids) e),
      updated_at  = now();
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_collusion_sanction(p_review_id uuid, p_level text, p_notes text, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_review       cancellation_reviews%ROWTYPE;
  v_driver_user  uuid;
  v_rating_value numeric := COALESCE(get_platform_config_numeric('collusion_rating_value', 1.0), 1.0);
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF NOT is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_level NOT IN ('dismiss', 'warning', 'reputation') THEN
    RETURN jsonb_build_object('error', 'invalid_level');
  END IF;

  SELECT * INTO v_review FROM cancellation_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'review_not_found'); END IF;
  IF v_review.status IN ('sanctioned', 'dismissed') THEN
    RETURN jsonb_build_object('error', 'already_resolved', 'status', v_review.status);
  END IF;

  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;

  IF p_level = 'dismiss' THEN
    UPDATE cancellation_reviews SET
      status = 'dismissed', verdict = 'just', sanction_type = NULL,
      admin_notes = p_notes, reviewed_by = p_admin_id, reviewed_at = now(), updated_at = now()
    WHERE id = p_review_id;
  ELSE
    IF p_level = 'reputation' AND v_driver_user IS NOT NULL THEN
      INSERT INTO cancellation_rating_events (user_id, ride_id, rating_value, role_at_event, reason)
      VALUES (v_driver_user, NULL, v_rating_value, 'driver', 'collusion:' || p_review_id::text);
    END IF;
    UPDATE cancellation_reviews SET
      status = 'sanctioned', verdict = 'unjust', sanction_type = p_level,
      admin_notes = p_notes, reviewed_by = p_admin_id, reviewed_at = now(), updated_at = now()
    WHERE id = p_review_id;
  END IF;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, new_values, reason)
  VALUES (
    p_admin_id, 'collusion_' || p_level, 'cancellation_review', p_review_id::text,
    jsonb_build_object('driver_id', v_review.driver_id, 'customer_id', v_review.customer_id,
                       'risk_score', v_review.risk_score, 'ride_ids', v_review.ride_ids),
    p_notes
  );

  RETURN jsonb_build_object('success', true, 'level', p_level, 'driver_user_id', v_driver_user);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_collusion_sanction(p_review_id uuid, p_admin_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_review      cancellation_reviews%ROWTYPE;
  v_driver_user uuid;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_review FROM cancellation_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'review_not_found'); END IF;
  IF v_review.status <> 'sanctioned' THEN
    RETURN jsonb_build_object('error', 'not_sanctioned', 'status', v_review.status);
  END IF;

  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;
  DELETE FROM cancellation_rating_events
  WHERE user_id = v_driver_user AND ride_id IS NULL
    AND reason = 'collusion:' || p_review_id::text;

  UPDATE cancellation_reviews SET
    status = 'reviewed', verdict = 'just', sanction_type = NULL,
    reviewed_by = p_admin_id, reviewed_at = now(), updated_at = now()
  WHERE id = p_review_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_id, 'collusion_reversed', 'cancellation_review', p_review_id::text, 'reversed on appeal');

  RETURN jsonb_build_object('success', true);
END;
$function$;

-- EXECUTE as in prod (proacl, 2026-11-02).
REVOKE ALL ON FUNCTION public._normalize_cuban_phone(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public._ops_target_refusal(uuid), public._ops_user_push(text, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._ride_context_for_caller(uuid), public.admin_set_user_active(uuid, boolean, text),
  public.detect_collusion_reviews(), public.apply_collusion_sanction(uuid, text, text, uuid),
  public.reverse_collusion_sanction(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.enforce_ride_transition(), public.enforce_ride_update_columns(),
  public.tg_rides_client_write_guard(), public.tg_driver_profiles_protect_admin_fields(),
  public.tg_users_protect_admin_fields(), public.tg_support_tickets_client_update_guard(),
  public.tg_ticket_messages_client_guard(), public.tg_lost_items_client_guard(), public.update_rating_avg()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_ride_disputes_protect_columns() FROM anon, authenticated;
