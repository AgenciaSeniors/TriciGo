-- Extra scaffold for the 00664 rehearsal, run after supabase/tests/00661/scaffold.sql.
-- What 00664 reads that the 00661 scaffold leaves out: the sign-in address and the ban of
-- auth.users, GoTrue's sessions and refresh tokens, pgcrypto in schema extensions,
-- rate_limits with the LIVE body of check_rate_limit (prod 2026-10-16, md5 5a2e6163.../527),
-- and the trigger that gates users.email_verified_at with its LIVE body
-- (00611; prod 2026-10-16, md5 96a5ad5e.../465).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

SET ROLE postgres;
ALTER TABLE auth.users
  ADD COLUMN email text,
  ADD COLUMN encrypted_password text,
  ADD COLUMN banned_until timestamptz,
  ADD COLUMN raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE auth.sessions (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
CREATE TABLE auth.refresh_tokens (
  id         bigserial PRIMARY KEY,
  user_id    character varying(255),
  session_id uuid REFERENCES auth.sessions (id) ON DELETE CASCADE
);

CREATE TABLE public.rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
 RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO rate_limits (key, window_start, count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING rate_limits.count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_max_requests,
    v_count,
    v_window_start + (p_window_seconds * INTERVAL '1 second');
END;
$function$
;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;

-- 00611, as prod has it: a change of users.email clears email_verified_at, and a caller with a
-- JWT that is not an admin cannot change the mark (it is put back).
CREATE OR REPLACE FUNCTION public.tg_users_protect_email_verification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    -- A new address is unconfirmed until confirm-email says otherwise.
    NEW.email_verified_at := NULL;
  ELSIF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
        AND auth.uid() IS NOT NULL
        AND NOT public.is_admin() THEN
    -- Only the server (confirm-email, no JWT) or an admin may set or clear it.
    NEW.email_verified_at := OLD.email_verified_at;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.tg_users_protect_email_verification() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_users_protect_email_verification
  BEFORE UPDATE OF email, email_verified_at ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_email_verification();
RESET ROLE;
