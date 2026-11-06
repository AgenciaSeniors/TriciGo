-- ============================================================
-- 00676 — fleet invitations: the database tells people what happened
--
-- WHY
--   Inviting a driver only reserved a phone in fleet_members: nobody heard anything, neither the
--   driver nor the owner, although the app promises a notice. An owner could also not resend an
--   invitation, and a driver linked to a fleet could not leave it. Prod has 0 fleets, so nobody was
--   hit. The notices are born in the database, on fleet_members and corporate_accounts, so they work
--   whichever path approved: the panel, a direct write, or a link at signup.
--
-- WHAT
--   fleet_invite_sends         who was contacted, by which channel and why. The owner reads it.
--   _fleet_announce_member     the first contact with an invited driver, and the only sender.
--   resend_fleet_invite        the owner sends the SMS again, within the limits below.
--   leave_fleet                a driver leaves a fleet.
--   get_my_fleet_memberships   the fleets a driver is in. SECURITY DEFINER on purpose: a policy on
--                              driver_fleets that read fleet_members would recurse (42P17, see 00675).
--   tg_fleet_members_notify, tg_corporate_accounts_fleet_notify   the notices, AFTER the write.
--
-- RULES
--   * A first contact goes out only with the company approved and the invitation approved. An
--     approved driver gets a push; anyone else gets an SMS, a passenger already linked included,
--     because that person still has to install the driver app. pending_signup counts as approved
--     everywhere, as in the three linking paths.
--   * Exactly one first contact, whichever side is approved first, and also when both are approved
--     at once: see _fleet_announce_member.
--   * SMS: once per (fleet_id, phone), so deleting an invitation and adding the number again resets
--     nothing. 24 hours between sends, 3 sends per number and fleet, 30 resends per owner and day, 200
--     SMS a day in total, Cuban mobiles only. Push: once per invitation row, because a driver who left
--     and is invited again is relinked at approval and has to hear about it. A push costs nothing and
--     every new row passes a human review.
--   * A send row is written in the same block as its HTTP call, so an SMS call that raises leaves no
--     row and the owner can resend at once. A provider failure after the call (send-sms answers 200
--     with success false) counts as sent: sms_log is where that shows. _ops_user_push catches the
--     failure of its own call and logs push_failed, so a push row stays even then: a push has no
--     resend, and the driver sees the fleet in the app anyway.
--   * Neither the SMS nor a push to the driver carries text the owner typed: no fleet name, no company
--     name, only the owner's reduced name (_third_party_person_name). A push to the owner may use the
--     driver_name that owner typed.
--   * A notice never fails the write that fired it. A link can run inside GoTrue's transaction, where
--     a failure breaks the phone login. WHEN OTHERS logs to rpc_attempt_log, and lock_timeout turns a
--     lock wait into an error it can catch: it does not catch query_canceled.
--
-- The SMS goes through cron_http_post, labelled fleet-invite-sms. The pushes go through _ops_user_push
-- (00672), which sends no category, so data.type = 'fleet_update' survives to the apps.
-- The self-checks of 00672 to 00674 list the callers of _ops_user_push: re-running one of those files
-- now aborts, as re-running 00673 already did after 00674.
-- Rehearsal: supabase/tests/00676/run.sh.
-- ============================================================

SET lock_timeout = '5s';

-- ── 1. Who was contacted ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fleet_invite_sends (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fleet_id  uuid NOT NULL REFERENCES public.driver_fleets(id) ON DELETE CASCADE,
  phone     text NOT NULL,
  -- No foreign key: the row has to outlive the invitation, or deleting it would reset the limits.
  member_id uuid NOT NULL,
  channel   text NOT NULL CHECK (channel IN ('sms', 'push')),
  source    text NOT NULL CHECK (source IN ('review', 'resend')),
  sent_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fleet_invite_sends IS
  'One row per invitation sent to a driver (00676). phone is normalized. An SMS is limited per (fleet_id, phone) and a push per member_id, so deleting an invitation resets no limit. Only _fleet_announce_member writes it.';

-- What makes a first contact atomic: the insert that wins is the one that sends.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invite_sends_first_sms_key
  ON public.fleet_invite_sends (fleet_id, phone) WHERE channel = 'sms' AND source = 'review';
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invite_sends_first_push_key
  ON public.fleet_invite_sends (member_id) WHERE channel = 'push';
CREATE INDEX IF NOT EXISTS fleet_invite_sends_fleet_phone_idx
  ON public.fleet_invite_sends (fleet_id, phone, sent_at);
CREATE INDEX IF NOT EXISTS fleet_invite_sends_sms_sent_at_idx
  ON public.fleet_invite_sends (sent_at) WHERE channel = 'sms';

ALTER TABLE public.fleet_invite_sends ENABLE ROW LEVEL SECURITY;

DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'fleet_invite_sends'
                   AND policyname = 'fleet_invite_sends_owner_select') THEN
    CREATE POLICY fleet_invite_sends_owner_select ON public.fleet_invite_sends
      FOR SELECT TO authenticated
      USING (fleet_id IN (
        SELECT df.id
        FROM public.driver_fleets df
        JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
        WHERE ca.created_by = (SELECT auth.uid())
      ));
  END IF;
