-- ============================================================
-- Migration 00661: team invitations for the admin panel
--
-- Spec: docs/superpowers/specs/2026-10-12-team-invitations-design.md
--
-- Until now a team member got into the panel by signing in, being bounced to
-- /login?error=unauthorized, and waiting for someone to run promote_user_role
-- (00291) by SQL. This adds invitations bound to an e-mail address:
--
--   1. public.team_invitations, a lock table: RLS on, no policies, GRANT to
--      service_role only. The panel reaches it only through the functions below.
--   2. Helpers (no client may execute them): _team_mask_email, _team_invitation_link,
--      _team_role_rank, _team_require_super_admin, _team_previous_role,
--      _team_lock_target, _team_check_last_super_admin, _team_write_role,
--      _team_queue_invitation_email.
--   3. For the panel: list_team, create_team_invitation, resend_team_invitation,
--      cancel_team_invitation, set_team_member_role, remove_team_member (super_admin
--      only), get_team_invitation (anyone with the token, anon too) and
--      accept_team_invitation (the signed-in person).
--   4. tg_users_protect_admin_fields gets one branch: a role change passes while
--      the transaction has app.team_role_change = '1'. Only _team_write_role sets
--      it, around its single UPDATE. Patched in place from the live body (md5
--      377912e8... from 00599); any other body aborts the migration.
--   5. Permissions, 6. carriage returns out of the bodies, 7. self-checks.
--
-- Accepting: the caller's verified Google or Apple identity (auth.identities,
-- email_verified true) must have the invited address. A blocked account
-- (is_active false) is not accepted. Accepting never lowers a panel role.
-- The invitation e-mail goes through send-email (template team_invitation, which
-- needs a send-email deploy) via cron_http_post, label team-invitation-email, so a
-- rejected send shows in check_cron_http_failures.
-- Errors carry Spanish text in MESSAGE and a code in DETAIL (team_*).
-- Rehearsal: supabase/tests/00661/run.sh
-- ============================================================

-- 0. The live protect trigger must be the one this migration knows ---------------
DO $guard$
DECLARE
  v_md5 text;
  v_src text;
BEGIN
  SELECT md5(prosrc), prosrc INTO v_md5, v_src
  FROM pg_proc WHERE oid = 'public.tg_users_protect_admin_fields()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '377912e83023297eda4761622a113364'
     AND position('app.team_role_change' IN coalesce(v_src, '')) = 0 THEN
    RAISE EXCEPTION '00661: tg_users_protect_admin_fields has an unknown body (md5 %), refusing to patch it', v_md5;
  END IF;
END
$guard$;

