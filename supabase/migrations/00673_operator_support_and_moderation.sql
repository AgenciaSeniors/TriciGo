-- ============================================================
-- 00673 — Operator role, delivery 4: support, accounts and moderation
-- ============================================================
--
-- Design: docs/superpowers/specs/2026-10-25-operator-role-design.md (§3, §4, Delivery 4).
-- Plan: docs/superpowers/plans/2026-11-02-operator-role-support.md.
-- Since 00668 the operator opens the support, case, account and moderation pages but cannot act on
-- them: the panel wrote straight to tables only admins may update. Every action becomes a function
-- that admins and operators share (marketing too, for tickets), so the panel keeps one code path:
--
--   ops_update_ticket                   change a ticket's status
--   ops_reply_ticket                    answer a ticket; an open ticket moves to in_progress
--   ops_update_incident                 investigate, resolve or dismiss; hide the review it reports
--   ops_update_lost_item                admin notes, close the report
--   ops_update_dispute                  take a dispute, admin notes
--   ops_resolve_dispute_without_refund  no_action or warning_issued
--   ops_escalate_dispute                propose a refund to an admin (ride_dispute_escalations)
--   ops_set_review_visibility           show or hide a review
--   ops_resolve_fraud_alert             resolve a fraud alert
--
-- Money stays with admins: admin_refund_escalated_dispute pays a proposal through the unchanged
-- process_dispute_refund. Opened to operations staff with a check of their own: admin_set_user_active
-- (an account that is not a passenger or a driver now needs a super admin, for admins too) and the
-- collusion queue (detect_collusion_reviews, apply_collusion_sanction, reverse_collusion_sanction).
--
-- Rules for the new functions (spec §3): SECURITY DEFINER, executable by authenticated and
-- service_role only; never on the caller's own ticket, case, ride, review or alert ('self_action');
-- bound to the state the panel showed ('*_changed'); one admin_actions row per decision; the notices
-- to the parties go out from the server through cron_http_post (label ops-case-notice). Refusals are
-- {error} objects, as in the 00671 and 00672 functions.
--
-- The checks that would silently undo an operator's decision let it through inside one of these
-- functions (_ops_acting_on, 00671):
--   tg_ride_disputes_protect_columns   every column of the dispute
--   tg_users_protect_admin_fields      is_active, for admin_set_user_active (role, level and the
--                                      counters stay protected)
-- The ticket, message and lost-item guards (00653, 00663) already let a SECURITY DEFINER function
-- through: there current_user is its owner.
--
-- Each body is replaced only from its known md5 (the body in prod on 2026-11-02), each replaced text
-- must appear exactly once, and the migration checks the result. Re-applying it changes nothing.

-- ── A. Patches ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.m00673_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
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
    RAISE EXCEPTION '00673: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00673: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
END
$function$;

SELECT pg_temp.m00673_patch('public.tg_ride_disputes_protect_columns()', 'e7c521901228c1119a51219ea934544c',
  '20b090fe5136655fc54707335566d88a',
  ARRAY[E'  IF is_admin() THEN\n    RETURN NEW;\n  END IF;'],
  ARRAY[E'  -- 00673: ops staff inside an ops function acting on this dispute.\n'
        || E'  IF is_admin() OR public._ops_acting_on(NEW.id) THEN\n    RETURN NEW;\n  END IF;']);

SELECT pg_temp.m00673_patch('public.tg_users_protect_admin_fields()', '1934b73fc021a66a25ac89502a8a2a06',
  'b7ce2ad1730bbcabae8bae6e612df802',
  ARRAY[E'      NEW.role := OLD.role;\n    END IF;\n    NEW.is_active            := OLD.is_active;\n'],
  ARRAY[E'      NEW.role := OLD.role;\n    END IF;\n'
        || E'    -- 00673: is_active passes, for admin_set_user_active blocking or unblocking this user.\n']);

SELECT pg_temp.m00673_patch('public.admin_set_user_active(uuid,boolean,text)', '4fa49090b30f985f46cf740c300e677f',
  '7bdd11ba3b7f174b3ad84e838b81424e',
  ARRAY[E'  IF v_caller IS NULL OR NOT public.is_admin() THEN\n'
        || E'    RAISE EXCEPTION USING ERRCODE = ''42501'',\n'
        || E'      MESSAGE = ''Solo un administrador puede bloquear o desbloquear cuentas.'', DETAIL = ''not_admin'';',
        E'  IF v_role IN (''admin'', ''super_admin'') AND NOT public.is_super_admin() THEN\n'
        || E'    RAISE EXCEPTION USING ERRCODE = ''42501'',\n'
        || E'      MESSAGE = ''Solo un super admin puede bloquear o desbloquear a otro administrador.'', DETAIL = ''target_is_staff'';',
        E'  IF p_active THEN\n    UPDATE public.users SET is_active = true WHERE id = p_user_id;'],
  ARRAY[E'  -- 00673: operations staff (admins and the operator).\n'
        || E'  IF v_caller IS NULL OR NOT public.is_ops_staff() THEN\n'
        || E'    RAISE EXCEPTION USING ERRCODE = ''42501'',\n'
        || E'      MESSAGE = ''Tu rol no puede bloquear ni desbloquear cuentas.'', DETAIL = ''not_admin'';',
        E'  -- 00673: only passengers and drivers; a team account (admin, marketing, operator) needs a\n'
        || E'  -- super admin.\n'
        || E'  IF v_role NOT IN (''customer'', ''driver'') AND NOT public.is_super_admin() THEN\n'
        || E'    RAISE EXCEPTION USING ERRCODE = ''42501'',\n'
        || E'      MESSAGE = ''Solo un super admin puede bloquear o desbloquear una cuenta del equipo.'', DETAIL = ''target_is_staff'';',
        E'  -- 00673: tg_users_protect_admin_fields lets is_active through for operations staff on this user.\n'
        || E'  PERFORM public._ops_allow(ARRAY[p_user_id]);\n'
        || E'  IF p_active THEN\n    UPDATE public.users SET is_active = true WHERE id = p_user_id;']);

