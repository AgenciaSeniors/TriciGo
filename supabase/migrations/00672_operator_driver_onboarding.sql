-- ============================================================
-- 00672 — Operator role, delivery 2: driver onboarding and fleets
-- ============================================================
--
-- Design: docs/superpowers/specs/2026-10-25-operator-role-design.md (§3, Delivery 2).
-- The panel wrote these decisions straight to the tables, which only admins may update. Every one
-- of them becomes a function that admins and operators share, so the panel keeps one code path:
--
--   ops_set_driver_status        approve, reject or suspend a driver (the buttons of /drivers/[id])
--   ops_review_driver_document   verify or reject one document
--   ops_add_driver_document      record a document support uploaded for the driver
--   ops_log_driver_outreach      record a contact with a driver who did not finish signing up
--   ops_review_fleet_account     approve or reject a fleet request (an account with a driver_fleets row)
--   ops_review_fleet_member      approve or reject a driver a fleet invites, bound to the row shown
--
-- Rules for all of them (spec §3): SECURITY DEFINER, gated by is_ops_staff(), executable by
-- authenticated and service_role only; never on the caller's own account, driver profile or fleet
-- ('self_action'); an operator acts only on passengers and drivers, never on a team member
-- ('target_is_staff'); one admin_actions row per decision; the push to the driver goes out from the
-- server through cron_http_post (label ops-driver-review). Refusals are {error} objects, as in the
-- ride support functions.
--
-- The checks that would silently undo an operator's decision let it through when it acts inside one
-- of these functions (_ops_acting_on, 00671), as they let an admin through:
--   tg_driver_profiles_protect_admin_fields   status, approval and suspension columns
--   tg_users_protect_admin_fields             the customer -> driver step on approval (only that;
--                                             the 00599 phone block and the 00661 team block stay)
--   tg_driver_documents_protect_review        the review columns
--   tg_corporate_accounts_protect_admin_fields  status, approved_at and is_fleet_owner of a fleet
--   tg_fleet_members_protect                  the review of an invitation
-- The approval gates of 00491 (an active vehicle) stay above every bypass.
--
-- Each body is replaced only from its known md5 (the body in prod on 2026-11-02), each replaced text
-- must appear exactly once, and the migration checks the result. Re-applying it changes nothing.

-- ── A. Patches ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.m00672_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
                                               p_olds text[], p_news text[])
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_md5 text;
  v_def text;
  i integer;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00672: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00672: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
END
$function$;

SELECT pg_temp.m00672_patch('public.tg_driver_profiles_protect_admin_fields()', 'ccded3e1847c164327dd049c9391ffde',
  'eb950c28105cc3066e433bebcca03322',
  ARRAY[E'  IF is_admin() THEN\n    RETURN NEW;\n  END IF;'],
  ARRAY[E'  -- 00672: ops staff inside an ops function acting on this profile (ops_set_driver_status).\n'
        || E'  IF is_admin() OR public._ops_acting_on(NEW.id) THEN\n    RETURN NEW;\n  END IF;']);

SELECT pg_temp.m00672_patch('public.tg_users_protect_admin_fields()', '3bba8e032479c93da3a2720cd7263049',
  '1934b73fc021a66a25ac89502a8a2a06',
  ARRAY[E'  IF auth.uid() IS NULL THEN\n    RETURN NEW;\n  END IF;'],
  ARRAY[E'  -- 00672: ops_set_driver_status approving this user''s driver profile. Only the customer ->\n'
        || E'  -- driver step of ensure_driver_role_and_tricicoin_on_approval passes, as for an admin.\n'
        || E'  IF public._ops_acting_on(NEW.id) THEN\n'
        || E'    IF NOT (OLD.role = ''customer'' AND NEW.role = ''driver''\n'
        || E'            AND EXISTS (SELECT 1 FROM driver_profiles dp\n'
        || E'                        WHERE dp.user_id = NEW.id AND dp.status = ''approved'')) THEN\n'
        || E'      NEW.role := OLD.role;\n'
        || E'    END IF;\n'
        || E'    NEW.is_active            := OLD.is_active;\n'
        || E'    NEW.level                := OLD.level;\n'
        || E'    NEW.total_rides          := OLD.total_rides;\n'
        || E'    NEW.total_spent          := OLD.total_spent;\n'
        || E'    NEW.cancellation_count   := OLD.cancellation_count;\n'
        || E'    NEW.last_cancellation_at := OLD.last_cancellation_at;\n'
        || E'    NEW.id                   := OLD.id;\n'
        || E'    NEW.created_at           := OLD.created_at;\n'
        || E'    RETURN NEW;\n'
        || E'  END IF;\n\n'
        || E'  IF auth.uid() IS NULL THEN\n    RETURN NEW;\n  END IF;']);

