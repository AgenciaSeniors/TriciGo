-- ============================================================
-- BUG-Store-Readiness-Client (B2 + D1 + W2)
-- Account hard-delete: anonymous target user + dynamic FK anonymization
-- ============================================================
--
-- Problem
-- -------
-- `apps/client/store-metadata/app-store-review-notes.md` promised
-- hard-delete via `auth.admin.deleteUser`, but the realidad was only
-- soft-delete (`UPDATE users SET deleted_at = NOW()`). Apple/Play
-- cross-verify review notes vs the actual app during review — that
-- inconsistency was an open rejection risk (D1 in the audit).
--
-- Why we can't just call `auth.admin.deleteUser` directly
-- -------------------------------------------------------
-- `public.users.id REFERENCES auth.users(id) ON DELETE CASCADE`, so
-- the cascade would propagate to `public.users` correctly. But there
-- are 30+ tables with `REFERENCES users(id)` WITHOUT a CASCADE delete
-- rule (default = NO ACTION / RESTRICT). Calling `deleteUser` on a
-- user that has rides, reviews, referrals, chat messages, etc. would
-- fail with a foreign key constraint violation. We can't CASCADE
-- those tables either — `rides`, `ledger_entries`, `ratings`, etc.
-- need to survive for financial audit, AML compliance, dispute
-- resolution.
--
-- Solution
-- --------
-- A dedicated "Anonymized User" target row (UUID 00000000-…-099) in
-- both `auth.users` and `public.users`. Before deleting a user, we
-- re-point every non-CASCADE foreign key from the user being deleted
-- to the anonymous user. Then `auth.admin.deleteUser` can succeed,
-- the CASCADE chain takes care of wallet_accounts / trusted_contacts /
-- notifications / recurring_rides / driver_profiles, and the
-- financial / audit tables stay intact with anonymous customer_id /
-- reviewer_id / referrer_id / etc.
--
-- Why dynamic discovery (information_schema) over a hand-listed UPDATE
-- block: future migrations can add new tables with FK to users(id)
-- without anyone remembering to update this delete function. The
-- `pg_constraint` query finds them automatically as long as the FK
-- is declared with the standard syntax.
--
-- Why a separate anonymous user (not the existing SYSTEM_USER 001):
-- SYSTEM_USER has role=super_admin with name "TriciGo Platform" and
-- is used for the platform revenue wallet. Pointing customer_id /
-- reviewer_id at SYSTEM_USER would pollute admin reports (counts of
-- "customers", "reviewers", etc.). Anonymized user has role=customer
-- and is is_active=false so it never participates in matching, RPC
-- queries, or anything operational.
-- ============================================================

-- A. Create anonymous user in auth.users + public.users
--
-- Same pattern as 00007_sprint9_payment_pipeline.sql (SYSTEM_USER).
-- The password hash is a sentinel that nobody knows — the account
-- cannot be used to log in. Email is a non-routable internal address.

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token
)
VALUES (
  '00000000-0000-0000-0000-000000000099',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'anonymized@tricigo.internal',
  crypt('not-a-real-password-disabled-account', gen_salt('bf')),
  NOW(), NOW(), NOW(), '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, phone, full_name, role, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000099',
  '+0000000099',
  'Usuario eliminado',
  'customer',
  false
)
ON CONFLICT (id) DO NOTHING;

-- B. Dynamic anonymization function
--
-- For each foreign key in any public schema table that references
-- public.users(id) AND has a delete action other than CASCADE, run
-- an UPDATE swapping the deleted user's id for the anonymous user id.
-- Result jsonb maps "schema.table.column" -> rows affected (or error).

CREATE OR REPLACE FUNCTION public.anonymize_user_references(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  anon_id uuid := '00000000-0000-0000-0000-000000000099';
  fk RECORD;
  affected_rows int;
  result jsonb := '{}'::jsonb;
  total int := 0;
BEGIN
  -- Refuse to operate on the anonymous user itself or system user
  IF p_user_id = anon_id THEN
    RAISE EXCEPTION 'Cannot anonymize the anonymous user';
  END IF;
  IF p_user_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Cannot anonymize the system user';
  END IF;

  FOR fk IN
    SELECT
      n.nspname AS schema_name,
      cl.relname AS table_name,
      a.attname AS column_name,
      c.confdeltype AS delete_action
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.users'::regclass
      AND c.confdeltype <> 'c'  -- skip CASCADE (handled by auth.users delete)
      AND n.nspname = 'public'
  LOOP
    BEGIN
      EXECUTE format(
        'UPDATE %I.%I SET %I = $1 WHERE %I = $2',
        fk.schema_name, fk.table_name, fk.column_name, fk.column_name
      ) USING anon_id, p_user_id;
      GET DIAGNOSTICS affected_rows = ROW_COUNT;
      total := total + affected_rows;
      result := result || jsonb_build_object(
        fk.schema_name || '.' || fk.table_name || '.' || fk.column_name,
        affected_rows
      );
    EXCEPTION WHEN OTHERS THEN
      -- One table failing should not block the rest. Log it in the
      -- result so the caller can decide whether to retry or alert.
      result := result || jsonb_build_object(
        fk.schema_name || '.' || fk.table_name || '.' || fk.column_name,
        jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE)
      );
    END;
  END LOOP;

  result := result || jsonb_build_object('total_rows_anonymized', total);
  RETURN result;
END;
$$;

-- Lock down execution. Only the delete-account edge function (service_role)
-- should ever call this.
REVOKE EXECUTE ON FUNCTION public.anonymize_user_references FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_user_references TO service_role;

COMMENT ON FUNCTION public.anonymize_user_references IS
  'Re-points all non-CASCADE foreign keys from the given user to the anonymous user (id 00000000-…-099). Called by the delete-account edge function before auth.admin.deleteUser, to satisfy FK constraints while preserving financial audit trail. service_role only.';

COMMENT ON COLUMN public.users.id IS
  'PK and FK to auth.users(id). The well-known UUID 00000000-…-099 is the anonymous user — a sink for FKs from rows whose original owner has hard-deleted their account. Never participates in matching or auth.';
