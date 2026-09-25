-- Scaffold for the 00595 rehearsal: the LIVE production pieces around
-- auto_link_fleet_member_on_signup(), transcribed on 2026-09-25 from
-- pg_get_functiondef, pg_trigger, pg_constraint and pg_policy. Prod runs
-- PostgreSQL 17.6; RETURNING ... INTO behaves the same on the 16 used here.
-- The four function bodies were read back from prod as base64 instead of
-- being retyped, and run.sh checks their md5(prosrc):
--   auto_link_fleet_member_on_signup  0b74fd48e33257ba39bd719376d1a732 / 494  identical to 00461
--   tg_fleet_members_protect          8b0d07aff7ab33142bfcec29304c01ed / 674  00435 minus its comment lines
--   _normalize_cuban_phone            9f5227a3c108fa42f6aacdf01fb0ad86 / 451  identical to 00487
--   tg_users_normalize_phone          c0491b42cf36767c3911fb8a3fda9f04 / 147  identical to 00461
-- Prod's three DDL event triggers are at the end of this file.
-- Left out because none of it touches fleet_members: the FK users.id ->
-- auth.users (a signup creates the auth row first), the other triggers on
-- users (audit_users, users_ensure_tricicoin_wallet), the corporate_accounts
-- behind driver_fleets, and the fleet_members policies. The trigger function
-- is SECURITY DEFINER and owned by the table owner (postgres in prod, pgtest
-- here), so RLS never filters its UPDATE.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- Stub: tg_fleet_members_protect asks it first. Nobody here is an admin.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

-- LIVE users, reduced to what the trigger reads (id, phone), plus the phone
-- CHECK from 00530 and the policy that lets a signed-in user insert their
-- own row. Table grants are Supabase's defaults.
CREATE TABLE public.users (
  id    uuid PRIMARY KEY,
  phone text,
  CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)))
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_insert_own ON public.users
  FOR INSERT WITH CHECK ((id = ( SELECT auth.uid() AS uid)));
GRANT ALL ON public.users TO anon, authenticated, service_role;

-- driver_fleets reduced to its key: fleet_members only needs the FK target.
CREATE TABLE public.driver_fleets (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
ALTER TABLE public.driver_fleets ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.driver_fleets TO anon, authenticated, service_role;

-- LIVE fleet_members: every column, default and constraint. It is unique
-- only on the RAW (fleet_id, driver_phone), so one person can hold two
-- invitations that normalize to the same phone.
CREATE TABLE public.fleet_members (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  fleet_id              uuid NOT NULL,
  driver_id             uuid,
  driver_name           text NOT NULL,
  driver_phone          text NOT NULL,
  driver_email          text,
  driver_license_number text,
  driver_id_number      text,
  status                text NOT NULL DEFAULT 'pending_review'::text,
  license_doc_path      text,
  added_at              timestamp with time zone NOT NULL DEFAULT now(),
  reviewed_at           timestamp with time zone,
  reviewed_by           uuid,
  rejected_reason       text,
  signed_up_at          timestamp with time zone,
  CONSTRAINT fleet_members_pkey PRIMARY KEY (id),
  CONSTRAINT fleet_members_fleet_id_driver_phone_key UNIQUE (fleet_id, driver_phone),
  CONSTRAINT fleet_members_fleet_id_fkey FOREIGN KEY (fleet_id) REFERENCES public.driver_fleets(id) ON DELETE CASCADE,
  CONSTRAINT fleet_members_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_members_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id),
  CONSTRAINT fleet_members_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'pending_signup'::text, 'active'::text, 'inactive'::text])))
);
ALTER TABLE public.fleet_members ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.fleet_members TO anon, authenticated, service_role;

-- LIVE (identical to 00487). ACL {=X, postgres=X, service_role=X}.
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
GRANT EXECUTE ON FUNCTION public._normalize_cuban_phone(text) TO service_role;

-- LIVE (identical to 00461): BEFORE INSERT OR UPDATE OF phone ON users.
CREATE OR REPLACE FUNCTION public.tg_users_normalize_phone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    NEW.phone := public._normalize_cuban_phone(NEW.phone);
  END IF;
  RETURN NEW;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.tg_users_normalize_phone() TO service_role;
CREATE TRIGGER tg_users_normalize_phone BEFORE INSERT OR UPDATE OF phone ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_normalize_phone();

-- LIVE (00435 minus its comment lines): BEFORE INSERT OR UPDATE ON
-- fleet_members. Only an admin, a caller with no JWT, or a caller that set
-- app.trusted_fleet_update may change status or driver_id.
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
    RETURN NEW;
  END IF;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.tg_fleet_members_protect() TO service_role;
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_protect();

-- LIVE (pre-00595, identical to 00461): the RETURNING ... INTO raises
-- TOO_MANY_ROWS as soon as the UPDATE matches two invitations, and that
-- rolls back the INSERT into users. ACL {postgres=X, service_role=X}.
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member_id uuid;
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL
  RETURNING id INTO v_member_id;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;
CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_signup();

-- LIVE DDL event triggers, created last so they only see the migration and
-- the tests. The migration's self-test creates temp tables, a temp function
-- and a trigger, so each of these fires during the apply, as it will in
-- prod. Definitions read back from prod as base64; run.sh checks their
-- md5(prosrc):
--   rls_auto_enable          99be20677b456ea8d3be47bdd44fb369 / 953   (ensure_rls)
--   grant_pg_graphql_access  dd3f3e2bb94cff45ef24b9cecb6af1c8 / 1357  (issue_pg_graphql_access)
--   pgrst_ddl_watch          7f27b8118fea5c88b0164331292859e3 / 729   (pgrst_ddl_watch)
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
CREATE OR REPLACE FUNCTION extensions.grant_pg_graphql_access()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
    if not exists (
        select 1
        from pg_catalog.pg_event_trigger_ddl_commands() ev
        join pg_catalog.pg_extension e on ev.objid = e.oid
        where e.extname = 'pg_graphql'
    ) then
        return;
    end if;

    drop function if exists graphql_public.graphql;
    create or replace function graphql_public.graphql(
        "operationName" text default null,
        query text default null,
        variables jsonb default null,
        extensions jsonb default null
    )
        returns jsonb
        language sql
    as $$
        select graphql.resolve(
            query := query,
            variables := coalesce(variables, '{}'),
            "operationName" := "operationName",
            extensions := extensions
        );
    $$;

    -- Attach the wrapper to the extension so DROP EXTENSION cascades to it,
    -- which in turn triggers set_graphql_placeholder to reinstall the "not enabled" stub.
    alter extension pg_graphql add function graphql_public.graphql(text, text, jsonb, jsonb);

    grant usage on schema graphql to postgres, anon, authenticated, service_role;
    grant execute on function graphql.resolve to postgres, anon, authenticated, service_role;
    grant usage on schema graphql to postgres with grant option;
    grant usage on schema graphql_public to postgres with grant option;
end;
$function$;
CREATE OR REPLACE FUNCTION extensions.pgrst_ddl_watch()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $function$;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();
CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION')
  EXECUTE FUNCTION extensions.grant_pg_graphql_access();
CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end
  EXECUTE FUNCTION extensions.pgrst_ddl_watch();