END
$policy$;

-- pg_default_acl still opens every new table of public to the API roles.
REVOKE ALL ON public.fleet_invite_sends FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fleet_invite_sends TO authenticated;
GRANT ALL ON public.fleet_invite_sends TO service_role;

-- ── 2. The text of the SMS ───────────────────────────────────
-- One GSM-7 part. The SMS goes out with GSM-7 coding, so a letter outside GSM-7 would arrive mangled:
-- the owner's name loses its accents (ñ stays, GSM-7 has it), and whatever is left outside the set
-- falls back to the text with no name. The fixed text with a name is 136 characters and the name at
-- most 23.
CREATE OR REPLACE FUNCTION public._fleet_invite_sms_text(p_owner_name text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_name text := public._third_party_person_name(
    translate(COALESCE(p_owner_name, ''),
              'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÝýÿÇç',
              'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuYyyCc'));
BEGIN
  IF v_name IS NULL OR v_name !~ '^[A-Za-zÑñ''. -]+$' THEN
    RETURN 'TriciGo: una flota te espera como conductor. Baja la app TriciGo Conductor y entra con este teléfono: https://tricigo.com/conductores';
  END IF;
  RETURN 'TriciGo: ' || v_name || ' te espera en su flota de conductores. Baja la app TriciGo Conductor y entra con este teléfono: https://tricigo.com/conductores';
END
$function$;

-- ── 3. A push that cannot raise ──────────────────────────────
-- For the notices that come after the write. Raising here would roll back the block around it, and
-- with it a first contact already queued.
CREATE OR REPLACE FUNCTION public._fleet_push(p_user_id uuid, p_target uuid, p_event text,
                                              p_title text, p_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
BEGIN
  PERFORM public._ops_user_push('_fleet_push', p_target, p_user_id, p_title, p_body,
    jsonb_build_object('type', 'fleet_update', 'event', p_event));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '_fleet_push(%, %): % %', p_user_id, p_event, SQLSTATE, SQLERRM;
  PERFORM public.log_rpc_attempt('_fleet_push', NULL, p_target, 'push_failed',
    jsonb_build_object('user_id', p_user_id, 'event', p_event, 'sqlstate', SQLSTATE, 'error', SQLERRM));
END
$function$;

-- ── 4. The first contact ─────────────────────────────────────
-- Approving the driver and approving the company can run at once, and under READ COMMITTED neither
-- sees the other: the driver's side could read the company as pending while the company's side reads
-- the driver as in review, and nobody would announce. So this reads the company row FOR SHARE. If its
-- review is in flight it waits, and then sees the new status. If the share lock comes first, it is
-- the review that waits, and its trigger then finds this invitation approved. The company's side
-- reads the invitations with no row lock, so the two sides cannot deadlock. If a review holds the row
-- past lock_timeout, nothing goes out, it is logged, and the owner's resend recovers it.
-- The SMS sends gsm7: true, the caller's word that the text fits GSM-7, so send-sms codes it as text
-- and it goes out as one part. A send-sms not redeployed yet ignores the field and the SMS still
-- arrives, in UCS-2 and in more parts, so this migration and that deploy can go in either order.
-- Returns what happened, for the caller and the tests. It never raises.
CREATE OR REPLACE FUNCTION public._fleet_announce_member(p_member_id uuid, p_source text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  c_daily_sms CONSTANT integer := 200;
  v_fleet   uuid;
  v_account uuid;
  v_driver  uuid;
  v_status  text;
  v_phone   text;
  v_company text;
  v_owner   uuid;
  v_name    text;
  v_person  text;
  v_key     text;
  v_send    bigint;
BEGIN
  SELECT fm.fleet_id, df.corporate_account_id, fm.driver_id, fm.status,
         public._normalize_cuban_phone(fm.driver_phone)
    INTO v_fleet, v_account, v_driver, v_status, v_phone
  FROM public.fleet_members fm
  JOIN public.driver_fleets df ON df.id = fm.fleet_id
  WHERE fm.id = p_member_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT ca.status, ca.created_by INTO v_company, v_owner
  FROM public.corporate_accounts ca
  WHERE ca.id = v_account
  FOR SHARE;
  IF v_company IS DISTINCT FROM 'approved' THEN
    RETURN 'company_not_approved';
  END IF;
  IF v_status NOT IN ('approved', 'pending_signup', 'active') THEN
    RETURN 'not_invitable';
  END IF;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    PERFORM public.log_rpc_attempt('_fleet_announce_member', NULL, p_member_id, 'no_service_key',
      jsonb_build_object('source', p_source));
    RETURN 'no_service_key';
  END IF;

  SELECT u.full_name INTO v_name FROM public.users u WHERE u.id = v_owner;

  IF v_driver IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.driver_profiles dp
       WHERE dp.user_id = v_driver AND dp.status = 'approved') THEN
    INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    VALUES (v_fleet, v_phone, p_member_id, 'push', p_source)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_send;
    IF v_send IS NULL THEN
      RETURN 'already_contacted';
    END IF;
    v_person := public._third_party_person_name(v_name);
    PERFORM public._ops_user_push('_fleet_announce_member', p_member_id, v_driver,
      'Te agregaron a una flota',
      CASE WHEN v_person IS NULL THEN 'Ahora eres parte de una flota.'
           ELSE v_person || ' te agregó a su flota.' END
        || ' Si no quieres estar en ella, puedes salir desde Corporativo.',
      jsonb_build_object('type', 'fleet_update', 'event', 'added_to_fleet'));
    RETURN 'sent_push';
  END IF;

  IF v_phone !~ '^[+]53[56][0-9]{7}$' THEN
    RETURN 'not_cuban_mobile';
  END IF;
  IF p_source = 'review' AND EXISTS (
       SELECT 1 FROM public.fleet_invite_sends s
       WHERE s.fleet_id = v_fleet AND s.phone = v_phone AND s.channel = 'sms') THEN
    RETURN 'already_contacted';
  END IF;
  IF (SELECT count(*) FROM public.fleet_invite_sends s
      WHERE s.channel = 'sms' AND s.sent_at > now() - interval '1 day') >= c_daily_sms THEN
    PERFORM public.log_rpc_attempt('_fleet_announce_member', NULL, p_member_id, 'daily_cap',
      jsonb_build_object('source', p_source));
    RETURN 'daily_cap';
  END IF;

  INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
  VALUES (v_fleet, v_phone, p_member_id, 'sms', p_source)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_send;
  IF v_send IS NULL THEN
    RETURN 'already_contacted';
  END IF;
  PERFORM public.cron_http_post('fleet-invite-sms',
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
    body    := jsonb_build_object('phone', v_phone, 'body', public._fleet_invite_sms_text(v_name),
                                  'user_id', v_driver, 'event_type', 'fleet_invite', 'gsm7', true));
  RETURN 'sent_sms';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '_fleet_announce_member(%): % %', p_member_id, SQLSTATE, SQLERRM;
  PERFORM public.log_rpc_attempt('_fleet_announce_member', NULL, p_member_id, 'announce_failed',
    jsonb_build_object('source', p_source, 'sqlstate', SQLSTATE, 'error', SQLERRM));
  RETURN 'failed';
END
$function$;

-- ── 5. The owner sends it again ──────────────────────────────
-- For an invitation approved and not linked. A first contact that never went out (a failed call, the
-- daily cap) has no row, so nothing holds this one back.
CREATE OR REPLACE FUNCTION public.resend_fleet_invite(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_gap       CONSTANT interval := interval '24 hours';
  c_per_phone CONSTANT integer := 3;
  c_per_owner CONSTANT integer := 30;
  v_me      uuid := auth.uid();
  v_owner   uuid;
  v_company text;
  v_fleet   uuid;
  v_driver  uuid;
  v_status  text;
  v_phone   text;
  v_sends   integer;
  v_last    timestamptz;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  -- The fleet row lines up two taps on the button, and two spellings of one number, so the limits
  -- below read what the other call sent. NO KEY: it must not block the inserts that reference it.
  SELECT ca.created_by, ca.status, fm.fleet_id, fm.driver_id, fm.status,
         public._normalize_cuban_phone(fm.driver_phone)
    INTO v_owner, v_company, v_fleet, v_driver, v_status, v_phone
  FROM public.fleet_members fm
  JOIN public.driver_fleets df ON df.id = fm.fleet_id
  JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
  WHERE fm.id = p_member_id
  FOR NO KEY UPDATE OF df;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_owner IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_company IS DISTINCT FROM 'approved' OR v_driver IS NOT NULL
     OR v_status NOT IN ('approved', 'pending_signup') THEN
    RETURN jsonb_build_object('error', 'not_invitable');
  END IF;

  SELECT count(*), max(s.sent_at) INTO v_sends, v_last
  FROM public.fleet_invite_sends s
  WHERE s.fleet_id = v_fleet AND s.phone = v_phone AND s.channel = 'sms';
  IF v_sends >= c_per_phone THEN
    RETURN jsonb_build_object('error', 'limit_reached');
  END IF;
  IF v_last > now() - c_gap THEN
    RETURN jsonb_build_object('error', 'too_soon', 'retry_at', v_last + c_gap);
  END IF;
  IF (SELECT count(*)
      FROM public.fleet_invite_sends s
      JOIN public.driver_fleets df ON df.id = s.fleet_id
      JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
      WHERE ca.created_by = v_me AND s.source = 'resend'
        AND s.sent_at > now() - interval '1 day') >= c_per_owner THEN
    RETURN jsonb_build_object('error', 'limit_reached');
  END IF;

  RETURN CASE public._fleet_announce_member(p_member_id, 'resend')
    WHEN 'sent_sms'         THEN jsonb_build_object('success', true)
    WHEN 'daily_cap'        THEN jsonb_build_object('error', 'limit_reached')
    WHEN 'not_cuban_mobile' THEN jsonb_build_object('error', 'not_invitable')
    ELSE jsonb_build_object('error', 'send_failed')
  END;
END
$function$;

-- ── 6. A driver leaves ───────────────────────────────────────
-- tg_fleet_members_protect keeps status from a client, so this goes through its trusted flag, set
-- around the update and put back right after: the protection stays on for the rest of the transaction.
-- A second tap finds the row inactive and is no error.
CREATE OR REPLACE FUNCTION public.leave_fleet(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me      uuid := auth.uid();
  v_driver  uuid;
  v_status  text;
  v_trusted text;
BEGIN
  IF v_me IS NULL THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT fm.driver_id, fm.status INTO v_driver, v_status
  FROM public.fleet_members fm
  WHERE fm.id = p_member_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_driver IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_status = 'inactive' THEN
    RETURN jsonb_build_object('success', true);
  END IF;
  IF v_status NOT IN ('active', 'approved', 'pending_signup') THEN
    RETURN jsonb_build_object('error', 'not_active');
  END IF;

  v_trusted := current_setting('app.trusted_fleet_update', true);
  PERFORM set_config('app.trusted_fleet_update', '1', true);
  UPDATE public.fleet_members SET status = 'inactive' WHERE id = p_member_id;
  PERFORM set_config('app.trusted_fleet_update', COALESCE(v_trusted, ''), true);

  RETURN jsonb_build_object('success', true);
END
$function$;

-- ── 7. The fleets a driver is in ─────────────────────────────
-- One row per fleet, as fleetService.getMembershipsForDriver: one fleet can hold a number twice in two
-- spellings. A fleet shows through its active row, else its latest signup, and active fleets go first.
CREATE OR REPLACE FUNCTION public.get_my_fleet_memberships()
 RETURNS TABLE(member_id uuid, fleet_id uuid, fleet_name text, owner_label text, status text,
               driver_name text, driver_phone text, signed_up_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT m.member_id, m.fleet_id, m.fleet_name, m.owner_label, m.status,
         m.driver_name, m.driver_phone, m.signed_up_at
  FROM (
    SELECT DISTINCT ON (fm.fleet_id)
           fm.id AS member_id, fm.fleet_id, df.name AS fleet_name,
           COALESCE(public._third_party_person_name(u.full_name), ca.name) AS owner_label,
           fm.status, fm.driver_name, fm.driver_phone, fm.signed_up_at, fm.added_at
    FROM public.fleet_members fm
    JOIN public.driver_fleets df ON df.id = fm.fleet_id
    JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
    LEFT JOIN public.users u ON u.id = ca.created_by
    WHERE fm.driver_id = auth.uid()
      AND fm.status IN ('active', 'approved', 'pending_signup')
    ORDER BY fm.fleet_id, (fm.status = 'active') DESC, fm.signed_up_at DESC NULLS LAST,
             fm.added_at DESC, fm.id
  ) m
  ORDER BY (m.status = 'active') DESC, m.signed_up_at DESC NULLS LAST, m.added_at DESC, m.member_id;
$function$;

-- ── 8. The notices ───────────────────────────────────────────
-- The first contact goes last: _fleet_push cannot raise, so nothing can roll back what it queued.
CREATE OR REPLACE FUNCTION public.tg_fleet_members_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_owner  uuid;
  v_person text;
BEGIN
  BEGIN
    SELECT ca.created_by, public._third_party_person_name(u.full_name)
      INTO v_owner, v_person
    FROM public.driver_fleets df
    JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
    LEFT JOIN public.users u ON u.id = ca.created_by
    WHERE df.id = OLD.fleet_id;

    IF TG_OP = 'DELETE' THEN
      PERFORM public._fleet_push(OLD.driver_id, OLD.id, 'removed_from_fleet', 'Ya no estás en una flota',
        CASE WHEN v_person IS NULL THEN 'Te quitaron de una flota.'
             ELSE v_person || ' te quitó de su flota.' END);
      RETURN NULL;
    END IF;

    IF NEW.status = 'rejected' AND OLD.status <> 'rejected' THEN
      PERFORM public._fleet_push(v_owner, NEW.id, 'member_rejected', 'Conductor no aprobado',
        'TriciGo no aprobó a ' || NEW.driver_name || '. Abre la app para ver el motivo.');
    END IF;
    IF NEW.driver_id IS NOT NULL AND OLD.driver_id IS NULL THEN
      PERFORM public._fleet_push(v_owner, NEW.id, 'member_linked', 'Conductor vinculado',
        NEW.driver_name || ' ya está en tu flota.');
    END IF;
    IF NEW.status = 'inactive' AND OLD.status <> 'inactive' AND OLD.driver_id IS NOT NULL THEN
      PERFORM public._fleet_push(v_owner, NEW.id, 'member_left', 'Un conductor salió de tu flota',
        NEW.driver_name || ' ya no está en tu flota.');
    END IF;

    -- Only when the review lets the row in. approved -> active is the link, not a first contact.
    IF NEW.status IN ('approved', 'pending_signup', 'active')
       AND OLD.status NOT IN ('approved', 'pending_signup', 'active') THEN
      PERFORM public._fleet_announce_member(NEW.id, 'review');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_fleet_members_notify(%): % %', OLD.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('tg_fleet_members_notify', NULL, OLD.id, 'notify_failed',
      jsonb_build_object('op', TG_OP, 'sqlstate', SQLSTATE, 'error', SQLERRM));
  END;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_fleet_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_fleet  uuid;
  v_member uuid;
BEGIN
  BEGIN
    SELECT df.id INTO v_fleet FROM public.driver_fleets df WHERE df.corporate_account_id = NEW.id;
    IF NOT FOUND THEN
      RETURN NULL;   -- a corporate client, not a fleet
    END IF;

    IF NEW.status = 'approved' THEN
      PERFORM public._fleet_push(NEW.created_by, NEW.id, 'fleet_approved', 'Tu flota fue aprobada',
        'Ya puedes ver a tus conductores y agregar más desde la app.');
      -- No lock on these rows, see _fleet_announce_member. An invitation whose approval has not
      -- committed is not read here: its own trigger is the one waiting for this company.
      FOR v_member IN
        SELECT fm.id FROM public.fleet_members fm
        WHERE fm.fleet_id = v_fleet AND fm.status IN ('approved', 'pending_signup', 'active')
        ORDER BY fm.added_at, fm.id
      LOOP
        PERFORM public._fleet_announce_member(v_member, 'review');
      END LOOP;
    ELSIF NEW.status = 'rejected' THEN
      PERFORM public._fleet_push(NEW.created_by, NEW.id, 'fleet_rejected', 'Tu flota no fue aprobada',
        'Abre la app para ver el motivo.');
    ELSIF NEW.status = 'suspended' THEN
      PERFORM public._fleet_push(NEW.created_by, NEW.id, 'fleet_suspended', 'Tu flota fue suspendida',
        'Abre la app para ver el motivo.');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_corporate_accounts_fleet_notify(%): % %', NEW.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('tg_corporate_accounts_fleet_notify', NULL, NEW.id, 'notify_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;
  RETURN NULL;
END
$function$;

-- AFTER UPDATE with WHEN, never UPDATE OF driver_id: the BEFORE trigger that links a row changes a
-- column the UPDATE does not name, and that does not fire a trigger by column. WHEN cannot name NEW in
-- a DELETE, so that one has its own trigger, and only an active driver has anything to be told.
CREATE OR REPLACE TRIGGER trg_fleet_members_notify
  AFTER UPDATE ON public.fleet_members
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.driver_id IS DISTINCT FROM NEW.driver_id)
  EXECUTE FUNCTION public.tg_fleet_members_notify();

CREATE OR REPLACE TRIGGER trg_fleet_members_notify_delete
  AFTER DELETE ON public.fleet_members
  FOR EACH ROW
  WHEN (OLD.status = 'active')
  EXECUTE FUNCTION public.tg_fleet_members_notify();

CREATE OR REPLACE TRIGGER trg_corporate_accounts_fleet_notify
  AFTER UPDATE ON public.corporate_accounts
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.tg_corporate_accounts_fleet_notify();

-- ── 9. Permissions ───────────────────────────────────────────
REVOKE ALL ON FUNCTION public._fleet_invite_sms_text(text),
                       public._fleet_push(uuid, uuid, text, text, text),
                       public._fleet_announce_member(uuid, text),
                       public.tg_fleet_members_notify(),
                       public.tg_corporate_accounts_fleet_notify()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resend_fleet_invite(uuid),
                       public.leave_fleet(uuid),
                       public.get_my_fleet_memberships()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resend_fleet_invite(uuid),
                          public.leave_fleet(uuid),
                          public.get_my_fleet_memberships()
  TO authenticated, service_role;

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._fleet_invite_sms_text(text)', 'public._fleet_push(uuid,uuid,text,text,text)',
    'public._fleet_announce_member(uuid,text)', 'public.resend_fleet_invite(uuid)',
    'public.leave_fleet(uuid)', 'public.get_my_fleet_memberships()',
    'public.tg_fleet_members_notify()', 'public.tg_corporate_accounts_fleet_notify()'
  ]::regprocedure[] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── 10. Checks ───────────────────────────────────────────────
DO $check$
DECLARE
  v_row record;
BEGIN
  -- The bodies are the ones the rehearsal ran.
  FOR v_row IN
    SELECT f.fn, f.want, md5(p.prosrc) AS got
    FROM (VALUES
      ('public._fleet_invite_sms_text(text)'::regprocedure, '617ee8832f32dc04e2f3cc3923edc75f'),
      ('public._fleet_push(uuid,uuid,text,text,text)', 'd4878b8bb0eb0e4fe7d5e0c0b55ecf2b'),
      ('public._fleet_announce_member(uuid,text)', 'a453645e5f419e736e4c552e5ae50c4e'),
      ('public.resend_fleet_invite(uuid)', '1ad9632095eb6a0779166435c7c7d671'),
      ('public.leave_fleet(uuid)', '0bb9f0a8ff7265e7c5df006fc34b0b60'),
      ('public.get_my_fleet_memberships()', '30221e4c16b5494442a3f281e584d45a'),
      ('public.tg_fleet_members_notify()', '97b0d70bb190e47b7aa0c018462cde44'),
      ('public.tg_corporate_accounts_fleet_notify()', 'd6ef2ad105cdf235f1651edafcb1ffd4')
    ) AS f(fn, want)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got <> v_row.want THEN
      RAISE EXCEPTION '00676 check: % md5 is %', v_row.fn, v_row.got;
    END IF;
  END LOOP;

  -- Who can call what. Everything is out of anon's reach, and only three functions are for clients.
  FOR v_row IN
    SELECT f.fn, f.open
    FROM (VALUES
      ('public.resend_fleet_invite(uuid)'::regprocedure, true),
      ('public.leave_fleet(uuid)', true),
      ('public.get_my_fleet_memberships()', true),
      ('public._fleet_invite_sms_text(text)', false),
      ('public._fleet_push(uuid,uuid,text,text,text)', false),
      ('public._fleet_announce_member(uuid,text)', false),
      ('public.tg_fleet_members_notify()', false),
      ('public.tg_corporate_accounts_fleet_notify()', false)
    ) AS f(fn, open)
  LOOP
    IF has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_row.fn, 'EXECUTE') <> v_row.open
       OR has_function_privilege('service_role', v_row.fn, 'EXECUTE') <> v_row.open THEN
      RAISE EXCEPTION '00676 check: % has the wrong callers', v_row.fn;
    END IF;
  END LOOP;

  -- What prosrc does not hold: they run as their owner, and a notice bounds its lock waits.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid IN ('public._fleet_push(uuid,uuid,text,text,text)'::regprocedure,
                    'public._fleet_announce_member(uuid,text)'::regprocedure,
                    'public.tg_fleet_members_notify()'::regprocedure,
                    'public.tg_corporate_accounts_fleet_notify()'::regprocedure)
      AND (NOT p.prosecdef OR NOT 'lock_timeout=2s' = ANY (COALESCE(p.proconfig, '{}')))
  ) THEN
    RAISE EXCEPTION '00676 check: a notice is not SECURITY DEFINER with a lock_timeout';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.oid IN ('public.resend_fleet_invite(uuid)'::regprocedure, 'public.leave_fleet(uuid)'::regprocedure,
                    'public.get_my_fleet_memberships()'::regprocedure)
      AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION '00676 check: a client function is not SECURITY DEFINER';
  END IF;

  -- The table: closed but for the owner's read, and the two keys that make a first contact atomic.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.fleet_invite_sends'::regclass) THEN
    RAISE EXCEPTION '00676 check: fleet_invite_sends has RLS off';
  END IF;
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'fleet_invite_sends'
        AND policyname = 'fleet_invite_sends_owner_select' AND cmd = 'SELECT'
        AND roles = '{authenticated}') <> 1
     OR (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'fleet_invite_sends') <> 1 THEN
    RAISE EXCEPTION '00676 check: fleet_invite_sends needs exactly the owner''s policy';
  END IF;
  IF has_table_privilege('anon', 'public.fleet_invite_sends', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('authenticated', 'public.fleet_invite_sends', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.fleet_invite_sends', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.fleet_invite_sends', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.fleet_invite_sends', 'INSERT') THEN
    RAISE EXCEPTION '00676 check: fleet_invite_sends has the wrong grants';
  END IF;
  IF (SELECT count(*)
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'public.fleet_invite_sends'::regclass AND i.indisunique AND i.indisvalid
        AND i.indpred IS NOT NULL
        AND c.relname IN ('fleet_invite_sends_first_sms_key', 'fleet_invite_sends_first_push_key')) <> 2 THEN
    RAISE EXCEPTION '00676 check: a first-contact key is missing';
  END IF;

  -- The triggers: for each row, on no column list, and with their WHEN.
  FOR v_row IN
    SELECT w.tbl, w.name, w.fn, w.kind
    FROM (VALUES
      ('public.fleet_members'::regclass, 'trg_fleet_members_notify', 'public.tg_fleet_members_notify()'::regprocedure, 17),
      ('public.fleet_members', 'trg_fleet_members_notify_delete', 'public.tg_fleet_members_notify()', 9),
      ('public.corporate_accounts', 'trg_corporate_accounts_fleet_notify', 'public.tg_corporate_accounts_fleet_notify()', 17)
    ) AS w(tbl, name, fn, kind)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = v_row.tbl AND t.tgname = v_row.name AND t.tgfoid = v_row.fn
        AND t.tgtype = v_row.kind AND t.tgenabled = 'O' AND t.tgqual IS NOT NULL
        AND cardinality(t.tgattr::int2[]) = 0
    ) THEN
      RAISE EXCEPTION '00676 check: % is not attached as written', v_row.name;
    END IF;
  END LOOP;

  -- The texts: one part, GSM-7 only.
  IF public._fleet_invite_sms_text('Ñáéíóúñáéíóúñáéíóúñáéíóú Ángel') !~ '^[A-Za-z0-9 .,:/''Ññé-]{100,160}$'
     OR public._fleet_invite_sms_text('') !~ '^[A-Za-z0-9 .,:/''Ññé-]{100,160}$'
     OR public._fleet_invite_sms_text('Søren Ørsted') <> public._fleet_invite_sms_text('') THEN
    RAISE EXCEPTION '00676 check: the SMS is not one GSM-7 part';
  END IF;
END
$check$;

-- The behaviour, against this database's real tables, acting as a real account. A plpgsql body is only
-- checked when it runs. Driver first and company second; asking again; the owner's resend; and the
-- driver's own functions. Everything is rolled back, the queued HTTP calls included (pg_net's queue is
-- a table). A database with no account has nobody to act as, so the check is skipped there.
DO $selftest$
DECLARE
  v_owner   uuid;
  v_account uuid := gen_random_uuid();
  v_fleet   uuid := gen_random_uuid();
  v_member  uuid := gen_random_uuid();
  v_waiting integer;
  v_sent    integer;
  v_calls   integer;
  v_again   text;
  v_resend  text;
  v_mine    integer;
  v_left    text;
  v_status  text;