-- 1. Table -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  role             public.user_role NOT NULL CHECK (role IN ('super_admin', 'admin', 'marketing')),
  full_name        text CHECK (full_name IS NULL OR char_length(full_name) <= 80),
  token            text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
  invited_by       uuid NOT NULL REFERENCES public.users (id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'canceled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  sent_at          timestamptz,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES public.users (id),
  canceled_at      timestamptz,
  canceled_by      uuid REFERENCES public.users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS team_invitations_one_pending
  ON public.team_invitations (email) WHERE status = 'pending';
ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_invitations TO service_role;

-- 2. Helpers -----------------------------------------------------------------------
-- 'l…@gmail.com': first character, an ellipsis (chr(8230)) and the domain.
CREATE OR REPLACE FUNCTION public._team_mask_email(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_email IS NULL OR position('@' IN p_email) < 2 THEN chr(8230)
    ELSE left(p_email, 1) || chr(8230) || '@' || split_part(p_email, '@', 2)
  END
$$;

CREATE OR REPLACE FUNCTION public._team_invitation_link(p_token text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT 'https://admin.tricigo.com/invitacion/' || p_token
$$;

CREATE OR REPLACE FUNCTION public._team_role_rank(p_role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_role WHEN 'super_admin' THEN 3 WHEN 'admin' THEN 2 WHEN 'marketing' THEN 1 ELSE 0 END
$$;

-- The caller, when it is an active super_admin; otherwise 42501 team_not_super_admin.
CREATE OR REPLACE FUNCTION public._team_require_super_admin()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = v_uid AND u.role = 'super_admin' AND coalesce(u.is_active, true)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un superadministrador puede gestionar el equipo.',
      DETAIL = 'team_not_super_admin';
  END IF;
  RETURN v_uid;
END;
$$;

-- The role an account goes back to when it leaves the team.
CREATE OR REPLACE FUNCTION public._team_previous_role(p_user uuid)
RETURNS public.user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.driver_profiles dp
      WHERE dp.user_id = p_user AND dp.status IN ('approved', 'suspended')
    ) THEN 'driver'::public.user_role
    ELSE 'customer'::public.user_role
  END
$$;

-- Locks the target row and returns its role. Refuses system accounts, oneself and
-- anyone outside the team.
CREATE OR REPLACE FUNCTION public._team_lock_target(p_caller uuid, p_user uuid)
RETURNS public.user_role
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_role public.user_role;
BEGIN
  IF p_user IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esa es una cuenta del sistema.', DETAIL = 'team_system_account';
  END IF;
  IF p_user = p_caller THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No puedes cambiar tu propio acceso.', DETAIL = 'team_self';
  END IF;
  SELECT u.role INTO v_role FROM public.users u WHERE u.id = p_user FOR UPDATE;
  IF NOT FOUND OR v_role NOT IN ('super_admin', 'admin', 'marketing') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esa cuenta no es parte del equipo.', DETAIL = 'team_not_member';
  END IF;
  RETURN v_role;
END;
$$;

-- Refuses to leave the team without an active super_admin other than p_user
-- (system accounts do not count).
CREATE OR REPLACE FUNCTION public._team_check_last_super_admin(p_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.role = 'super_admin' AND coalesce(u.is_active, true) AND u.id <> p_user
      AND u.id NOT IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Tiene que quedar al menos un superadministrador.', DETAIL = 'team_last_super_admin';
  END IF;
END;
$$;

-- The only writer of the team role flag: one UPDATE, flag set just around it.
CREATE OR REPLACE FUNCTION public._team_write_role(p_user uuid, p_role public.user_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM set_config('app.team_role_change', '1', true);
  UPDATE public.users SET role = p_role WHERE id = p_user;
  PERFORM set_config('app.team_role_change', '', true);
END;
$$;

-- Queues the invitation e-mail. false when it could not be queued (not pending, no
-- service key): the invitation still exists and the panel shows its link.
CREATE OR REPLACE FUNCTION public._team_queue_invitation_email(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inv     public.team_invitations;
  v_inviter text;
  v_key     text;
BEGIN
  SELECT * INTO v_inv FROM public.team_invitations WHERE id = p_id;
  IF NOT FOUND OR v_inv.status <> 'pending' THEN
    RETURN false;
  END IF;
  SELECT coalesce(btrim(full_name), '') INTO v_inviter FROM public.users WHERE id = v_inv.invited_by;
  v_key := public.get_service_role_key();
  IF coalesce(v_key, '') = '' THEN
    RETURN false;
  END IF;
  PERFORM public.cron_http_post('team-invitation-email',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key,
      'apikey', v_key),
    body := jsonb_build_object(
      'recipient_email', v_inv.email,
      'template', 'team_invitation',
      'data', jsonb_build_object(
        'invitee_name', coalesce(v_inv.full_name, ''),
        'inviter_name', coalesce(v_inviter, ''),
        'role', v_inv.role::text,
        'link', public._team_invitation_link(v_inv.token),
        'expires_at', to_char(v_inv.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'email', v_inv.email)),
    timeout_milliseconds := 30000);
  UPDATE public.team_invitations SET sent_at = now() WHERE id = p_id;
  RETURN true;
END;
$$;

-- 3. Functions the panel calls ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_team()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid := public._team_require_super_admin();
BEGIN
  RETURN jsonb_build_object(
    'members', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'user_id', u.id,
          'full_name', coalesce(btrim(u.full_name), ''),
          'email', coalesce(m.email, nullif(btrim(u.email), '')),
          'role', u.role,
          'last_sign_in_at', au.last_sign_in_at,
          'gets_digest', m.email IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.team_digest_optouts o WHERE o.user_id = u.id AND o.opted_out),
          'is_me', u.id = v_uid)
        ORDER BY public._team_role_rank(u.role::text) DESC, lower(coalesce(u.full_name, '')), u.id)
      FROM public.users u
      LEFT JOIN auth.users au ON au.id = u.id
      LEFT JOIN public.mailable_user_emails(ARRAY(
        SELECT x.id FROM public.users x WHERE x.role IN ('super_admin', 'admin', 'marketing'))) m
        ON m.user_id = u.id
      WHERE u.role IN ('super_admin', 'admin', 'marketing')
        AND coalesce(u.is_active, true)
        AND u.id NOT IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099')
    ), '[]'::jsonb),
    'invitations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'id', i.id,
          'email', i.email,
          'role', i.role,
          'full_name', i.full_name,
          'invited_by_name', coalesce(btrim(inv.full_name), ''),
          'created_at', i.created_at,
          'expires_at', i.expires_at,
          'sent_at', i.sent_at,
          'expired', i.expires_at <= now(),
          'link', public._team_invitation_link(i.token))
        ORDER BY i.created_at DESC, i.id)
      FROM public.team_invitations i
      LEFT JOIN public.users inv ON inv.id = i.invited_by
      WHERE i.status = 'pending'
    ), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.create_team_invitation(p_email text, p_role text, p_full_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid    uuid := public._team_require_super_admin();
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_name   text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_exp    timestamptz := now() + interval '7 days';
  v_token  text;
  v_id     uuid;
  v_queued boolean;
BEGIN
  IF char_length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'El correo no es válido.', DETAIL = 'team_bad_email';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('super_admin', 'admin', 'marketing') THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'El rol tiene que ser superadministrador, administrador o marketing.', DETAIL = 'team_bad_role';
  END IF;
  IF v_name IS NOT NULL AND char_length(v_name) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'El nombre puede tener hasta 80 caracteres.', DETAIL = 'team_bad_name';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.role IN ('super_admin', 'admin', 'marketing') AND coalesce(u.is_active, true)
      AND (lower(btrim(coalesce(u.email, ''))) = v_email
           OR EXISTS (SELECT 1 FROM auth.identities i
                      WHERE i.user_id = u.id AND i.provider IN ('google', 'apple')
                        AND lower(btrim(coalesce(i.identity_data->>'email', ''))) = v_email))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esa dirección ya es de alguien del equipo.', DETAIL = 'team_already_member';
  END IF;
  IF EXISTS (SELECT 1 FROM public.team_invitations WHERE email = v_email AND status = 'pending') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ya hay una invitación pendiente para esa dirección. Reenvíala en vez de crear otra.',
      DETAIL = 'team_already_invited';
  END IF;

  -- Two UUIDs of strong randomness: 244 random bits, 64 hex characters.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  BEGIN
    INSERT INTO public.team_invitations (email, role, full_name, token, invited_by, expires_at)
    VALUES (v_email, p_role::public.user_role, v_name, v_token, v_uid, v_exp)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ya hay una invitación pendiente para esa dirección. Reenvíala en vez de crear otra.',
      DETAIL = 'team_already_invited';
  END;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (v_uid, 'team_invite_created', 'team_invitation', v_id::text,
          jsonb_build_object('email', v_email, 'role', p_role));

  v_queued := public._team_queue_invitation_email(v_id);
  RETURN jsonb_build_object(
    'id', v_id, 'email', v_email, 'role', p_role,
    'link', public._team_invitation_link(v_token), 'expires_at', v_exp, 'email_queued', v_queued);
END;
$$;

CREATE OR REPLACE FUNCTION public.resend_team_invitation(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid    uuid := public._team_require_super_admin();
  v_inv    public.team_invitations;
  v_exp    timestamptz := now() + interval '7 days';
  v_queued boolean;
BEGIN
  SELECT * INTO v_inv FROM public.team_invitations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No encontramos esa invitación.', DETAIL = 'team_invitation_not_found';
  END IF;
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esa invitación ya no está pendiente.', DETAIL = 'team_invitation_not_pending';
  END IF;
  UPDATE public.team_invitations SET expires_at = v_exp WHERE id = p_id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_uid, 'team_invite_resent', 'team_invitation', p_id::text,
          jsonb_build_object('expires_at', v_inv.expires_at), jsonb_build_object('expires_at', v_exp));
  v_queued := public._team_queue_invitation_email(p_id);
  RETURN jsonb_build_object(
    'id', p_id, 'link', public._team_invitation_link(v_inv.token), 'expires_at', v_exp, 'email_queued', v_queued);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_team_invitation(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid := public._team_require_super_admin();
  v_inv public.team_invitations;
BEGIN
  SELECT * INTO v_inv FROM public.team_invitations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No encontramos esa invitación.', DETAIL = 'team_invitation_not_found';
  END IF;
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esa invitación ya no está pendiente.', DETAIL = 'team_invitation_not_pending';
  END IF;
  UPDATE public.team_invitations
     SET status = 'canceled', canceled_at = now(), canceled_by = v_uid
   WHERE id = p_id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values)
  VALUES (v_uid, 'team_invite_canceled', 'team_invitation', p_id::text,
          jsonb_build_object('email', v_inv.email, 'role', v_inv.role));
  RETURN 'canceled';
END;
$$;

-- Public page: what the invitation is, never the full address. Nothing without a valid token.
CREATE OR REPLACE FUNCTION public.get_team_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inv     public.team_invitations;
  v_inviter text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  SELECT coalesce(btrim(full_name), '') INTO v_inviter FROM public.users WHERE id = v_inv.invited_by;
  RETURN jsonb_build_object(
    'status', CASE WHEN v_inv.status = 'pending' AND v_inv.expires_at <= now() THEN 'expired' ELSE v_inv.status END,
    'role', v_inv.role,
    'inviter_name', coalesce(v_inviter, ''),
    'email_masked', public._team_mask_email(v_inv.email),
    'expires_at', v_inv.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_team_invitation(p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   public.user_role;
  v_active boolean;
  v_emails text[];
  v_inv    public.team_invitations;
  v_new    public.user_role;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Inicia sesión para aceptar la invitación.', DETAIL = 'team_no_session';
  END IF;
  SELECT u.role, coalesce(u.is_active, true) INTO v_role, v_active FROM public.users u WHERE u.id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'none');
  END IF;

  SELECT coalesce(array_agg(DISTINCT lower(btrim(i.identity_data->>'email'))), '{}'::text[])
    INTO v_emails
  FROM auth.identities i
  WHERE i.user_id = v_uid
    AND i.provider IN ('google', 'apple')
    AND lower(coalesce(i.identity_data->>'email_verified', '')) = 'true'
    AND btrim(coalesce(i.identity_data->>'email', '')) <> '';

  IF p_token IS NOT NULL THEN
    SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('result', 'not_found');
    END IF;
    IF v_inv.status = 'canceled' THEN
      RETURN jsonb_build_object('result', 'canceled');
    END IF;
    IF v_inv.status = 'accepted' THEN
      IF v_inv.accepted_user_id = v_uid THEN
        RETURN jsonb_build_object('result', 'accepted', 'role', v_role);
      END IF;
      RETURN jsonb_build_object('result', 'used');
    END IF;
    IF v_inv.expires_at <= now() THEN
      RETURN jsonb_build_object('result', 'expired');
    END IF;
    IF NOT (v_inv.email = ANY (v_emails)) THEN
      RETURN jsonb_build_object(
        'result', CASE WHEN cardinality(v_emails) = 0 THEN 'needs_google' ELSE 'wrong_account' END,
        'email_masked', public._team_mask_email(v_inv.email));
    END IF;
  ELSE
    SELECT * INTO v_inv FROM public.team_invitations
    WHERE status = 'pending' AND expires_at > now() AND email = ANY (v_emails)
    ORDER BY created_at DESC, id
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('result', 'none');
    END IF;
  END IF;

  IF NOT v_active THEN
    RETURN jsonb_build_object('result', 'blocked');
  END IF;

  v_new := CASE WHEN public._team_role_rank(v_role::text) >= public._team_role_rank(v_inv.role::text)
                THEN v_role ELSE v_inv.role END;
  IF v_new IS DISTINCT FROM v_role THEN
    PERFORM public._team_write_role(v_uid, v_new);
  END IF;
  UPDATE public.team_invitations
     SET status = 'accepted', accepted_at = now(), accepted_user_id = v_uid
   WHERE id = v_inv.id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_inv.invited_by, 'team_invite_accepted', 'user', v_uid::text,
          jsonb_build_object('role', v_role),
          jsonb_build_object('role', v_new, 'invitation_id', v_inv.id));
  RETURN jsonb_build_object('result', 'accepted', 'role', v_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_team_member_role(p_user uuid, p_role text, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid    uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.user_role;
BEGIN
  PERFORM public._team_require_super_admin();
  IF p_role IS NULL OR p_role NOT IN ('super_admin', 'admin', 'marketing') THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'El rol tiene que ser superadministrador, administrador o marketing.', DETAIL = 'team_bad_role';
  END IF;
  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Escribe el motivo (al menos 5 caracteres).', DETAIL = 'team_reason_required';
  END IF;
  -- Team changes run one at a time: two super_admins demoting each other at once
  -- could otherwise leave none.
  PERFORM 1 FROM public.users WHERE role = 'super_admin' ORDER BY id FOR UPDATE;
  v_uid := public._team_require_super_admin();
  v_old := public._team_lock_target(v_uid, p_user);
  IF v_old::text = p_role THEN
    RETURN p_role;
  END IF;
  IF v_old = 'super_admin' THEN
    PERFORM public._team_check_last_super_admin(p_user);
  END IF;
  PERFORM public._team_write_role(p_user, p_role::public.user_role);
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_uid, 'team_role_changed', 'user', p_user::text,
          jsonb_build_object('role', v_old), jsonb_build_object('role', p_role), v_reason);
  RETURN p_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_team_member(p_user uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid    uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.user_role;
  v_new    public.user_role;
BEGIN
  PERFORM public._team_require_super_admin();
  IF char_length(v_reason) < 5 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Escribe el motivo (al menos 5 caracteres).', DETAIL = 'team_reason_required';
  END IF;
  PERFORM 1 FROM public.users WHERE role = 'super_admin' ORDER BY id FOR UPDATE;
  v_uid := public._team_require_super_admin();
  v_old := public._team_lock_target(v_uid, p_user);
  IF v_old = 'super_admin' THEN
    PERFORM public._team_check_last_super_admin(p_user);
  END IF;
  v_new := public._team_previous_role(p_user);
  PERFORM public._team_write_role(p_user, v_new);
  -- A pending invitation for one of the person's addresses would give the access back
  -- the next time they sign in: it goes too.
  UPDATE public.team_invitations i
     SET status = 'canceled', canceled_at = now(), canceled_by = v_uid
   WHERE i.status = 'pending'
     AND (i.email = (SELECT lower(btrim(coalesce(u.email, ''))) FROM public.users u WHERE u.id = p_user)
          OR i.email IN (SELECT lower(btrim(coalesce(ai.identity_data->>'email', '')))
                         FROM auth.identities ai WHERE ai.user_id = p_user));
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_uid, 'team_member_removed', 'user', p_user::text,
          jsonb_build_object('role', v_old), jsonb_build_object('role', v_new), v_reason);
  RETURN v_new::text;
END;
$$;

-- 4. The protect trigger lets a team role change through -----------------------------
DO $patch$
DECLARE
  v_src text;
  c_anchor CONSTANT text := '  IF current_setting(''app.trusted_tier_update'', true) = ''1'' THEN';
  c_branch CONSTANT text := array_to_string(ARRAY[
    '  -- 00661: team invitations. _team_write_role sets the team role flag around its',
    '  -- single UPDATE (accept_team_invitation, set_team_member_role, remove_team_member).',
    '  -- Only the role passes; what the other branches protect stays as it was.',
    '  IF coalesce(current_setting(''app.team_role_change'', true), '''') = ''1'' THEN',
    '    NEW.is_active            := OLD.is_active;',
    '    NEW.level                := OLD.level;',
    '    NEW.total_rides          := OLD.total_rides;',
    '    NEW.total_spent          := OLD.total_spent;',
    '    NEW.cancellation_count   := OLD.cancellation_count;',
    '    NEW.last_cancellation_at := OLD.last_cancellation_at;',
    '    NEW.id                   := OLD.id;',
    '    NEW.created_at           := OLD.created_at;',
    '    RETURN NEW;',
    '  END IF;',
    '',
    ''], chr(10));
BEGIN
  SELECT pg_get_functiondef('public.tg_users_protect_admin_fields()'::regprocedure) INTO v_src;
  IF position('app.team_role_change' IN v_src) > 0 THEN
    RETURN;
  END IF;
  IF (length(v_src) - length(replace(v_src, c_anchor, ''))) / length(c_anchor) <> 1 THEN
    RAISE EXCEPTION '00661: the anchor is not in tg_users_protect_admin_fields exactly once';
  END IF;
  EXECUTE replace(v_src, c_anchor, c_branch || c_anchor);
END
$patch$;

-- 5. Permissions -----------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public._team_mask_email(text),
  public._team_invitation_link(text),
  public._team_role_rank(text),
  public._team_require_super_admin(),
  public._team_previous_role(uuid),
  public._team_lock_target(uuid, uuid),
  public._team_check_last_super_admin(uuid),
  public._team_write_role(uuid, public.user_role),
  public._team_queue_invitation_email(uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.list_team(),
  public.create_team_invitation(text, text, text),
  public.resend_team_invitation(uuid),
  public.cancel_team_invitation(uuid),
  public.get_team_invitation(text),
  public.accept_team_invitation(text),
  public.set_team_member_role(uuid, text, text),
  public.remove_team_member(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.list_team(),
  public.create_team_invitation(text, text, text),
  public.resend_team_invitation(uuid),
  public.cancel_team_invitation(uuid),
  public.accept_team_invitation(text),
  public.set_team_member_role(uuid, text, text),
  public.remove_team_member(uuid, text)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_team_invitation(text) TO anon, authenticated, service_role;

-- 6. A copy pasted with CRLF line endings leaves carriage returns in the bodies --------
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_mask_email(text)', 'public._team_invitation_link(text)', 'public._team_role_rank(text)',
    'public._team_require_super_admin()', 'public._team_previous_role(uuid)',
    'public._team_lock_target(uuid, uuid)', 'public._team_check_last_super_admin(uuid)',
    'public._team_write_role(uuid, public.user_role)', 'public._team_queue_invitation_email(uuid)',
    'public.list_team()', 'public.create_team_invitation(text, text, text)',
    'public.resend_team_invitation(uuid)', 'public.cancel_team_invitation(uuid)',
    'public.get_team_invitation(text)', 'public.accept_team_invitation(text)',
    'public.set_team_member_role(uuid, text, text)', 'public.remove_team_member(uuid, text)']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 7. Self-checks -------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn   regprocedure;
  v_role text;
  v_src  text;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.team_invitations'::regclass) THEN
    RAISE EXCEPTION '00661: public.team_invitations has row level security disabled';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.team_invitations', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '00661: % has privileges on public.team_invitations', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.team_invitations', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION '00661: service_role cannot use public.team_invitations';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_mask_email(text)', 'public._team_invitation_link(text)', 'public._team_role_rank(text)',
    'public._team_require_super_admin()', 'public._team_previous_role(uuid)',
    'public._team_lock_target(uuid, uuid)', 'public._team_check_last_super_admin(uuid)',
    'public._team_write_role(uuid, public.user_role)', 'public._team_queue_invitation_email(uuid)']::regprocedure[]
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '00661: % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.list_team()', 'public.create_team_invitation(text, text, text)',
    'public.resend_team_invitation(uuid)', 'public.cancel_team_invitation(uuid)',
    'public.accept_team_invitation(text)', 'public.set_team_member_role(uuid, text, text)',
    'public.remove_team_member(uuid, text)']::regprocedure[]
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00661: anon can execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00661: authenticated cannot execute %', v_fn;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION '00661: % must be SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('anon', 'public.get_team_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00661: anon cannot execute public.get_team_invitation(text)';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.tg_users_protect_admin_fields()'::regprocedure;
  IF (length(v_src) - length(replace(v_src, 'current_setting(''app.team_role_change''', '')))
       / length('current_setting(''app.team_role_change''') <> 1 THEN
    RAISE EXCEPTION '00661: tg_users_protect_admin_fields does not read the team role flag exactly once';
  END IF;
  IF position(chr(13) IN v_src) > 0 THEN
    RAISE EXCEPTION '00661: tg_users_protect_admin_fields kept a carriage return';
  END IF;
END
$check$;
