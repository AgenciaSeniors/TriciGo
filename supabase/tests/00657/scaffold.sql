-- Scaffold for the 00657 rehearsal. The tables that account deletion touches,
-- with prod's foreign keys (ON DELETE actions) and unique keys, read from prod on
-- 2026-10-11. settle_and_scrub_for_deletion, anonymize_user_references and
-- ensure_wallet_account are copied byte for byte from pg_get_functiondef in prod
-- (md5 of each body noted next to it). A NON-superuser role (prod: postgres) owns
-- everything; run.sh applies the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');
CREATE TYPE public.ledger_entry_type AS ENUM ('ride_payment', 'adjustment', 'recharge', 'transfer_in', 'transfer_out');
CREATE TYPE public.ledger_transaction_status AS ENUM ('pending', 'posted', 'reversed');
CREATE TYPE public.incident_status AS ENUM ('open', 'investigating', 'resolved', 'dismissed');

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY, phone text);

CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'));
END;
$function$;

-- Cascades with the account (prod: trusted_contacts and many more).
CREATE TABLE public.trusted_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  phone text
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id) ON DELETE SET NULL,
  status public.ride_status NOT NULL DEFAULT 'searching',
  is_scheduled boolean DEFAULT false,
  scheduled_notified boolean DEFAULT false
);
CREATE UNIQUE INDEX rides_one_active_per_customer ON public.rides USING btree (customer_id) WHERE ((status = ANY (ARRAY['searching'::ride_status, 'accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status, 'in_progress'::ride_status, 'arrived_at_destination'::ride_status])) AND (NOT (COALESCE(is_scheduled, false) AND (NOT COALESCE(scheduled_notified, false)))));

CREATE TABLE public.ride_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  share_pct numeric NOT NULL DEFAULT 50,
  accepted_at timestamptz,
  UNIQUE (ride_id, user_id)
);

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TRC',
  anchor_usd_cents bigint,
  UNIQUE (user_id, account_type)
);

CREATE TABLE public.ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,
  type public.ledger_entry_type NOT NULL,
  status public.ledger_transaction_status NOT NULL DEFAULT 'posted',
  reference_type text,
  reference_id uuid,
  description text,
  created_by uuid REFERENCES public.users(id)
);

CREATE TABLE public.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id),
  amount integer NOT NULL,
  balance_after integer NOT NULL
);

CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES public.users(id),
  referee_id uuid NOT NULL REFERENCES public.users(id),
  CONSTRAINT referrals_referee_id_key UNIQUE (referee_id)
);

CREATE TABLE public.promotions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text);
CREATE TABLE public.promotion_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  ride_id uuid REFERENCES public.rides(id),
  CONSTRAINT promotion_uses_promotion_id_user_id_key UNIQUE (promotion_id, user_id)
);

CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_by uuid);
CREATE TABLE public.corporate_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT corporate_employees_corporate_account_id_user_id_key UNIQUE (corporate_account_id, user_id)
);

CREATE TABLE public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  reviewer_id uuid NOT NULL REFERENCES public.users(id),
  reviewee_id uuid NOT NULL REFERENCES public.users(id),
  rating integer NOT NULL,
  comment text,
  CONSTRAINT reviews_ride_id_reviewer_id_key UNIQUE (ride_id, reviewer_id)
);
CREATE UNIQUE INDEX uniq_reviews_ride_reviewer ON public.reviews USING btree (ride_id, reviewer_id);

CREATE TABLE public.incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid REFERENCES public.rides(id),
  reported_by uuid NOT NULL REFERENCES public.users(id),
  against_user_id uuid REFERENCES public.users(id),
  resolved_by uuid REFERENCES public.users(id),
  status public.incident_status NOT NULL DEFAULT 'open',
  description text
);

CREATE TABLE public.ride_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  opened_by uuid NOT NULL REFERENCES auth.users(id),
  respondent_id uuid REFERENCES auth.users(id),
  assigned_to uuid REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'open'
    CHECK (status = ANY (ARRAY['open'::text, 'under_review'::text, 'resolved_rider'::text, 'resolved_driver'::text, 'escalated'::text, 'closed'::text])),
  resolved_at timestamptz
);

CREATE TABLE public.payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'created'
    CHECK (status = ANY (ARRAY['created'::text, 'pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'expired'::text, 'refunded'::text])),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Free text that settle_and_scrub_for_deletion overwrites.
CREATE TABLE public.ride_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid REFERENCES public.rides(id),
  sender_id uuid NOT NULL REFERENCES public.users(id),
  body text
);
CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  subject text, description text
);
CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES public.support_tickets(id),
  sender_id uuid NOT NULL REFERENCES public.users(id),
  message text
);