SELECT pg_temp.m00673_patch('public.detect_collusion_reviews()', '94558654ff2fdd4a0482099f2649b690',
  '88441adb2332ff5e779c8f151741b9ea',
  ARRAY[E'  IF NOT public.is_admin() THEN\n    RAISE EXCEPTION ''forbidden: admin only'' USING ERRCODE = ''42501'';'],
  ARRAY[E'  -- 00673: operations staff (admins and the operator).\n'
        || E'  IF NOT public.is_ops_staff() THEN\n    RAISE EXCEPTION ''forbidden: operations staff only'' USING ERRCODE = ''42501'';']);

SELECT pg_temp.m00673_patch('public.apply_collusion_sanction(uuid,text,text,uuid)', '3586cce95c176a1ddf8f15c658a57830',
  'e2a208cfbc682610089ec9b49f51e963',
  ARRAY[E'  IF NOT is_admin() THEN\n    RETURN jsonb_build_object(''error'', ''forbidden'');\n  END IF;',
        E'  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;\n',
        E'  RETURN jsonb_build_object(''success'', true, ''level'', p_level, ''driver_user_id'', v_driver_user);'],
  ARRAY[E'  -- 00673: operations staff (admins and the operator).\n'
        || E'  IF NOT public.is_ops_staff() THEN\n    RETURN jsonb_build_object(''error'', ''forbidden'');\n  END IF;',
        E'  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;\n'
        || E'  -- 00673: never a case the caller is part of.\n'
        || E'  IF v_driver_user = auth.uid() OR v_review.customer_id = auth.uid() THEN\n'
        || E'    RETURN jsonb_build_object(''error'', ''self_action'');\n'
        || E'  END IF;\n',
        E'  -- 00673: the driver''s notice, from the server (the panel sent it from the browser, where\n'
        || E'  -- send-push refuses an operator). Same text it sent.\n'
        || E'  IF p_level IN (''warning'', ''reputation'') THEN\n'
        || E'    PERFORM public._ops_notice_push(''apply_collusion_sanction'', p_review_id, ARRAY[v_driver_user],\n'
        || E'      ''Aviso de la plataforma'',\n'
        || E'      ''Detectamos cancelaciones que requieren tu atención. Cancelar viajes ya empezados de forma repetida afecta tu reputación.'',\n'
        || E'      jsonb_build_object(''type'', ''account''));\n'
        || E'  END IF;\n\n'
        || E'  RETURN jsonb_build_object(''success'', true, ''level'', p_level, ''driver_user_id'', v_driver_user);']);

SELECT pg_temp.m00673_patch('public.reverse_collusion_sanction(uuid,uuid)', '4724bd489c39c51ab5a4b434993fd4f8',
  '82d3fca08a18b0f104efb1b8522dd8e5',
  ARRAY[E'  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id OR NOT is_admin() THEN',
        E'  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;\n'],
  ARRAY[E'  -- 00673: operations staff (admins and the operator).\n'
        || E'  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id OR NOT public.is_ops_staff() THEN',
        E'  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = v_review.driver_id;\n'
        || E'  -- 00673: never a case the caller is part of.\n'
        || E'  IF v_driver_user = auth.uid() OR v_review.customer_id = auth.uid() THEN\n'
        || E'    RETURN jsonb_build_object(''error'', ''self_action'');\n'
        || E'  END IF;\n']);

