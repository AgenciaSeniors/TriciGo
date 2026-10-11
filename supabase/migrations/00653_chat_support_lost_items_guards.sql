-- ============================================================
-- 00653 — chat, support, lost items and incident reports: what a client may write
--
-- Measured in prod on 2026-10-11 as real accounts, inside rolled-back blocks:
--   * ride_messages: rm_insert only checks that the sender is a party of the
--     ride, in any status. Days after a ride ended, the rider and the driver
--     could still message each other, and every message went out as a push
--     titled with the sender's name (notify_new_chat_message). The driver
--     cannot even read them: rm_select limits drivers to the active window
--     (00295).
--   * lost_items: lost_items_insert only checks reporter_id = auth.uid(). A
--     stranger filed a report on someone else's ride naming its driver (a push
--     to that driver, and the stranger's text in their app), then rewrote it:
--     lost_items_update lets the reporter or the driver change every column
--     (status, driver_id, admin_notes, resolved_by, return_fee_cup).
--   * ticket_messages: a user posted on their own ticket with is_admin = true,
--     which the apps and the panel show as a reply from support.
--   * support_tickets: a ticket could be born resolved, urgent and assigned.
--   * incident_reports: a stranger filed a report on someone else's ride
--     against its driver, born resolved with resolved_by set. An SOS with a
--     foreign ride_id made notify_trusted_contacts_on_sos text that ride's
--     tracking link to the reporter's own trusted contacts.
--
-- The rule, enforced by BEFORE triggers on writes by clients (current_user
-- anon or authenticated) that are not platform admins. Writes from SECURITY
-- DEFINER functions (report_review, settle_and_scrub_for_deletion), cron and
-- the service role run as the function owner and are not touched:
--   * chat: only while the ride is in progress (accepted … arrived_at_destination),
--     1 to 1000 characters; created_at is the server's and read_at starts empty.
--   * lost items: filed by the ride's customer, on a ride with a driver, at most
--     5 per ride; driver_id comes from the ride; the case starts 'reported' with
--     every driver/admin field empty. Afterwards the driver may answer
--     (found / not_found), arrange the return and mark it returned (stamping
--     resolved_by = self, resolved_at = now()); the reporter may edit the
--     description, category and photos while it is still 'reported'. Anything
--     else is rejected.
--   * support: a ticket starts open/normal/unassigned and can only point at one
--     of the caller's rides; a message from a non-admin is never is_admin.
--   * incidents: start open with no resolution and no review_id; severity is
--     critical for an SOS and medium otherwise; the ride must be one of the
--     caller's and against_user_id the other party. An SOS is never rejected:
--     a foreign ride_id or a wrong against_user_id is dropped instead.
--
-- Errors carry a Spanish MESSAGE and a code in DETAIL. No table, policy or grant
-- is created or dropped. Rehearsal: supabase/tests/00653/run.sh.
-- ============================================================

-- The caller's side of a ride: their role, the ride status and the other
-- party's user id. Empty when the caller is not a party, so it reveals nothing
-- about other people's rides.
CREATE OR REPLACE FUNCTION public._ride_context_for_caller(p_ride_id uuid)
RETURNS TABLE (caller_role text, ride_status public.ride_status, other_user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN r.customer_id = auth.uid() THEN 'customer' ELSE 'driver' END,
         r.status,
         CASE WHEN r.customer_id = auth.uid() THEN dp.user_id ELSE r.customer_id END
  FROM public.rides r
  LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id
    AND auth.uid() IS NOT NULL
    AND (r.customer_id = auth.uid() OR dp.user_id = auth.uid());
$$;

REVOKE ALL ON FUNCTION public._ride_context_for_caller(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._ride_context_for_caller(uuid) TO authenticated, service_role;

-- ── ride_messages ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_ride_messages_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ctx record;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ctx FROM public._ride_context_for_caller(NEW.ride_id);
  IF NOT FOUND OR v_ctx.ride_status NOT IN
       ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'El chat de este viaje ya está cerrado.',
      DETAIL = 'chat_closed';
  END IF;

  IF NEW.body IS NULL OR char_length(btrim(NEW.body)) = 0 OR char_length(NEW.body) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'El mensaje debe tener entre 1 y 1000 caracteres.',
      DETAIL = 'chat_message_length';
  END IF;

  NEW.created_at := now();
  NEW.read_at := NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_ride_messages_client_guard
  BEFORE INSERT ON public.ride_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_messages_client_guard();

-- ── lost_items ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_lost_items_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
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
$$;

CREATE OR REPLACE TRIGGER trg_lost_items_client_guard
  BEFORE INSERT OR UPDATE ON public.lost_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_lost_items_client_guard();

-- ── support_tickets ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_support_tickets_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
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
$$;

CREATE OR REPLACE TRIGGER trg_support_tickets_client_guard
  BEFORE INSERT ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_client_guard();

-- ── ticket_messages ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_ticket_messages_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  NEW.is_admin := false;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_ticket_messages_client_guard
  BEFORE INSERT ON public.ticket_messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_ticket_messages_client_guard();

-- ── incident_reports ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_incident_reports_client_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
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
$$;

CREATE OR REPLACE TRIGGER trg_incident_reports_client_guard
  BEFORE INSERT ON public.incident_reports
  FOR EACH ROW EXECUTE FUNCTION public.tg_incident_reports_client_guard();

-- Trigger functions are not meant to be called directly.
REVOKE ALL ON FUNCTION public.tg_ride_messages_client_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_lost_items_client_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_support_tickets_client_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_ticket_messages_client_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_incident_reports_client_guard() FROM PUBLIC, anon, authenticated;

-- ── verification ─────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t.tg, ', ') INTO v_missing
    FROM (VALUES ('ride_messages', 'trg_ride_messages_client_guard'),
                 ('lost_items', 'trg_lost_items_client_guard'),
                 ('support_tickets', 'trg_support_tickets_client_guard'),
                 ('ticket_messages', 'trg_ticket_messages_client_guard'),
                 ('incident_reports', 'trg_incident_reports_client_guard')) AS t(tbl, tg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = ('public.' || t.tbl)::regclass
                        AND g.tgname = t.tg AND g.tgenabled = 'O' AND NOT g.tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '00653: triggers missing or disabled: %', v_missing;
  END IF;

  IF has_function_privilege('anon', 'public._ride_context_for_caller(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00653: anon can execute _ride_context_for_caller';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public._ride_context_for_caller(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00653: authenticated cannot execute _ride_context_for_caller (the guards call it)';
  END IF;
END
$verify$;