SELECT pg_temp.m00672_patch('public.tg_driver_documents_protect_review()', '1fa394a57d0c9f63ae4f80c77e443f82',
  '3015acfbce7f98ede86d918fe0aa4a7e',
  ARRAY[E'  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN'],
  ARRAY[E'  -- 00672: ops staff inside ops_review_driver_document, on this document.\n'
        || E'  IF auth.uid() IS NOT NULL AND NOT public.is_admin() AND NOT public._ops_acting_on(NEW.id) THEN']);

SELECT pg_temp.m00672_patch('public.tg_corporate_accounts_protect_admin_fields()', 'f84d5d8db97c7d07dbc46061ce5e5055',
  'a8263f1d55d0af6ade45d972b21e6800',
  ARRAY[E'  IF is_admin() THEN\n    RETURN NEW;\n  END IF;'],
  ARRAY[E'  -- 00672: ops staff inside ops_review_fleet_account, on this fleet''s account.\n'
        || E'  IF is_admin() OR public._ops_acting_on(NEW.id) THEN\n    RETURN NEW;\n  END IF;']);

SELECT pg_temp.m00672_patch('public.tg_fleet_members_protect()', '2b65b4b84e3a2ce323197501e5742c1a',
  '9604aabd771340db647705c0cba33d58',
  ARRAY[E'  IF is_admin() THEN RETURN NEW; END IF;'],
  ARRAY[E'  -- 00672: ops staff inside ops_review_fleet_member, on this invitation.\n'
        || E'  IF is_admin() OR public._ops_acting_on(NEW.id) THEN RETURN NEW; END IF;']);

-- ── B. Helpers ──────────────────────────────────────────────
-- The push to a driver about their onboarding, from the server. The panel sent it from the
-- browser, where send-push refuses an operator. Like notificationService.sendToUser: no category
-- (send-push would overwrite data.type, which the apps route on), skipped when the driver turned
-- off approval notices. Never fails the decision: a failure is logged in rpc_attempt_log.
CREATE OR REPLACE FUNCTION public._ops_user_push(p_rpc text, p_target uuid, p_user_id uuid,
                                                 p_title text, p_body text, p_data jsonb)
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