-- ── B. Helpers ──────────────────────────────────────────────
-- A notice to the parties of a case, from the server: one send-push call with no category (as
-- notificationService.sendToUser: send-push would overwrite data.type, which the apps route on) and
-- no preference gate (these are account notices). Never fails the action: a failure is logged in
-- rpc_attempt_log.
CREATE OR REPLACE FUNCTION public._ops_notice_push(p_rpc text, p_target uuid, p_user_ids uuid[],
                                                   p_title text, p_body text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ids jsonb;
  v_key text;
BEGIN
  SELECT jsonb_agg(DISTINCT u.id::text) INTO v_ids
  FROM unnest(p_user_ids) AS u(id) WHERE u.id IS NOT NULL;
  IF v_ids IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_target, 'push_failed',
        jsonb_build_object('user_ids', v_ids, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('ops-case-notice',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object('user_ids', v_ids, 'title', p_title, 'body', p_body,
                                      'data', COALESCE(p_data, '{}'::jsonb)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_target, 'push_failed',
      jsonb_build_object('user_ids', v_ids, 'error', SQLERRM));
  END;
END
$function$;

-- Whether the caller is the passenger or the driver of a ride.
CREATE OR REPLACE FUNCTION public._ops_is_ride_party(p_ride_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p_ride_id IS NOT NULL AND auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.rides r
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    WHERE r.id = p_ride_id AND (r.customer_id = auth.uid() OR dp.user_id = auth.uid()));
$function$;

-- ── C. Tickets (also marketing) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_update_ticket(p_ticket_id uuid, p_status text, p_expected_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_t  public.support_tickets%ROWTYPE;
BEGIN
  IF NOT (public.is_ops_staff() OR public.is_marketing()) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed') THEN
    RETURN jsonb_build_object('error', 'invalid_status');
  END IF;

  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ticket_not_found');
  END IF;
  IF v_t.user_id = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_t.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'ticket_changed', 'status', v_t.status);
  END IF;
  IF v_t.status = p_status THEN
    RETURN jsonb_build_object('success', true, 'status', p_status);
  END IF;

  -- The dates as the client guard (00663) sets them: from resolved to closed the date stays.
  UPDATE public.support_tickets
     SET status = p_status, updated_at = now(),
         resolved_at = CASE WHEN p_status IN ('resolved', 'closed')
                            THEN CASE WHEN v_t.status IN ('resolved', 'closed') THEN COALESCE(v_t.resolved_at, now()) ELSE now() END
                            ELSE NULL END
   WHERE id = v_t.id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_me, 'ticket_status', 'support_ticket', v_t.id::text,
          jsonb_build_object('status', v_t.status), jsonb_build_object('status', p_status));

  RETURN jsonb_build_object('success', true, 'status', p_status);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_reply_ticket(p_ticket_id uuid, p_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_msg    text := NULLIF(btrim(COALESCE(p_message, '')), '');
  v_t      public.support_tickets%ROWTYPE;
  v_row    public.ticket_messages%ROWTYPE;
  v_status text;
BEGIN
  IF NOT (public.is_ops_staff() OR public.is_marketing()) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_msg IS NULL THEN
    RETURN jsonb_build_object('error', 'message_required');
  END IF;
  IF length(v_msg) > 4000 THEN
    RETURN jsonb_build_object('error', 'message_too_long');
  END IF;

  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ticket_not_found');
  END IF;
  IF v_t.user_id = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;

  INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin, created_at)
  VALUES (v_t.id, v_me, v_msg, true, now())
  RETURNING * INTO v_row;

  -- Answering an open ticket starts working on it (the panel did this in a second call).
  v_status := v_t.status;
  IF v_t.status = 'open' THEN
    UPDATE public.support_tickets SET status = 'in_progress', updated_at = now() WHERE id = v_t.id;
    v_status := 'in_progress';
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (v_me, 'ticket_reply', 'support_ticket', v_t.id::text,
          jsonb_build_object('message_id', v_row.id, 'status', v_status));

  RETURN jsonb_build_object('success', true, 'status', v_status, 'message', to_jsonb(v_row));
END
$function$;

-- ── D. Incidents ────────────────────────────────────────────
-- open -> investigating; open or investigating -> resolved or dismissed. p_hide_review hides the
-- review a review_abuse incident reports, in the same transaction as resolving it.
CREATE OR REPLACE FUNCTION public.ops_update_incident(p_incident_id uuid, p_status text, p_expected_status text,
                                                      p_notes text DEFAULT NULL, p_hide_review boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_notes  text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_i      public.incident_reports%ROWTYPE;
  v_review public.reviews%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('investigating', 'resolved', 'dismissed') THEN
    RETURN jsonb_build_object('error', 'invalid_status');
  END IF;

  SELECT * INTO v_i FROM public.incident_reports WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'incident_not_found');
  END IF;
  IF v_i.reported_by = v_me OR v_i.against_user_id = v_me OR public._ops_is_ride_party(v_i.ride_id) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_i.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'incident_changed', 'status', v_i.status);
  END IF;
  IF NOT ((p_status = 'investigating' AND v_i.status = 'open')
          OR (p_status IN ('resolved', 'dismissed') AND v_i.status IN ('open', 'investigating'))) THEN
    RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_i.status);
  END IF;

  IF COALESCE(p_hide_review, false) THEN
    IF p_status <> 'resolved' OR v_i.type <> 'review_abuse' OR v_i.review_id IS NULL THEN
      RETURN jsonb_build_object('error', 'invalid_request');
    END IF;
    SELECT * INTO v_review FROM public.reviews WHERE id = v_i.review_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'review_not_found');
    END IF;
    IF v_review.reviewer_id = v_me OR v_review.reviewee_id = v_me THEN
      RETURN jsonb_build_object('error', 'self_action');
    END IF;
    UPDATE public.reviews SET is_visible = false WHERE id = v_review.id;
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
    VALUES (v_me, 'hide_review', 'review', v_review.id::text,
            jsonb_build_object('is_visible', v_review.is_visible), jsonb_build_object('is_visible', false), v_notes);
  END IF;

  UPDATE public.incident_reports
     SET status = p_status::public.incident_status,
         resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE NULL END,
         resolved_by = CASE WHEN p_status = 'resolved' THEN v_me ELSE NULL END,
         resolution_notes = COALESCE(v_notes, resolution_notes),
         updated_at = now()
   WHERE id = v_i.id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me, 'incident_' || p_status, 'incident_report', v_i.id::text,
          jsonb_build_object('status', v_i.status), jsonb_build_object('status', p_status), v_notes);

  RETURN jsonb_build_object('success', true, 'status', p_status,
                            'review_hidden', COALESCE(p_hide_review, false));
