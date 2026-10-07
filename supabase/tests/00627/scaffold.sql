-- Scaffold for the 00627 rehearsal: the seven money tables with the columns the
-- policies and approve_wallet_recharge use, prod's grants (everything to anon,
-- authenticated and service_role), prod's RLS policies on them as LIVE on
-- 2026-10-07, and the LIVE bodies of is_admin, current_user_role,
-- ensure_wallet_account and approve_wallet_recharge (md5/length checked by S0).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- A non-superuser (tricigo_owner) owns everything, like postgres in prod.
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

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer','driver','admin','super_admin');
CREATE TYPE public.ledger_entry_type AS ENUM ('recharge','ride_payment','ride_hold','ride_hold_release','commission','transfer_in','transfer_out','promo_credit','redemption','adjustment','insurance_premium','refund','quota_deduction','quota_recharge','fx_revaluation');
CREATE TYPE public.ledger_transaction_status AS ENUM ('pending','posted','archived','reversed');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash','driver_cash','driver_hold','platform_revenue','platform_promotions','corporate_cash','driver_quota','tricicoin','platform_fx_reserve');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer'
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_own ON public.users FOR SELECT USING (id = (SELECT auth.uid()));

CREATE TABLE public.wallet_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TRC'::text,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  anchor_usd_cents numeric,
  unbacked_cup integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type)
);
CREATE TABLE public.ledger_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  type public.ledger_entry_type NOT NULL,
  status public.ledger_transaction_status NOT NULL DEFAULT 'pending'::ledger_transaction_status,
  reference_type text,
  reference_id uuid,
  description text NOT NULL DEFAULT ''::text,
  metadata jsonb,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.ledger_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.wallet_transfers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user_id uuid,
  to_user_id uuid NOT NULL,
  amount integer NOT NULL,
  note text,
  transaction_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  kind text NOT NULL DEFAULT 'gift'::text
);
CREATE TABLE public.payment_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  amount_cup integer NOT NULL,
  status text NOT NULL DEFAULT 'created'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.wallet_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  payment_intent_id uuid NOT NULL,
  receipt_no text NOT NULL,
  tc_credited numeric NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.wallet_recharge_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  amount integer NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  processed_by uuid,
  processed_at timestamp with time zone,
  rejection_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Prod's grants on all seven: every privilege to anon, authenticated, service_role.
GRANT ALL ON public.users, public.wallet_accounts, public.ledger_transactions, public.ledger_entries,
  public.wallet_transfers, public.payment_intents, public.wallet_receipts, public.wallet_recharge_requests
  TO anon, authenticated, service_role;

ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_recharge_requests ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

-- Live policies (pg_policy on 2026-10-07). Roles {} = PUBLIC.
CREATE POLICY wa_admin ON public.wallet_accounts USING (is_admin());
CREATE POLICY wa_select ON public.wallet_accounts FOR SELECT USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY le_insert_admin ON public.ledger_entries FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY le_select ON public.ledger_entries FOR SELECT USING (((account_id IN ( SELECT wallet_accounts.id
   FROM wallet_accounts
  WHERE (wallet_accounts.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));
CREATE POLICY lt_insert_admin ON public.ledger_transactions FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY lt_select ON public.ledger_transactions FOR SELECT USING (((created_by = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY pi_admin_all ON public.payment_intents USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY pi_own_insert ON public.payment_intents FOR INSERT WITH CHECK ((user_id = auth.uid()));
CREATE POLICY pi_own_select ON public.payment_intents FOR SELECT USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))))));
CREATE POLICY wallet_receipts_admin_all ON public.wallet_receipts USING (is_admin());
CREATE POLICY wallet_receipts_user_read ON public.wallet_receipts FOR SELECT USING ((user_id = auth.uid()));
CREATE POLICY wrr_admin ON public.wallet_recharge_requests USING (is_admin());
CREATE POLICY wrr_own_insert ON public.wallet_recharge_requests FOR INSERT WITH CHECK ((user_id = auth.uid()));
CREATE POLICY wrr_own_select ON public.wallet_recharge_requests FOR SELECT USING (((user_id = auth.uid()) OR is_admin()));
CREATE POLICY "Admins full access wallet_transfers" ON public.wallet_transfers USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY "Users can see own transfers" ON public.wallet_transfers FOR SELECT USING (((auth.uid() = from_user_id) OR (auth.uid() = to_user_id)));

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
$function$
;

CREATE OR REPLACE FUNCTION public.approve_wallet_recharge(p_request_id uuid, p_admin_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_req RECORD; v_account_id UUID; v_current_balance INTEGER;
  v_txn_id UUID; v_idempotency_key TEXT;
BEGIN
  IF auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required (and p_admin_id must match caller)';
  END IF;

  SELECT * INTO v_req FROM wallet_recharge_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Recharge request not found: %', p_request_id; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Recharge request % is not pending (status: %)', p_request_id, v_req.status;
  END IF;
  IF v_req.amount <= 0 THEN RAISE EXCEPTION 'Recharge amount must be positive, got %', v_req.amount; END IF;

  v_idempotency_key := 'recharge:' || p_request_id::TEXT;
  SELECT id INTO v_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_txn_id IS NOT NULL THEN
    UPDATE wallet_recharge_requests SET status='approved', processed_by=p_admin_id,
           processed_at=COALESCE(processed_at, NOW())
    WHERE id = p_request_id;
    RETURN v_txn_id;
  END IF;

  v_account_id := ensure_wallet_account(v_req.user_id, 'customer_cash');
  SELECT balance INTO v_current_balance FROM wallet_accounts WHERE id = v_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES (v_idempotency_key, 'recharge', 'posted', 'recharge_request', p_request_id,
          'Recarga wallet #' || LEFT(p_request_id::TEXT, 8), p_admin_id)
  RETURNING id INTO v_txn_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_req.amount, v_current_balance + v_req.amount);
  UPDATE wallet_accounts SET balance = v_current_balance + v_req.amount, updated_at = NOW()
  WHERE id = v_account_id;
  UPDATE wallet_recharge_requests SET status='approved', processed_by=p_admin_id, processed_at=NOW()
  WHERE id = p_request_id;
  RETURN v_txn_id;
END;
$function$
;
REVOKE EXECUTE ON FUNCTION public.approve_wallet_recharge(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_wallet_recharge(uuid, uuid) TO authenticated, service_role;

RESET ROLE;
