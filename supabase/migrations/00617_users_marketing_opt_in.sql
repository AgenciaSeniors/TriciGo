-- 00617: record each user's consent to marketing messages (WhatsApp, SMS, email).
--
-- Why: the launch plan for 2026-10-15 writes one by one by WhatsApp to every
-- registered user and sends campaign emails, and its own compliance section asks
-- that signup include consent to TriciGo's communications. Today signup asks for
-- nothing: there is only the notification_preferences.promotions opt-out, which
-- covers in-app push and defaults to true.
--
-- Decision (2026-10-06): an UNCHECKED box at signup (client, web and driver), and
-- one in-app question for the users who registered before it. Push promotions keep
-- their own toggle (notification_preferences.promotions); this consent covers the
-- channels outside the app.
--
--   marketing_opt_in         NULL = never asked, true = accepted, false = declined
--   marketing_opt_in_at      when the current choice was made (server time)
--   marketing_opt_in_source  where it was made: 'signup' | 'prompt' | 'settings'
--
-- The owner writes marketing_opt_in (and optionally the source) through the
-- existing users_update_own policy and table-level UPDATE grant. The trigger below
-- stamps the time itself and keeps time and source untouched unless the choice
-- changes, so neither can be backdated or rewritten from a client.
--
-- Rehearsal: supabase/tests/00617/run.sh

SET lock_timeout = '5s';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS marketing_opt_in boolean,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_source text;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_marketing_opt_in_source_chk;
ALTER TABLE public.users ADD CONSTRAINT users_marketing_opt_in_source_chk
  CHECK (marketing_opt_in_source IS NULL OR marketing_opt_in_source IN ('signup', 'prompt', 'settings'));

RESET lock_timeout;

COMMENT ON COLUMN public.users.marketing_opt_in IS
  '00617: consent to marketing by WhatsApp, SMS and email. NULL = never asked.';

CREATE OR REPLACE FUNCTION public.tg_users_marketing_opt_in()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.marketing_opt_in IS NULL THEN
      NEW.marketing_opt_in_at := NULL;
      NEW.marketing_opt_in_source := NULL;
    ELSE
      NEW.marketing_opt_in_at := now();
      NEW.marketing_opt_in_source := COALESCE(NEW.marketing_opt_in_source, 'signup');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.marketing_opt_in IS NOT DISTINCT FROM OLD.marketing_opt_in THEN
    -- Same choice: time and source stay as recorded.
    NEW.marketing_opt_in_at := OLD.marketing_opt_in_at;
    NEW.marketing_opt_in_source := OLD.marketing_opt_in_source;
  ELSIF NEW.marketing_opt_in IS NULL THEN
    NEW.marketing_opt_in_at := NULL;
    NEW.marketing_opt_in_source := NULL;
  ELSE
    NEW.marketing_opt_in_at := now();
    IF NEW.marketing_opt_in_source IS NOT DISTINCT FROM OLD.marketing_opt_in_source THEN
      NEW.marketing_opt_in_source := 'settings';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DO $grants$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION public.tg_users_marketing_opt_in() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.tg_users_marketing_opt_in() FROM %I', r);
    END IF;
  END LOOP;
END $grants$;

DROP TRIGGER IF EXISTS trg_users_marketing_opt_in ON public.users;
CREATE TRIGGER trg_users_marketing_opt_in
  BEFORE INSERT OR UPDATE OF marketing_opt_in, marketing_opt_in_at, marketing_opt_in_source ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_users_marketing_opt_in();