END
$function$;

-- ── E. Lost items ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_update_lost_item(p_item_id uuid, p_action text, p_expected_status text,
                                                       p_notes text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me    uuid := auth.uid();
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_li    public.lost_items%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('notes', 'close') THEN
    RETURN jsonb_build_object('error', 'invalid_action');
  END IF;

  SELECT * INTO v_li FROM public.lost_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'lost_item_not_found');
  END IF;
  IF v_li.reporter_id = v_me OR v_li.driver_id = v_me OR public._ops_is_ride_party(v_li.ride_id) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_li.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'lost_item_changed', 'status', v_li.status);
  END IF;

  IF p_action = 'notes' THEN
    UPDATE public.lost_items SET admin_notes = v_notes WHERE id = v_li.id;
  ELSE
    IF v_li.status IN ('returned', 'closed') THEN
      RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_li.status);
    END IF;
    UPDATE public.lost_items
       SET status = 'closed', resolved_by = v_me, resolved_at = now(),
           admin_notes = COALESCE(v_notes, admin_notes)
     WHERE id = v_li.id;
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me, CASE p_action WHEN 'notes' THEN 'lost_item_notes' ELSE 'lost_item_closed' END,
          'lost_item', v_li.id::text, jsonb_build_object('status', v_li.status),
          jsonb_build_object('status', CASE p_action WHEN 'notes' THEN v_li.status ELSE 'closed' END), v_notes);

  RETURN jsonb_build_object('success', true,
                            'status', CASE p_action WHEN 'notes' THEN v_li.status ELSE 'closed' END);
END
$function$;

-- ── F. Disputes ─────────────────────────────────────────────
-- A refund an operator proposes and an admin pays (spec §4). No foreign key to users, so deleting
-- an account is not blocked by a row here.
CREATE TABLE IF NOT EXISTS public.ride_dispute_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL REFERENCES public.ride_disputes(id) ON DELETE CASCADE,
  resolution text NOT NULL CHECK (resolution IN ('full_refund', 'partial_refund', 'credit')),
  suggested_trc integer NOT NULL CHECK (suggested_trc > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refunded', 'closed')),
  escalated_by uuid NOT NULL,
  escalated_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid,
  resolved_at timestamptz,
  refund_transaction_id uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS ride_dispute_escalations_one_pending
  ON public.ride_dispute_escalations (dispute_id) WHERE status = 'pending';
ALTER TABLE public.ride_dispute_escalations ENABLE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ride_dispute_escalations'
                   AND policyname = 'ride_dispute_escalations_select_ops') THEN
    CREATE POLICY ride_dispute_escalations_select_ops ON public.ride_dispute_escalations
      FOR SELECT TO authenticated USING ((SELECT public.is_ops_staff()));
  END IF;
END
$policy$;
REVOKE ALL ON public.ride_dispute_escalations FROM anon, authenticated;
GRANT SELECT ON public.ride_dispute_escalations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ride_dispute_escalations TO service_role;