BEGIN
  SELECT u.id INTO v_owner
  FROM public.users u
  WHERE u.role NOT IN ('admin', 'super_admin') AND u.id <> '00000000-0000-0000-0000-000000000099'
  ORDER BY u.created_at, u.id
  LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE NOTICE '00676: no account yet, behaviour self-test skipped';
    RETURN;
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by)
    VALUES (v_account, '00676 self-test', '+5359900676', 'pending', v_owner);
    INSERT INTO public.driver_fleets (id, corporate_account_id, name)
    VALUES (v_fleet, v_account, '00676 self-test');
    INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone)
    VALUES (v_member, v_fleet, '00676 self-test', '+5359900676');

    UPDATE public.fleet_members SET status = 'approved' WHERE id = v_member;
    SELECT count(*) INTO v_waiting FROM public.fleet_invite_sends WHERE fleet_id = v_fleet;
    UPDATE public.corporate_accounts SET status = 'approved' WHERE id = v_account;
    SELECT count(*) INTO v_sent FROM public.fleet_invite_sends WHERE fleet_id = v_fleet AND channel = 'sms';
    SELECT count(*) INTO v_calls FROM public.cron_http_calls WHERE jobname = 'fleet-invite-sms';
    v_again := public._fleet_announce_member(v_member, 'review');

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    v_resend := public.resend_fleet_invite(v_member) ->> 'error';
    PERFORM set_config('request.jwt.claims', '', true);

    UPDATE public.fleet_members SET status = 'active', driver_id = v_owner WHERE id = v_member;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_mine FROM public.get_my_fleet_memberships() m WHERE m.member_id = v_member;
    v_left := public.leave_fleet(v_member) ->> 'success';
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT status INTO v_status FROM public.fleet_members WHERE id = v_member;

    RAISE EXCEPTION '00676 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00676 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_waiting <> 0 THEN
    RAISE EXCEPTION '00676: an invitation was announced while its company was pending';
  END IF;
  IF v_sent <> 1 OR v_calls < 1 THEN
    RAISE EXCEPTION '00676: approving the company sent % SMS and % calls, not one', v_sent, v_calls;
  END IF;
  IF v_again IS DISTINCT FROM 'already_contacted' THEN
    RAISE EXCEPTION '00676: asking again answered %', COALESCE(v_again, 'nothing');
  END IF;
  IF v_resend IS DISTINCT FROM 'too_soon' THEN
    RAISE EXCEPTION '00676: resending at once answered %', COALESCE(v_resend, 'nothing');
  END IF;
  IF v_mine <> 1 OR v_left IS DISTINCT FROM 'true' OR v_status IS DISTINCT FROM 'inactive' THEN
    RAISE EXCEPTION '00676: the driver saw % rows and leaving left the row %', v_mine, COALESCE(v_status, 'missing');
  END IF;
END
$selftest$;

RESET lock_timeout;
