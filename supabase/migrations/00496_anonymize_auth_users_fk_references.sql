-- 00496_anonymize_auth_users_fk_references.sql
-- ============================================================================
-- Account hard-delete completeness — cover the auth.users-referencing FKs.
--
-- Problem (verified 2026-07-13)
-- -----------------------------
-- `anonymize_user_references` (00287, hardened in 00422) re-points every
-- non-CASCADE foreign key **that references public.users(id)** to the anon
-- user before `auth.admin.deleteUser` runs. But six tables reference
-- `auth.users(id)` DIRECTLY (a schema anomaly vs the app-wide convention of
-- FK -> public.users), all with delete rule NO ACTION:
--
--     campaigns.created_by
--     email_sends.user_id
--     lost_items.driver_id / reporter_id / resolved_by
--     ride_disputes.assigned_to / opened_by / respondent_id
--     ride_splits.invited_by / user_id
--     validation_events.driver_id
--
-- The public.users loop never touches these (its cursor filters
-- `confrelid = 'public.users'::regclass`). So when the delete-account Edge
-- Function reaches step 4 (`auth.admin.deleteUser`, which deletes the
-- auth.users row), any of these NO ACTION FKs that still points at the user
-- blocks the DELETE with a foreign-key violation. The account is left
-- ANONYMIZED-BUT-NOT-DELETED (settle_and_scrub + the public.users re-points
-- already ran) and the EF returns `deletion_failed`. That breaks the
-- Apple/Google-required "Delete my account" flow.
--
-- Severity (prod, 2026-07-13)
-- ---------------------------
-- Over 130 real users:
--   email_sends       53 rows / 53 distinct real users  (~41% of all users)
--   validation_events 11 rows /  4 distinct drivers
--   campaigns          2 rows /  1 distinct admin
--   lost_items / ride_disputes / ride_splits: 0 rows today (latent)
-- email_sends logs one row per transactional email, so this trends toward
-- ~100% of users — account deletion is already broken for the plurality and
-- getting worse. This is the blocking one; the rest are latent.
--
-- Policy decision — anonymize (re-point to anon), NOT an FK-rule change
-- --------------------------------------------------------------------
-- All 11 columns are re-pointed to the anon user (00000000-…-099), which
-- exists in BOTH auth.users and public.users, so the FK is satisfied. We
-- deliberately do NOT switch these FKs to ON DELETE SET NULL / CASCADE:
--   * 5 of the 11 columns are NOT NULL (lost_items.reporter_id,
--     lost_items.driver_id, ride_disputes.opened_by, ride_splits.user_id,
--     ride_splits.invited_by) — SET NULL is impossible without dropping
--     NOT NULL, a schema/semantic change that risks app queries.
--   * These are audit / operational / compliance records (disputes, lost-item
--     claims, driver validation events, marketing campaigns, split-payment
--     invites) that must survive the actor's deletion — CASCADE would destroy
--     the audit trail.
--   * Re-pointing to anon is exactly the blessed pattern this function already
--     applies to the public.users FKs; it keeps the record, drops the identity.
--   * email_sends stores NO PII (only `template`, `sent_at`), so re-pointing
--     user_id -> anon leaves zero residual PII; nothing else to scrub.
--
-- Collision safety
-- ----------------
-- Only ride_splits has a UNIQUE over a re-pointed column: UNIQUE(ride_id,
-- user_id). If two participants of the SAME ride both delete their accounts,
-- the second re-point would collide with the anon row left by the first. The
-- new loop catches `unique_violation` and falls back to DELETE the residual
-- rows, so the FK is always cleared and the auth.users delete never blocks.
-- (ride_splits has 0 rows today; this is future-proofing for group split.)
--
-- Why a dynamic second loop (not a hand-listed UPDATE block)
-- ---------------------------------------------------------
-- Same rationale as 00287's public.users loop: a future migration can add a
-- table with a direct auth.users FK without anyone remembering to update this
-- function. The pg_constraint cursor (confrelid = auth.users, confdeltype IN
-- ('a','r') = NO ACTION / RESTRICT, public schema only) discovers them
-- automatically. We restrict to blocking delete rules only: SET NULL ('n') /
-- SET DEFAULT ('d') auto-resolve on delete, and re-pointing them to anon would
-- wrongly change their post-delete value.
--
-- Deployment notes
-- ----------------
-- * MCP guard: this migration is NOT applied to prod here. Apply via the deploy
--   pipeline / `supabase db push` or with explicit per-apply authorization.
-- * No client/frontend change: `anonymize_user_references` is invoked only by
--   the service-role delete-account Edge Function, which is unchanged. Before
--   this fix the EF's auth.admin.deleteUser failed; after it, it succeeds.
-- * Idempotent: UPDATEs that affect 0 rows are no-ops; safe to re-run.
-- * The public.users loop below is reproduced VERBATIM from the live prod
--   function (matches 00422); only the auth.users loop is added.
-- ============================================================================

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

  -- ── Loop 1: FKs referencing public.users(id) (verbatim from 00422) ──
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
      AND cl.relname <> 'wallet_accounts'
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

  -- ── Loop 2: FKs referencing auth.users(id) directly (00496) ──
  -- These are the anomalous tables whose FK targets auth.users, not
  -- public.users. Without re-pointing them, auth.admin.deleteUser is blocked.
  -- Restrict to public schema + blocking delete rules only ('a' NO ACTION /
  -- 'r' RESTRICT); never touch auth-internal tables.
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
      AND c.confrelid = 'auth.users'::regclass
      AND c.confdeltype IN ('a', 'r')
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
    EXCEPTION
      WHEN unique_violation THEN
        -- A UNIQUE that includes this column already holds an anon row for the
        -- same key (e.g. ride_splits UNIQUE(ride_id, user_id) when two
        -- same-ride participants are both deleted). Re-pointing is impossible;
        -- delete the residual rows so the FK no longer blocks the auth delete.
        BEGIN
          EXECUTE format(
            'DELETE FROM %I.%I WHERE %I = $1',
            fk.schema_name, fk.table_name, fk.column_name
          ) USING p_user_id;
          GET DIAGNOSTICS affected_rows = ROW_COUNT;
          result := result || jsonb_build_object(
            fk.schema_name || '.' || fk.table_name || '.' || fk.column_name,
            jsonb_build_object('deleted_on_unique_conflict', affected_rows)
          );
        EXCEPTION WHEN OTHERS THEN
          result := result || jsonb_build_object(
            fk.schema_name || '.' || fk.table_name || '.' || fk.column_name,
            jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE)
          );
        END;
      WHEN OTHERS THEN
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

-- Re-assert lockdown (idempotent; CREATE OR REPLACE preserves grants, but keep
-- it explicit to match 00287). service_role only — the delete-account EF.
REVOKE ALL ON FUNCTION public.anonymize_user_references(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_user_references(uuid) TO service_role;

COMMENT ON FUNCTION public.anonymize_user_references(uuid) IS
  'Re-points every non-CASCADE foreign key from the given user to the anonymous user (00000000-…-099), covering FKs to BOTH public.users and auth.users(id) (00496). Called by the delete-account Edge Function before auth.admin.deleteUser to satisfy FK constraints while preserving the financial/audit trail. ride_splits UNIQUE(ride_id,user_id) collisions fall back to DELETE. service_role only.';