-- A dispute resolved by any path (an admin's direct refund included) closes its pending proposal.
CREATE OR REPLACE FUNCTION public.tg_ride_disputes_close_escalations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.status IN ('resolved_rider', 'resolved_driver', 'closed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.ride_dispute_escalations
       SET status = 'closed', resolved_by = auth.uid(), resolved_at = now()
     WHERE dispute_id = NEW.id AND status = 'pending';
  END IF;
  RETURN NULL;
END
$function$;
CREATE OR REPLACE TRIGGER trg_ride_disputes_close_escalations
  AFTER UPDATE OF status ON public.ride_disputes
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_disputes_close_escalations();

-- Take a dispute (assign it to the caller, under review) or save the team's notes.
CREATE OR REPLACE FUNCTION public.ops_update_dispute(p_dispute_id uuid, p_action text, p_expected_status text,
                                                     p_notes text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me    uuid := auth.uid();
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_d     public.ride_disputes%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('take', 'notes') THEN
    RETURN jsonb_build_object('error', 'invalid_action');
  END IF;

  SELECT * INTO v_d FROM public.ride_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'dispute_not_found');
  END IF;
  IF v_d.opened_by = v_me OR v_d.respondent_id = v_me OR public._ops_is_ride_party(v_d.ride_id) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_d.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'dispute_changed', 'status', v_d.status);
  END IF;

  PERFORM public._ops_allow(ARRAY[v_d.id]);
  IF p_action = 'take' THEN
    IF v_d.status IN ('resolved_rider', 'resolved_driver', 'closed', 'escalated') THEN
      RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_d.status);
    END IF;
    IF v_d.assigned_to IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'already_assigned');
    END IF;
    UPDATE public.ride_disputes SET status = 'under_review', assigned_to = v_me WHERE id = v_d.id;
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_me, 'dispute_taken', 'ride_dispute', v_d.id::text,
            jsonb_build_object('status', v_d.status), jsonb_build_object('status', 'under_review', 'assigned_to', v_me));
    PERFORM public._ops_notice_push('ops_update_dispute', v_d.id, ARRAY[v_d.opened_by, v_d.respondent_id],
      'Actualización de disputa', 'El estado de tu disputa ha cambiado', '{}'::jsonb);
    RETURN jsonb_build_object('success', true, 'status', 'under_review');
  END IF;

  UPDATE public.ride_disputes SET admin_notes = v_notes WHERE id = v_d.id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (v_me, 'dispute_notes', 'ride_dispute', v_d.id::text, v_notes);
  RETURN jsonb_build_object('success', true, 'status', v_d.status);
END
$function$;

-- Resolve in the driver's favour, with no money: the no_action and warning_issued resolutions.
CREATE OR REPLACE FUNCTION public.ops_resolve_dispute_without_refund(p_dispute_id uuid, p_resolution text,
                                                                     p_expected_status text, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me    uuid := auth.uid();
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_d     public.ride_disputes%ROWTYPE;
  v_ride  public.ride_status;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_resolution IS NULL OR p_resolution NOT IN ('no_action', 'warning_issued') THEN
    RETURN jsonb_build_object('error', 'invalid_resolution');
  END IF;
  IF v_notes IS NULL OR length(v_notes) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_d FROM public.ride_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'dispute_not_found');
  END IF;
  IF v_d.opened_by = v_me OR v_d.respondent_id = v_me OR public._ops_is_ride_party(v_d.ride_id) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_d.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'dispute_changed', 'status', v_d.status);
  END IF;
  IF v_d.status IN ('resolved_rider', 'resolved_driver', 'closed') THEN
    RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_d.status);
  END IF;

  -- The same lock order as process_dispute_refund: the dispute, then the ride.
  SELECT r.status INTO v_ride FROM public.rides r WHERE r.id = v_d.ride_id FOR UPDATE;
  PERFORM public._ops_allow(ARRAY[v_d.id, v_d.ride_id]);
  UPDATE public.ride_disputes
     SET status = 'resolved_driver', resolution = p_resolution, resolution_notes = v_notes,
         refund_amount_trc = 0, resolved_at = now()
   WHERE id = v_d.id;
  IF v_ride = 'disputed' THEN
    UPDATE public.rides SET status = 'completed' WHERE id = v_d.ride_id;
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me, 'dispute_resolved', 'ride_dispute', v_d.id::text, jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'resolved_driver', 'resolution', p_resolution, 'refund_amount_trc', 0), v_notes);

  PERFORM public._ops_notice_push('ops_resolve_dispute_without_refund', v_d.id, ARRAY[v_d.opened_by, v_d.respondent_id],
    'Disputa resuelta', 'Tu disputa ha sido resuelta. Revisa el resultado.', '{}'::jsonb);

  RETURN jsonb_build_object('success', true, 'status', 'resolved_driver');
END
$function$;