-- ensure_wallet_account (md5 of body 6f01c44a2ecd5afe0b625347b43c203f, 1678 chars)
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_type wallet_account_type DEFAULT 'customer_cash'::wallet_account_type)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id  UUID;
  v_uid UUID;
  v_ctx TEXT;
BEGIN
  -- 00591: a DIRECT call (PostgREST RPC from a signed-in, non-admin user)
  -- may only create the caller's own spendable accounts. Internal callers
  -- (send_gift, complete_ride_and_pay, admin_send_gift, the referral and
  -- corporate triggers, ...) are PL/pgSQL functions, so for them PG_CONTEXT
  -- carries at least one more frame below this one; a direct call has
  -- exactly one frame and therefore no newline. Service-role/cron callers
  -- have auth.uid() IS NULL and admins are exempt.
  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    IF position(E'\n' IN v_ctx) = 0 AND NOT is_admin() THEN
      IF p_user_id IS DISTINCT FROM v_uid
         OR p_type NOT IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN
        RAISE EXCEPTION 'forbidden: ensure_wallet_account may only create your own customer_cash, tricicoin or corporate_cash account'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency, anchor_usd_cents)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC',
            CASE WHEN p_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN 0 ELSE NULL END)
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) TO authenticated, service_role;

-- settle_and_scrub_for_deletion (md5 of body bdd55bcb414a9355487bb425c5aa27dc, 3093 chars)
CREATE OR REPLACE FUNCTION public.settle_and_scrub_for_deletion(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_platform_acct uuid;
  v_acct RECORD;
  v_tx uuid;
  v_plat_balance integer;
  v_zeroed integer := 0;
  v_scrubbed jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  IF p_user_id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099') THEN
    RAISE EXCEPTION 'cannot settle a system account';
  END IF;

  v_platform_acct := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_revenue');

  FOR v_acct IN
    SELECT id, balance FROM wallet_accounts WHERE user_id = p_user_id AND balance > 0 FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1 FROM ledger_transactions
      WHERE idempotency_key = 'account_deletion_zero:' || v_acct.id::text
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES ('account_deletion_zero:' || v_acct.id::text, 'adjustment', 'posted', 'account_deletion', p_user_id,
            'Saldo no reclamado movido a platform_revenue al borrar la cuenta',
            '00000000-0000-0000-0000-000000000001')
    RETURNING id INTO v_tx;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_tx, v_acct.id, -v_acct.balance, 0);
    UPDATE wallet_accounts SET balance = 0 WHERE id = v_acct.id;

    SELECT balance INTO v_plat_balance FROM wallet_accounts WHERE id = v_platform_acct FOR UPDATE;
    UPDATE wallet_accounts SET balance = balance + v_acct.balance WHERE id = v_platform_acct;
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_tx, v_platform_acct, v_acct.balance, v_plat_balance + v_acct.balance);

    v_zeroed := v_zeroed + 1;
  END LOOP;

  UPDATE ride_messages SET body = '[cuenta eliminada]' WHERE sender_id = p_user_id AND body IS NOT NULL AND body <> '[cuenta eliminada]';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('ride_messages', v_n);

  UPDATE reviews SET comment = NULL WHERE reviewer_id = p_user_id AND comment IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('reviews', v_n);

  UPDATE incident_reports SET description = '[cuenta eliminada]' WHERE reported_by = p_user_id AND description IS NOT NULL AND description <> '[cuenta eliminada]';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('incident_reports', v_n);

  UPDATE support_tickets SET subject = '[cuenta eliminada]', description = '[cuenta eliminada]' WHERE user_id = p_user_id AND (subject <> '[cuenta eliminada]' OR description <> '[cuenta eliminada]');
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('support_tickets', v_n);

  UPDATE ticket_messages SET message = '[cuenta eliminada]' WHERE sender_id = p_user_id AND message IS NOT NULL AND message <> '[cuenta eliminada]';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_scrubbed := v_scrubbed || jsonb_build_object('ticket_messages', v_n);

  RETURN jsonb_build_object('wallets_zeroed', v_zeroed, 'scrubbed', v_scrubbed);
END;
$function$;
REVOKE ALL ON FUNCTION public.settle_and_scrub_for_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_and_scrub_for_deletion(uuid) TO service_role;

-- anonymize_user_references (md5 of body eaa9e7adb090aed60d7b88b2e9ebb245, 3752 chars)
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

  -- Loop 1: FKs referencing public.users(id) (verbatim from 00422)
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

  -- Loop 2: FKs referencing auth.users(id) directly (00496)
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
REVOKE ALL ON FUNCTION public.anonymize_user_references(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.anonymize_user_references(uuid) TO service_role;

RESET ROLE;