-- Who may be acted on: never the caller, and an operator only on passengers and drivers. Returns
-- the refusal, or NULL.
CREATE OR REPLACE FUNCTION public._ops_target_refusal(p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
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

-- ── C. ops_set_driver_status ────────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_set_driver_status(p_driver_id uuid, p_status text,
                                                        p_expected_status text, p_reason text DEFAULT NULL)
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

-- ── C. ops_review_driver_document ───────────────────────────
-- p_message is what the driver reads (the reason chips and the note, composed by the panel);
-- p_reason_codes and p_note go to the rejection e-mail as notify-document-rejection expects them.
CREATE OR REPLACE FUNCTION public.ops_review_driver_document(p_document_id uuid, p_verified boolean,
                                                             p_message text DEFAULT NULL,
                                                             p_reason_codes text[] DEFAULT '{}',
                                                             p_note text DEFAULT NULL)
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

-- ── C. ops_add_driver_document ──────────────────────────────
-- After storage-upload stored the file under driver-docs/<driver>/<type>/. The row is born
-- unverified (tg_driver_documents_protect_review does that for anyone but an admin anyway).
CREATE OR REPLACE FUNCTION public.ops_add_driver_document(p_driver_id uuid, p_document_type text,
                                                          p_storage_path text, p_file_name text,
                                                          p_mime_type text)
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

-- ── C. ops_log_driver_outreach ──────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_log_driver_outreach(p_driver_profile_id uuid, p_channel text,
                                                          p_note text DEFAULT NULL)
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

-- ── C. ops_review_fleet_account ─────────────────────────────
-- Only an account with a driver_fleets row: corporate clients stay admin (corporate.clients).
-- Approval also sets is_fleet_owner, as corporateService.approveAccount does for a fleet.
CREATE OR REPLACE FUNCTION public.ops_review_fleet_account(p_account_id uuid, p_decision text,
                                                           p_expected_status text, p_reason text DEFAULT NULL)
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

-- ── C. ops_review_fleet_member ──────────────────────────────
-- Bound to the invitation as the reviewer saw it, as fleetService.approveMember was: it stays
-- pending_review and every reviewed column (FLEET_MEMBER_REVIEWED_FIELDS in packages/types) still
-- has the value shown, or nothing changes ('member_changed'). The 00598 trigger links the account
-- that confirmed the phone in this same update.
CREATE OR REPLACE FUNCTION public.ops_review_fleet_member(p_member_id uuid, p_decision text,
                                                          p_shown jsonb, p_reason text DEFAULT NULL)
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

-- ── Permissions ─────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._ops_user_push(text, uuid, uuid, text, text, jsonb),
                       public._ops_target_refusal(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ops_set_driver_status(uuid, text, text, text),
                       public.ops_review_driver_document(uuid, boolean, text, text[], text),
                       public.ops_add_driver_document(uuid, text, text, text, text),
                       public.ops_log_driver_outreach(uuid, text, text),
                       public.ops_review_fleet_account(uuid, text, text, text),
                       public.ops_review_fleet_member(uuid, text, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_set_driver_status(uuid, text, text, text),
                          public.ops_review_driver_document(uuid, boolean, text, text[], text),
                          public.ops_add_driver_document(uuid, text, text, text, text),
                          public.ops_log_driver_outreach(uuid, text, text),
                          public.ops_review_fleet_account(uuid, text, text, text),
                          public.ops_review_fleet_member(uuid, text, jsonb, text)
  TO authenticated, service_role;

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.tg_driver_profiles_protect_admin_fields()', 'public.tg_users_protect_admin_fields()',
    'public.tg_driver_documents_protect_review()', 'public.tg_corporate_accounts_protect_admin_fields()',
    'public.tg_fleet_members_protect()', 'public._ops_user_push(text,uuid,uuid,text,text,jsonb)',
    'public._ops_target_refusal(uuid)', 'public.ops_set_driver_status(uuid,text,text,text)',
    'public.ops_review_driver_document(uuid,boolean,text,text[],text)',
    'public.ops_add_driver_document(uuid,text,text,text,text)', 'public.ops_log_driver_outreach(uuid,text,text)',
    'public.ops_review_fleet_account(uuid,text,text,text)', 'public.ops_review_fleet_member(uuid,text,jsonb,text)'
  ]::regprocedure[] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── Checks ──────────────────────────────────────────────────
DO $check$
DECLARE
  v_row record;
  v_set text;
BEGIN
  FOR v_row IN
    SELECT f.fn, f.want, md5(p.prosrc) AS got
    FROM (VALUES
      ('public.tg_driver_profiles_protect_admin_fields()'::regprocedure, 'eb950c28105cc3066e433bebcca03322'),
      ('public.tg_users_protect_admin_fields()', '1934b73fc021a66a25ac89502a8a2a06'),
      ('public.tg_driver_documents_protect_review()', '3015acfbce7f98ede86d918fe0aa4a7e'),
      ('public.tg_corporate_accounts_protect_admin_fields()', 'a8263f1d55d0af6ade45d972b21e6800'),
      ('public.tg_fleet_members_protect()', '9604aabd771340db647705c0cba33d58'),
      ('public._ops_user_push(text,uuid,uuid,text,text,jsonb)', '73fd48ad4447f90a308e463ee03617ad'),
      ('public._ops_target_refusal(uuid)', '55a2f2930bbe799fe9617521330e5979'),
      ('public.ops_set_driver_status(uuid,text,text,text)', 'a27519ab241af329cf374c9921e6479c'),
      ('public.ops_review_driver_document(uuid,boolean,text,text[],text)', 'acda0cbfa7b5350f4e765adb5ed2f86a'),
      ('public.ops_add_driver_document(uuid,text,text,text,text)', 'ce59a4701154f09420e3b876b7af45b1'),
      ('public.ops_log_driver_outreach(uuid,text,text)', '354fd82dddd10912a36098fe46bad08e'),
      ('public.ops_review_fleet_account(uuid,text,text,text)', '57913ebd47abeea8baef0cc252a29a58'),
      ('public.ops_review_fleet_member(uuid,text,jsonb,text)', '49898a2b2a042f4dc37de28d89119b13')
    ) AS f(fn, want)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got <> v_row.want THEN
      RAISE EXCEPTION '00672 check: % md5 is %', v_row.fn, v_row.got;
    END IF;
  END LOOP;

  -- Only these functions call the ops helpers or the operator checks: 00668's nineteen, 00671's
  -- eleven and this migration's twelve.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    ORDER BY p.proname) INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|_ops_target_refusal|_ops_user_push)\s*\('
    AND p.proname NOT IN ('is_operator', 'is_ops_staff', '_ops_acting_on', '_ops_allow',
      -- 00668
      '_panel_driver_churn_risk', 'admin_active_ride_context', 'admin_get_online_fleet',
      'admin_incomplete_driver_signups', 'admin_launch_pulse', 'admin_ride_assist_candidates',
      'admin_ride_assist_context', 'admin_support_waiting_rides', 'get_admin_dashboard_metrics',
      'get_admin_wallet_stats', 'get_corporate_balance', 'get_corporate_employees',
      'get_driver_utilization', 'get_peak_hours', 'get_product_failures', 'get_rides_by_day',
      'get_rides_by_payment_method', 'get_rides_by_service_type', 'get_top_drivers',
      -- 00671
      'enforce_ride_transition', 'enforce_ride_update_columns', 'tg_rides_validate_actuals',
      'complete_ride_and_pay', 'admin_offer_ride_to_driver', 'admin_assign_ride_to_driver',
      'admin_change_ride_service', 'admin_release_active_ride', 'admin_advance_active_ride',
      'admin_complete_active_ride', 'admin_cancel_ride',
      -- 00672
      'tg_driver_profiles_protect_admin_fields', 'tg_users_protect_admin_fields',
      'tg_driver_documents_protect_review', 'tg_corporate_accounts_protect_admin_fields',
      'tg_fleet_members_protect', '_ops_user_push', '_ops_target_refusal', 'ops_set_driver_status',
      'ops_review_driver_document', 'ops_add_driver_document', 'ops_log_driver_outreach',
      'ops_review_fleet_account', 'ops_review_fleet_member');
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00672 check: other functions call the ops checks: %', v_set;
  END IF;

  -- Money and roles stay admin-only.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('admin_adjust_wallet', 'admin_send_gift', 'admin_reverse_gift', 'freeze_wallet',
                      'unfreeze_wallet', 'approve_wallet_recharge', 'process_dispute_refund',
                      'admin_refund_ride_commission', 'admin_reward_referral', 'admin_invalidate_referral',
                      'set_referral_amounts', 'admin_send_wallet_v2_bonus_push', 'get_platform_earnings',
                      'promote_user_role', 'admin_set_user_level')
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|_ops_target_refusal|''operator'')';
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00672 check: a money or role function names the operator: %', v_set;
  END IF;

  -- Each ops function: SECURITY DEFINER, out of anon's reach, open to authenticated, and it logs.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.prosrc FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'ops\_%'
  LOOP
    IF NOT v_row.prosecdef
       OR has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_row.fn, 'EXECUTE')
       OR position('INSERT INTO public.admin_actions' IN v_row.prosrc) = 0 THEN
      RAISE EXCEPTION '00672 check: % is not a proper ops function', v_row.fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'ops\_%') <> 6 THEN
    RAISE EXCEPTION '00672 check: expected six ops functions';
  END IF;

  -- The helpers stay the owner's.
  IF has_function_privilege('authenticated', 'public._ops_user_push(text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._ops_user_push(text,uuid,uuid,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._ops_target_refusal(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._ops_target_refusal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00672 check: the helpers are open to clients';
  END IF;
END
$check$;