-- Propose a refund to an admin. The amount is capped at the ride's final fare, as
-- process_dispute_refund caps it.
CREATE OR REPLACE FUNCTION public.ops_escalate_dispute(p_dispute_id uuid, p_resolution text, p_suggested_trc integer,
                                                       p_expected_status text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_d      public.ride_disputes%ROWTYPE;
  v_fare   integer;
  v_id     uuid;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_resolution IS NULL OR p_resolution NOT IN ('full_refund', 'partial_refund', 'credit') THEN
    RETURN jsonb_build_object('error', 'invalid_resolution');
  END IF;
  IF p_suggested_trc IS NULL OR p_suggested_trc <= 0 THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF length(v_reason) > 1000 THEN
    RETURN jsonb_build_object('error', 'reason_too_long');
  END IF;

  SELECT * INTO v_d FROM public.ride_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'dispute_not_found');
  END IF;
  IF v_d.opened_by = v_me OR v_d.respondent_id = v_me OR public._ops_is_ride_party(v_d.ride_id) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_d.status IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'dispute_changed', 'status', v_d.status);
  END IF;
  IF v_d.status IN ('resolved_rider', 'resolved_driver', 'closed') THEN
    RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_d.status);
  END IF;
  IF EXISTS (SELECT 1 FROM public.ride_dispute_escalations e WHERE e.dispute_id = v_d.id AND e.status = 'pending') THEN
    RETURN jsonb_build_object('error', 'already_escalated');
  END IF;
  SELECT r.final_fare_trc INTO v_fare FROM public.rides r WHERE r.id = v_d.ride_id;
  IF p_suggested_trc > COALESCE(v_fare, 0) THEN
    RETURN jsonb_build_object('error', 'amount_exceeds_fare', 'max_trc', COALESCE(v_fare, 0));
  END IF;

  INSERT INTO public.ride_dispute_escalations (dispute_id, resolution, suggested_trc, reason, escalated_by)
  VALUES (v_d.id, p_resolution, p_suggested_trc, v_reason, v_me)
  RETURNING id INTO v_id;
  PERFORM public._ops_allow(ARRAY[v_d.id]);
  UPDATE public.ride_disputes SET status = 'escalated' WHERE id = v_d.id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me, 'dispute_escalated', 'ride_dispute', v_d.id::text, jsonb_build_object('status', v_d.status),
          jsonb_build_object('status', 'escalated', 'escalation_id', v_id, 'resolution', p_resolution,
                             'suggested_trc', p_suggested_trc), v_reason);

  RETURN jsonb_build_object('success', true, 'status', 'escalated', 'escalation_id', v_id);
END
$function$;

-- The admin's tap on a proposal: checks the amount the admin saw and pays it through the unchanged
-- process_dispute_refund (which checks the admin role, the fare cap and the dispute's status).
CREATE OR REPLACE FUNCTION public.admin_refund_escalated_dispute(p_escalation_id uuid, p_expected_trc integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me  uuid := auth.uid();
  v_e   public.ride_dispute_escalations%ROWTYPE;
  v_d   public.ride_disputes%ROWTYPE;
  v_txn uuid;
BEGIN
  IF v_me IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_e FROM public.ride_dispute_escalations WHERE id = p_escalation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'escalation_not_found');
  END IF;
  IF v_e.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'escalation_closed', 'status', v_e.status);
  END IF;
  IF v_e.suggested_trc IS DISTINCT FROM p_expected_trc THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'suggested_trc', v_e.suggested_trc);
  END IF;
  SELECT * INTO v_d FROM public.ride_disputes WHERE id = v_e.dispute_id;
  IF v_d.opened_by = v_me OR v_d.respondent_id = v_me OR public._ops_is_ride_party(v_d.ride_id) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;

  -- Marked first, so the closing trigger does not take it for an unpaid proposal.
  UPDATE public.ride_dispute_escalations SET status = 'refunded', resolved_by = v_me, resolved_at = now()
   WHERE id = v_e.id;
  v_txn := public.process_dispute_refund(v_e.dispute_id, v_me, v_e.suggested_trc, v_e.resolution, v_e.reason);
  UPDATE public.ride_dispute_escalations SET refund_transaction_id = v_txn WHERE id = v_e.id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values, reason)
  VALUES (v_me, 'dispute_escalation_refunded', 'ride_dispute', v_e.dispute_id::text,
          jsonb_build_object('escalation_id', v_e.id, 'refund_amount_trc', v_e.suggested_trc,
                             'resolution', v_e.resolution, 'refund_transaction_id', v_txn,
                             'escalated_by', v_e.escalated_by), v_e.reason);

  PERFORM public._ops_notice_push('admin_refund_escalated_dispute', v_e.dispute_id,
    ARRAY[v_d.opened_by, v_d.respondent_id],
    'Disputa resuelta', 'Tu disputa ha sido resuelta. Revisa el resultado.', '{}'::jsonb);

  RETURN jsonb_build_object('success', true, 'refund_transaction_id', v_txn);
END
$function$;

-- ── G. Moderation ───────────────────────────────────────────
-- Show or hide a review. trg_update_rating_avg recomputes the rating of the person it is about.
CREATE OR REPLACE FUNCTION public.ops_set_review_visibility(p_review_id uuid, p_visible boolean,
                                                            p_expected_visible boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_r  public.reviews%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_visible IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_request');
  END IF;

  SELECT * INTO v_r FROM public.reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'review_not_found');
  END IF;
  IF v_r.reviewer_id = v_me OR v_r.reviewee_id = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_r.is_visible IS DISTINCT FROM p_expected_visible THEN
    RETURN jsonb_build_object('error', 'review_changed', 'is_visible', v_r.is_visible);
  END IF;
  IF v_r.is_visible = p_visible THEN
    RETURN jsonb_build_object('success', true, 'is_visible', p_visible);
  END IF;

  UPDATE public.reviews SET is_visible = p_visible WHERE id = v_r.id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_me, CASE WHEN p_visible THEN 'show_review' ELSE 'hide_review' END, 'review', v_r.id::text,
          jsonb_build_object('is_visible', v_r.is_visible), jsonb_build_object('is_visible', p_visible));

  RETURN jsonb_build_object('success', true, 'is_visible', p_visible);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_resolve_fraud_alert(p_alert_id uuid, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me   uuid := auth.uid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_a    public.fraud_alerts%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_a FROM public.fraud_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'alert_not_found');
  END IF;
  IF v_a.user_id = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_a.resolved THEN
    RETURN jsonb_build_object('error', 'already_resolved');
  END IF;

  UPDATE public.fraud_alerts
     SET resolved = true, resolved_by = v_me, resolved_at = now(), resolution_note = v_note
   WHERE id = v_a.id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values, reason)
  VALUES (v_me, 'resolve_fraud_alert', 'fraud_alert', v_a.id::text,
          jsonb_build_object('alert_type', v_a.alert_type, 'user_id', v_a.user_id), v_note);

  RETURN jsonb_build_object('success', true);
