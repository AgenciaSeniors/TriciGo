-- ============================================================
-- 00605: clients can no longer INSERT into public.users
--
-- users_insert_own (00001) lets any signed-in account INSERT its own
-- public.users row (WITH CHECK id = auth.uid()), anon and authenticated hold
-- the INSERT grant, and tg_users_protect_admin_fields runs on UPDATE only, so
-- nothing protects role, level, the counters, is_active or phone on INSERT.
-- An account whose public.users row is gone while its auth.users row (and its
-- sessions) remain can recreate the row as super_admin. Reproduced locally
-- with the live bodies (supabase/tests/00605): the account got
-- is_super_admin() = true, and inserted as 'driver' it also got a TriciCoin
-- wallet from users_ensure_tricicoin_wallet.
--
-- Nobody needs this path. The row is created by handle_new_user (AFTER INSERT
-- ON auth.users, SECURITY DEFINER, owned by postgres, which also owns
-- public.users, so it needs neither the policy nor the grant). No app or Edge
-- Function inserts or upserts into users, handle_new_user is the only function
-- in prod that inserts into it, and no function deletes users rows: they only
-- go through the auth.users ON DELETE CASCADE. On 2026-09-26 every auth.users
-- row had its public.users row, so nobody could use the hole today; an
-- operator repair, a restore or a bulk wipe could open it.
--
-- driver_profiles and corporate_accounts keep their INSERT because the apps
-- insert them, and *_protect_insert triggers guard their fields. Here the
-- path is taken away instead (owner decision, 2026-09-27):
--   1. DROP POLICY users_insert_own.
--   2. REVOKE INSERT ON public.users from anon and authenticated (there are
--      no column ACLs). Two independent layers: a later blanket GRANT still
--      finds no policy, a later policy still finds no grant.
--   service_role keeps INSERT for operator repairs. A client upsert on users
--   (INSERT ... ON CONFLICT DO UPDATE) is refused too; none exists.
--
-- With no INSERT policy left, sign-up depends on two facts: handle_new_user's
-- owner owns public.users, and RLS on it is not forced (the owner of a table
-- is exempt from its RLS unless it is forced). FORCE ROW LEVEL SECURITY on
-- public.users would break every sign-up. The self-test checks both.
--
--   3. A self-test: no INSERT policy; no INSERT privilege for anon or
--      authenticated on any column; service_role's INSERT and the clients'
--      SELECT/UPDATE intact; RLS on and not forced, with handle_new_user a
--      SECURITY DEFINER owned by the table's owner; and an INSERT run as a
--      signed-in client refused. If the migration cannot switch to the
--      authenticated role, it says so in a NOTICE instead of skipping the
--      probe silently.
-- Rehearsal: supabase/tests/00605/run.sh.
-- ============================================================

-- DROP POLICY takes an ACCESS EXCLUSIVE lock on public.users, and every new
-- reader queues behind it while it waits: wait at most 2 s, then fail (retry).
SET lock_timeout = '2s';

DROP POLICY IF EXISTS users_insert_own ON public.users;
REVOKE INSERT ON public.users FROM anon, authenticated;

-- Self-test ----------------------------------------------------------------------
DO $selftest$
DECLARE
  v_as text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'users' AND cmd IN ('INSERT', 'ALL')) THEN
    RAISE EXCEPTION '00605 self-test: public.users still has a policy that allows INSERT';
  END IF;

  IF has_any_column_privilege('anon', 'public.users', 'INSERT')
     OR has_any_column_privilege('authenticated', 'public.users', 'INSERT') THEN
    RAISE EXCEPTION '00605 self-test: a client role can still INSERT into public.users';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.users', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.users', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.users', 'UPDATE') THEN
    RAISE EXCEPTION '00605 self-test: a grant other than the clients'' INSERT changed';
  END IF;

  -- Sign-up now works only because the definer owns the table and RLS is not forced.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c, pg_proc p
    WHERE c.oid = 'public.users'::regclass
      AND p.oid = 'public.handle_new_user()'::regprocedure
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
      AND p.prosecdef
      AND p.proowner = c.relowner) THEN
    RAISE EXCEPTION '00605 self-test: sign-up would break (RLS off or forced on public.users, or handle_new_user is not a SECURITY DEFINER owned by the table owner)';
  END IF;

  -- The way PostgREST runs a request: role authenticated, a JWT subject.
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
    PERFORM set_config('role', 'authenticated', true);
    v_as := current_user;  -- plpgsql variables survive the rollback of this block
    INSERT INTO public.users (id, role) VALUES (auth.uid(), 'super_admin');
    RAISE EXCEPTION '00605 self-test: an INSERT as a signed-in client went through';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF v_as IS DISTINCT FROM 'authenticated' THEN
        RAISE NOTICE '00605 self-test: % cannot switch to role authenticated, INSERT probe not run', session_user;
      END IF;
    WHEN foreign_key_violation THEN
      -- The random subject has no auth.users row, so an INSERT that got past
      -- the grant and RLS stops here.
      RAISE EXCEPTION '00605 self-test: an INSERT as a signed-in client got past the grant and RLS';
  END;
END
$selftest$;

RESET lock_timeout;
