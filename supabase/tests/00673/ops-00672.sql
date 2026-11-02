-- The six ops functions of 00672, as in prod on 2026-11-02 (pg_get_functiondef). Loaded without body
-- checks: they use %ROWTYPE of tables this rehearsal does not build, and 00673 only counts them.
SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.ops_add_driver_document(p_driver_id uuid, p_document_type text, p_storage_path text, p_file_name text, p_mime_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_user    uuid;
  v_refusal text;
  v_prefix  text;
  v_doc     public.driver_documents%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT dp.user_id INTO v_user FROM public.driver_profiles dp WHERE dp.id = p_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  v_refusal := public._ops_target_refusal(v_user);
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_refusal);
  END IF;
  IF p_document_type IS NULL
     OR NOT p_document_type = ANY (enum_range(NULL::public.document_type)::text[]) THEN
    RETURN jsonb_build_object('error', 'invalid_document_type');
  END IF;
  v_prefix := 'driver-docs/' || p_driver_id::text || '/' || p_document_type || '/';
  IF p_storage_path IS NULL OR left(p_storage_path, length(v_prefix)) <> v_prefix
     OR length(p_storage_path) = length(v_prefix) OR position('..' IN p_storage_path) > 0 THEN
    RETURN jsonb_build_object('error', 'invalid_path');
  END IF;

  INSERT INTO public.driver_documents (driver_id, document_type, storage_path, file_name, mime_type)
  VALUES (p_driver_id, p_document_type::public.document_type, p_storage_path,
          NULLIF(btrim(COALESCE(p_file_name, '')), ''), p_mime_type)
  RETURNING * INTO v_doc;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (v_me, 'upload_driver_document', 'driver_document', v_doc.id::text,
          jsonb_build_object('driver_profile_id', p_driver_id, 'document_type', p_document_type));

  RETURN jsonb_build_object('success', true, 'document', to_jsonb(v_doc));
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_log_driver_outreach(p_driver_profile_id uuid, p_channel text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_user    uuid;
  v_refusal text;
  v_id      uuid;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'llamada', 'sms', 'otro') THEN
    RETURN jsonb_build_object('error', 'invalid_channel');
  END IF;
  SELECT dp.user_id INTO v_user FROM public.driver_profiles dp WHERE dp.id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  v_refusal := public._ops_target_refusal(v_user);
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_refusal);
  END IF;

  -- tg_driver_outreach_log_stamp writes who and when from auth.uid().
  INSERT INTO public.driver_outreach_log (driver_profile_id, channel, note)
  VALUES (p_driver_profile_id, p_channel, p_note)
  RETURNING id INTO v_id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (v_me, 'log_driver_outreach', 'driver_profile', p_driver_profile_id::text,
          jsonb_build_object('channel', p_channel, 'outreach_id', v_id));

  RETURN jsonb_build_object('success', true, 'id', v_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_review_driver_document(p_document_id uuid, p_verified boolean, p_message text DEFAULT NULL::text, p_reason_codes text[] DEFAULT '{}'::text[], p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_message text := NULLIF(btrim(COALESCE(p_message, '')), '');
  v_doc     public.driver_documents%ROWTYPE;
  v_user    uuid;
  v_refusal text;
  v_label   text;
  v_key     text;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_verified IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_decision');
  END IF;
  IF NOT p_verified AND v_message IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_doc FROM public.driver_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'document_not_found');
  END IF;
  SELECT dp.user_id INTO v_user FROM public.driver_profiles dp WHERE dp.id = v_doc.driver_id;
  v_refusal := public._ops_target_refusal(v_user);
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_refusal);
  END IF;

  PERFORM public._ops_allow(ARRAY[v_doc.id]);
  UPDATE public.driver_documents
     SET is_verified = p_verified, verified_by = v_me, verified_at = now(),
         verification_notes = v_message,
         rejection_reason = CASE WHEN p_verified THEN NULL ELSE v_message END
   WHERE id = v_doc.id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (v_me, CASE WHEN p_verified THEN 'verify_document' ELSE 'reject_document' END,
          'driver_document', v_doc.id::text, v_message);

  v_label := CASE v_doc.document_type::text
    WHEN 'national_id' THEN 'Cédula'
    WHEN 'drivers_license' THEN 'Licencia de conducción'
    WHEN 'vehicle_registration' THEN 'Registro del vehículo'
    WHEN 'vehicle_photo' THEN 'Foto del vehículo'
    WHEN 'selfie' THEN 'Selfie'
    WHEN 'operating_license' THEN 'Licencia operativa'
    ELSE 'Documento' END;
  PERFORM public._ops_user_push('ops_review_driver_document', v_doc.id, v_user,
    CASE WHEN p_verified THEN '✅ ' || v_label || ' verificado' ELSE '⚠️ ' || v_label || ' rechazado' END,
    CASE WHEN p_verified THEN 'Tu ' || lower(v_label) || ' fue aprobado.'
         ELSE 'Tu ' || lower(v_label) || ' fue rechazado: ' || v_message END,
    jsonb_build_object('type', 'driver_document', 'document_id', v_doc.id::text,
                       'action', CASE WHEN p_verified THEN 'verified' ELSE 'rejected' END,
                       'cta', '/profile/documents'));

  -- The rejection e-mail (verification sends none). notify-document-rejection takes the service key.
  IF NOT p_verified THEN
    BEGIN
      v_key := public.get_service_role_key();
      IF v_key IS NULL OR v_key = '' THEN
        PERFORM public.log_rpc_attempt('ops_review_driver_document', v_me, v_doc.id, 'email_failed',
          jsonb_build_object('error', 'no service role key'));
      ELSE
        PERFORM public.cron_http_post('ops-document-rejection-email',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/notify-document-rejection',
          headers := jsonb_build_object('Content-Type', 'application/json',
                                        'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
          body    := jsonb_build_object('documentId', v_doc.id::text,
                                        'reasonCodes', to_jsonb(COALESCE(p_reason_codes, '{}'::text[])),
                                        'note', COALESCE(btrim(p_note), '')));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.log_rpc_attempt('ops_review_driver_document', v_me, v_doc.id, 'email_failed',
        jsonb_build_object('error', SQLERRM));
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'is_verified', p_verified);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_review_fleet_account(p_account_id uuid, p_decision text, p_expected_status text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ca     public.corporate_accounts%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('error', 'invalid_decision');
  END IF;
  IF p_decision = 'rejected' AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ca FROM public.corporate_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'account_not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver_fleets df WHERE df.corporate_account_id = v_ca.id) THEN
    RETURN jsonb_build_object('error', 'not_a_fleet');
  END IF;
  IF v_ca.created_by = v_me OR EXISTS (
       SELECT 1 FROM public.corporate_employees ce
       WHERE ce.corporate_account_id = v_ca.id AND ce.user_id = v_me AND ce.is_active) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_ca.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'account_changed', 'status', v_ca.status);
  END IF;
  IF v_ca.status::text <> 'pending' THEN
    RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_ca.status);
  END IF;

  PERFORM public._ops_allow(ARRAY[v_ca.id]);
  IF p_decision = 'approved' THEN
    UPDATE public.corporate_accounts SET status = 'approved', approved_at = now(), is_fleet_owner = true
     WHERE id = v_ca.id;
  ELSE
    UPDATE public.corporate_accounts SET status = 'rejected', suspended_reason = v_reason WHERE id = v_ca.id;
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me, CASE WHEN p_decision = 'approved' THEN 'approve_corporate' ELSE 'reject_corporate' END,
          'corporate_account', v_ca.id::text,
          jsonb_build_object('status', v_ca.status), jsonb_build_object('status', p_decision, 'fleet', true),
          v_reason);

  RETURN jsonb_build_object('success', true, 'status', p_decision);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_review_fleet_member(p_member_id uuid, p_decision text, p_shown jsonb, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_owner  uuid;
  v_n      integer;
  v_status text;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('error', 'invalid_decision');
  END IF;
  IF p_decision = 'rejected' AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_shown IS NULL OR jsonb_typeof(p_shown) <> 'object' THEN
    RETURN jsonb_build_object('error', 'invalid_shown');
  END IF;

  SELECT ca.created_by INTO v_owner
  FROM public.fleet_members fm
  JOIN public.driver_fleets df ON df.id = fm.fleet_id
  JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
  WHERE fm.id = p_member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'member_not_found');
  END IF;
  IF v_owner = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;

  PERFORM public._ops_allow(ARRAY[p_member_id]);
  UPDATE public.fleet_members fm
     SET status = p_decision, reviewed_by = v_me, reviewed_at = now(),
         rejected_reason = CASE WHEN p_decision = 'rejected' THEN v_reason ELSE fm.rejected_reason END
   WHERE fm.id = p_member_id
     AND fm.status = 'pending_review'
     AND fm.fleet_id::text IS NOT DISTINCT FROM (p_shown ->> 'fleet_id')
     AND fm.driver_name IS NOT DISTINCT FROM (p_shown ->> 'driver_name')
     AND fm.driver_phone IS NOT DISTINCT FROM (p_shown ->> 'driver_phone')
     AND fm.driver_email IS NOT DISTINCT FROM (p_shown ->> 'driver_email')
     AND fm.driver_license_number IS NOT DISTINCT FROM (p_shown ->> 'driver_license_number')
     AND fm.driver_id_number IS NOT DISTINCT FROM (p_shown ->> 'driver_id_number')
     AND fm.license_doc_path IS NOT DISTINCT FROM (p_shown ->> 'license_doc_path');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('error', 'member_changed');
  END IF;
  SELECT status INTO v_status FROM public.fleet_members WHERE id = p_member_id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values, reason)
  VALUES (v_me, CASE WHEN p_decision = 'approved' THEN 'approve_fleet_member' ELSE 'reject_fleet_member' END,
          'fleet_member', p_member_id::text, jsonb_build_object('status', v_status), v_reason);

  RETURN jsonb_build_object('success', true, 'status', v_status);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_set_driver_status(p_driver_id uuid, p_status text, p_expected_status text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_reason  text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_dp      public.driver_profiles%ROWTYPE;
  v_refusal text;
  v_title   text;
  v_body    text;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('approved', 'rejected', 'suspended') THEN
    RETURN jsonb_build_object('error', 'invalid_status');
  END IF;
  IF p_status IN ('rejected', 'suspended') AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  v_refusal := public._ops_target_refusal(v_dp.user_id);
  IF v_refusal IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_refusal);
  END IF;
  IF v_dp.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'driver_changed', 'status', v_dp.status);
  END IF;
  -- The buttons of /drivers/[id]: approve from review, rejection or suspension; reject from
  -- review; suspend an approved driver.
  IF NOT ((p_status = 'approved' AND v_dp.status::text IN ('pending_verification', 'under_review', 'rejected', 'suspended'))
          OR (p_status = 'rejected' AND v_dp.status::text IN ('pending_verification', 'under_review'))
          OR (p_status = 'suspended' AND v_dp.status::text = 'approved')) THEN
    RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_dp.status);
  END IF;
  -- The trigger refuses it too (00491); this says why.
  IF p_status = 'approved' AND NOT EXISTS (
       SELECT 1 FROM public.vehicles v WHERE v.driver_id = v_dp.id AND v.is_active) THEN
    RETURN jsonb_build_object('error', 'driver_has_no_active_vehicle');
  END IF;

  PERFORM public._ops_allow(ARRAY[v_dp.id, v_dp.user_id]);
  IF p_status = 'approved' THEN
    UPDATE public.driver_profiles SET status = 'approved', approved_at = now() WHERE id = v_dp.id;
    v_title := 'Cuenta aprobada';
    v_body  := '¡Tu cuenta de conductor ha sido aprobada. Ya puedes recibir viajes!';
  ELSIF p_status = 'rejected' THEN
    UPDATE public.driver_profiles SET status = 'rejected' WHERE id = v_dp.id;
    v_title := 'Solicitud rechazada';
    v_body  := 'Tu solicitud de conductor no fue aprobada. Revisa tus documentos.';
  ELSE
    UPDATE public.driver_profiles
       SET status = 'suspended', is_online = false, suspended_at = now(), suspended_reason = v_reason
     WHERE id = v_dp.id;
    v_title := 'Cuenta suspendida';
    v_body  := 'Tu cuenta ha sido suspendida. Contacta soporte para más información.';
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me,
          CASE p_status WHEN 'approved' THEN 'approve_driver' WHEN 'rejected' THEN 'reject_driver' ELSE 'suspend_driver' END,
          'driver_profile', v_dp.id::text,
          jsonb_build_object('status', v_dp.status), jsonb_build_object('status', p_status), v_reason);

  PERFORM public._ops_user_push('ops_set_driver_status', v_dp.id, v_dp.user_id, v_title, v_body,
    jsonb_build_object('type', 'driver_status', 'status', p_status)
      || CASE WHEN v_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', v_reason) END);

  RETURN jsonb_build_object('success', true, 'status', p_status, 'previous_status', v_dp.status);
END
$function$;

RESET check_function_bodies;
REVOKE ALL ON FUNCTION public.ops_set_driver_status(uuid, text, text, text),
                       public.ops_review_driver_document(uuid, boolean, text, text[], text),
                       public.ops_add_driver_document(uuid, text, text, text, text),
                       public.ops_log_driver_outreach(uuid, text, text),
                       public.ops_review_fleet_account(uuid, text, text, text),
                       public.ops_review_fleet_member(uuid, text, jsonb, text)
  FROM PUBLIC, anon;