END
$function$;

-- ── H. Push history ─────────────────────────────────────────
-- /notifications shows the history. send-push writes the operator's rows (it pushes one person).
DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_log'
                   AND policyname = 'notification_log_select_operator') THEN
    CREATE POLICY notification_log_select_operator ON public.notification_log
      FOR SELECT TO authenticated USING ((SELECT public.is_operator()));
  END IF;
END
$policy$;

-- ── Permissions ─────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._ops_notice_push(text, uuid, uuid[], text, text, jsonb),
                       public._ops_is_ride_party(uuid),
                       public.tg_ride_disputes_close_escalations()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ops_update_ticket(uuid, text, text),
                       public.ops_reply_ticket(uuid, text),
                       public.ops_update_incident(uuid, text, text, text, boolean),
                       public.ops_update_lost_item(uuid, text, text, text),
                       public.ops_update_dispute(uuid, text, text, text),
                       public.ops_resolve_dispute_without_refund(uuid, text, text, text),
                       public.ops_escalate_dispute(uuid, text, integer, text, text),
                       public.admin_refund_escalated_dispute(uuid, integer),
                       public.ops_set_review_visibility(uuid, boolean, boolean),
                       public.ops_resolve_fraud_alert(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_update_ticket(uuid, text, text),
                          public.ops_reply_ticket(uuid, text),
                          public.ops_update_incident(uuid, text, text, text, boolean),
                          public.ops_update_lost_item(uuid, text, text, text),
                          public.ops_update_dispute(uuid, text, text, text),
                          public.ops_resolve_dispute_without_refund(uuid, text, text, text),
                          public.ops_escalate_dispute(uuid, text, integer, text, text),
                          public.admin_refund_escalated_dispute(uuid, integer),
                          public.ops_set_review_visibility(uuid, boolean, boolean),
                          public.ops_resolve_fraud_alert(uuid, text)
  TO authenticated, service_role;

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.tg_ride_disputes_protect_columns()', 'public.tg_users_protect_admin_fields()',
    'public.admin_set_user_active(uuid,boolean,text)', 'public.detect_collusion_reviews()',
    'public.apply_collusion_sanction(uuid,text,text,uuid)', 'public.reverse_collusion_sanction(uuid,uuid)',
    'public._ops_notice_push(text,uuid,uuid[],text,text,jsonb)', 'public._ops_is_ride_party(uuid)',
    'public.ops_update_ticket(uuid,text,text)', 'public.ops_reply_ticket(uuid,text)',
    'public.ops_update_incident(uuid,text,text,text,boolean)', 'public.ops_update_lost_item(uuid,text,text,text)',
    'public.tg_ride_disputes_close_escalations()', 'public.ops_update_dispute(uuid,text,text,text)',
    'public.ops_resolve_dispute_without_refund(uuid,text,text,text)',
    'public.ops_escalate_dispute(uuid,text,integer,text,text)', 'public.admin_refund_escalated_dispute(uuid,integer)',
    'public.ops_set_review_visibility(uuid,boolean,boolean)', 'public.ops_resolve_fraud_alert(uuid,text)'
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
      ('public.tg_ride_disputes_protect_columns()'::regprocedure, '20b090fe5136655fc54707335566d88a'),
      ('public.tg_users_protect_admin_fields()', 'b7ce2ad1730bbcabae8bae6e612df802'),
      ('public.admin_set_user_active(uuid,boolean,text)', '7bdd11ba3b7f174b3ad84e838b81424e'),
      ('public.detect_collusion_reviews()', '88441adb2332ff5e779c8f151741b9ea'),
      ('public.apply_collusion_sanction(uuid,text,text,uuid)', 'e2a208cfbc682610089ec9b49f51e963'),
      ('public.reverse_collusion_sanction(uuid,uuid)', '82d3fca08a18b0f104efb1b8522dd8e5'),
      ('public._ops_notice_push(text,uuid,uuid[],text,text,jsonb)', '84e3327e29155deeac108cc6fd54ac6b'),
      ('public._ops_is_ride_party(uuid)', '8511443b949ae86d4c97959ef8d14f63'),
      ('public.ops_update_ticket(uuid,text,text)', '3e0f20ffb58b3a944e45754dfbbf54c5'),
      ('public.ops_reply_ticket(uuid,text)', 'd20d12828bc22e58cadc2445f6cc5af6'),
      ('public.ops_update_incident(uuid,text,text,text,boolean)', '6e76dd1b1a90847846915ccc94379e31'),
      ('public.ops_update_lost_item(uuid,text,text,text)', 'a7c1feb3b81ac4154ce9e7144af13ba9'),
      ('public.tg_ride_disputes_close_escalations()', 'b88f991c172074e1f95ce9c4e9c0287a'),
      ('public.ops_update_dispute(uuid,text,text,text)', '2e5d8314a4757d7ded10787366340ff4'),
      ('public.ops_resolve_dispute_without_refund(uuid,text,text,text)', 'e008abddb995cc28904279cd81e15d79'),
      ('public.ops_escalate_dispute(uuid,text,integer,text,text)', '159c6b8f3359205860f1c5404173b95d'),
      ('public.admin_refund_escalated_dispute(uuid,integer)', '8cc92ccd8cfca929768415f5c5f311b1'),
      ('public.ops_set_review_visibility(uuid,boolean,boolean)', '4c66d286d6cff31e30d8b6f1cafc50cf'),
      ('public.ops_resolve_fraud_alert(uuid,text)', '6e5b2cf8bbdce7329be64d247f2459df')
    ) AS f(fn, want)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got <> v_row.want THEN
      RAISE EXCEPTION '00673 check: % md5 is %', v_row.fn, v_row.got;
    END IF;
  END LOOP;

  -- Only these functions call the ops helpers or the operator checks: 00668's nineteen, 00671's
  -- eleven, 00672's thirteen and this migration's.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    ORDER BY p.proname) INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|_ops_target_refusal|_ops_user_push|_ops_notice_push|_ops_is_ride_party)\s*\('
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
      'ops_review_fleet_account', 'ops_review_fleet_member',
      -- 00673
      'tg_ride_disputes_protect_columns', 'admin_set_user_active', 'detect_collusion_reviews',
      'apply_collusion_sanction', 'reverse_collusion_sanction', '_ops_notice_push', '_ops_is_ride_party',
      'ops_update_ticket', 'ops_reply_ticket', 'ops_update_incident', 'ops_update_lost_item',
      'ops_update_dispute', 'ops_resolve_dispute_without_refund', 'ops_escalate_dispute',
      'admin_refund_escalated_dispute', 'ops_set_review_visibility', 'ops_resolve_fraud_alert');
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00673 check: other functions call the ops checks: %', v_set;
  END IF;

  -- Money and roles stay admin-only. The escalated refund joins the list: an admin pays it.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('admin_adjust_wallet', 'admin_send_gift', 'admin_reverse_gift', 'freeze_wallet',
                      'unfreeze_wallet', 'approve_wallet_recharge', 'process_dispute_refund',
                      'admin_refund_ride_commission', 'admin_reward_referral', 'admin_invalidate_referral',
                      'set_referral_amounts', 'admin_send_wallet_v2_bonus_push', 'get_platform_earnings',
                      'promote_user_role', 'admin_set_user_level', 'admin_refund_escalated_dispute')
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|_ops_target_refusal|''operator'')';
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00673 check: a money or role function names the operator: %', v_set;
  END IF;

  -- Each ops function: SECURITY DEFINER, out of anon's reach, open to authenticated, and it logs.
  FOR v_row IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.prosrc FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND (p.proname LIKE 'ops\_%' OR p.proname = 'admin_refund_escalated_dispute')
  LOOP
    IF NOT v_row.prosecdef
       OR has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_row.fn, 'EXECUTE')
       OR position('INSERT INTO public.admin_actions' IN v_row.prosrc) = 0 THEN
      RAISE EXCEPTION '00673 check: % is not a proper ops function', v_row.fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'ops\_%') <> 15 THEN
    RAISE EXCEPTION '00673 check: expected fifteen ops functions';
  END IF;

  -- The helpers stay the owner's.
  IF has_function_privilege('authenticated', 'public._ops_notice_push(text,uuid,uuid[],text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._ops_notice_push(text,uuid,uuid[],text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._ops_is_ride_party(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._ops_is_ride_party(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00673 check: the helpers are open to clients';
  END IF;

  -- The proposals: RLS on, read only by operations staff, written only by the functions.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ride_dispute_escalations'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ride_dispute_escalations') <> 1
     OR has_table_privilege('anon', 'public.ride_dispute_escalations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ride_dispute_escalations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ride_dispute_escalations', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.ride_dispute_escalations', 'INSERT') THEN
    RAISE EXCEPTION '00673 check: ride_dispute_escalations is not locked down';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_log'
                   AND policyname = 'notification_log_select_operator' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION '00673 check: the operator cannot read the push history';
  END IF;
END
$check$;
