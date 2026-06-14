-- 00422_account_deletion_wallet_set_null.sql
-- ============================================================================
-- DIC-01 (P1, audit 2026-06-14): wallet_accounts.user_id FK is ON DELETE CASCADE.
-- The user-facing "Delete my account" flow (delete-account EF → auth.admin.deleteUser,
-- built for Apple/Google store compliance) cascades auth.users → public.users →
-- wallet_accounts. But ledger_entries is immutable (no-delete rule) and its
-- account_id FK is NO ACTION, so the wallet cascade has two bad outcomes:
--   (1) wallet WITH ledger entries → the cascade DELETE of the wallet is blocked
--       by the surviving ledger_entries → the whole deleteUser transaction ABORTS
--       → account deletion is BROKEN for every user who ever recharged/rode.
--   (2) wallet WITHOUT ledger entries but WITH a balance → the cascade silently
--       deletes the wallet → the balance is destroyed.
--
-- Fix: change the wallet FK to ON DELETE SET NULL (and make user_id nullable).
-- On user deletion the wallet survives as a userless, frozen row with its
-- immutable ledger intact (money history preserved; PII gone with the user; the
-- userless wallet matches no auth.uid() so it is invisible to all users). NULLs
-- do not collide in the UNIQUE(user_id, account_type) constraint, so any number
-- of deletions are safe, and the delete can never be blocked by ledger_entries.
--
-- anonymize_user_references re-points every NON-cascade users-FK to the anon
-- user. Re-pointing wallet_accounts to anon would violate UNIQUE(user_id,
-- account_type) on the 2nd+ deletion — so EXCLUDE wallet_accounts from that loop
-- and let the FK SET NULL be the sole, consistent handler.
--
-- Deferred (PII-02, P3): scrubbing self-authored free-text PII (addresses, review
-- comments, chat) on retained rows at deletion — tracked separately.
-- ============================================================================

-- 1) Wallet FK: CASCADE -> SET NULL (preserve wallet + immutable ledger).
ALTER TABLE public.wallet_accounts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.wallet_accounts DROP CONSTRAINT IF EXISTS wallet_accounts_user_id_fkey;
ALTER TABLE public.wallet_accounts
  ADD CONSTRAINT wallet_accounts_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

-- 2) Keep wallet_accounts out of the anonymize re-point loop (its FK is now
--    SET NULL, not cascade, so the loop would otherwise try to re-point it to the
--    anon user and hit the UNIQUE(user_id, account_type) constraint). Body
--    reproduced from the live prod function; only the loop's WHERE gains the
--    `cl.relname <> 'wallet_accounts'` exclusion.
CREATE OR REPLACE FUNCTION public.anonymize_user_references(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  anon_id uuid := '00000000-0000-0000-0000-000000000099';
  fk RECORD;
  affected_rows int;
  result jsonb := '{}'::jsonb;
  total int := 0;
BEGIN
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
      AND c.confdeltype <> 'c'
      AND cl.relname <> 'wallet_accounts'   -- 00422: FK is now SET NULL; do not re-point (UNIQUE(user_id,account_type) would collide)
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
      result := result || jsonb_build_object(
        fk.schema_name || '.' || fk.table_name || '.' || fk.column_name,
        jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE)
      );
    END;
  END LOOP;

  result := result || jsonb_build_object('total_rows_anonymized', total);
  RETURN result;
END;
$function$;
