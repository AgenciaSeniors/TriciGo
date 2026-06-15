-- 00434_round7_insert_protect_class.sql
-- ============================================================================
-- Pre-launch audit round 7 — a SYSTEMIC authorization class: the *_protect_admin_fields
-- triggers are BEFORE UPDATE only, and several INSERT RLS policies / un-triggered
-- tables let an authenticated user self-set privileged columns at INSERT time
-- (or, for customer_profiles, at UPDATE with no protect trigger at all). Two of
-- these are P0 self-grants. All DB-only (no app rebuild). The legit onboarding
-- paths are preserved: each guard exempts admins (is_admin()), the service-role
-- seed (auth.uid() IS NULL), and the app.trusted_* recompute/approval flags.
--
-- KYC-01 (P0): dp_insert RLS only checks user_id=auth.uid(); the driver protect
-- trigger is UPDATE-only; there is no BEFORE INSERT guard. So a customer could
-- POST /driver_profiles { status:'approved' } → the AFTER INSERT
-- ensure_driver_role_and_tricicoin_on_approval grants role='driver' + a tricicoin
-- wallet; column defaults (match_score 50, is_financially_eligible true,
-- last_heartbeat_at NULL passes the freshness gate) make them immediately
-- dispatchable; they add an active vehicle and go online → a fully unverified,
-- zero-document, no-contract, no-admin-review driver accepts real rides.
--
-- FLEET-02 (P0): corporate_accounts protect trigger is UPDATE-only and
-- corporate_accounts_insert RLS only checks created_by=auth.uid(). So a non-admin
-- could self-INSERT an approved corporate account with commission_percent=0 (or
-- negative), is_fleet_owner=true and an arbitrary monthly_budget_trc — poisoning
-- the commission source that complete_ride_and_pay / the snapshot trigger read.
-- Today this is dead-ended only by the broken corporate_employees insert (FLEET-03);
-- fixing FLEET-03 (required — corporate onboarding is 100% broken) would unlock it,
-- so both are fixed here together.
--
-- FLEET-03 (P2): both corporate_employees INSERT policies reference
-- corporate_employees inside their own WITH CHECK via inline subqueries → Postgres
-- 42P17 infinite recursion → NO employee row can ever be inserted → corporate
-- onboarding non-functional. Rewritten using SECURITY DEFINER helpers
-- (is_corp_admin already exists; corp_has_no_employees added) which bypass RLS and
-- break the recursion.
--
-- RATING-01 (P2): customer_profiles has RLS but NO triggers; cp_update is
-- owner-scoped with no column guard. A customer could `UPDATE customer_profiles
-- SET rating_avg = 5.0` to erase the low-rating dispatch penalty (the only
-- system-maintained column on the table). Add a BEFORE UPDATE protect trigger that
-- reverts rating_avg unless the trusted recompute flag (apply_user_rating already
-- sets app.trusted_driver_update) or admin.
--
-- DEFERRED to a careful follow-up: FLEET-01 (fleet_members self-active membership)
-- — its fix must whitelist auto_link_fleet_member_on_signup / relink RPCs, and it
-- is gated behind FLEET-02 (an attacker now cannot get an approved corp), so it is
-- inert today. Plus the round-7 P3s (KYC-02/03, FLEET-04, RCHG-02, PUSH-01,
-- SCHED-01/02/03/05).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- KYC-01: BEFORE INSERT guard on driver_profiles.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Trusted paths may seed/approve freely.
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_driver_update', true) = '1' THEN RETURN NEW; END IF;

  -- Non-trusted self-onboarding: force the approval / ranking / money columns to
  -- their safe defaults regardless of submitted values. A new driver always starts
  -- pending_verification and offline; admin approval (is_admin path) sets the rest.
  NEW.status                  := 'pending_verification';
  NEW.is_online               := false;
  NEW.approved_at             := NULL;
  NEW.suspended_at            := NULL;
  NEW.suspended_reason        := NULL;
  NEW.is_financially_eligible := true;
  NEW.match_score             := 50.0;
  NEW.acceptance_rate         := 100.0;
  NEW.rating_avg              := 5.00;
  NEW.total_rides             := 0;
  NEW.total_rides_completed   := 0;
  NEW.total_rides_offered     := 0;
  NEW.quota_blocked           := false;
  NEW.custom_per_km_rate_cup  := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_profiles_protect_insert ON public.driver_profiles;
CREATE TRIGGER trg_driver_profiles_protect_insert
  BEFORE INSERT ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_protect_insert();

-- ─────────────────────────────────────────────────────────────────────────
-- FLEET-02: BEFORE INSERT guard on corporate_accounts + commission range CHECK.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_corporate_update', true) = '1' THEN RETURN NEW; END IF;

  -- Non-trusted self-creation: force pending + safe financials. Admin reviews and
  -- sets commission / fleet-owner / approval. monthly_budget_trc / name / contact
  -- stay as submitted (admin sees the request).
  NEW.status              := 'pending';
  NEW.is_fleet_owner      := false;
  NEW.commission_percent  := NULL;
  NEW.current_month_spent := 0;
  NEW.approved_at         := NULL;
  NEW.suspended_at        := NULL;
  NEW.suspended_reason    := NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_corporate_accounts_protect_insert ON public.corporate_accounts;
CREATE TRIGGER trg_corporate_accounts_protect_insert
  BEFORE INSERT ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_accounts_protect_insert();

-- Block negative / out-of-range commission at any write layer (NOT VALID so it
-- never fails on legacy rows; corporate_accounts is empty today anyway).
ALTER TABLE public.corporate_accounts
  DROP CONSTRAINT IF EXISTS corporate_accounts_commission_range;
ALTER TABLE public.corporate_accounts
  ADD CONSTRAINT corporate_accounts_commission_range
  CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100))
  NOT VALID;

-- ─────────────────────────────────────────────────────────────────────────
-- FLEET-03: break the corporate_employees INSERT-policy recursion (and thereby
-- re-enable corporate onboarding) using SECURITY DEFINER helpers.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.corp_has_no_employees(p_account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM corporate_employees WHERE corporate_account_id = p_account_id
  );
$function$;
GRANT EXECUTE ON FUNCTION public.corp_has_no_employees(uuid) TO authenticated;

-- Bootstrap: the corp creator adds THEMSELVES as the first active admin employee.
DROP POLICY IF EXISTS corporate_employees_bootstrap_creator ON public.corporate_employees;
CREATE POLICY corporate_employees_bootstrap_creator ON public.corporate_employees
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND role = 'admin'
    AND is_active = true
    AND EXISTS (
      SELECT 1 FROM corporate_accounts ca
      WHERE ca.id = corporate_account_id AND ca.created_by = (SELECT auth.uid())
    )
    AND public.corp_has_no_employees(corporate_account_id)
  );

-- Subsequent adds: an existing active corp admin (or a platform admin) may insert.
DROP POLICY IF EXISTS corporate_employees_corp_admin_insert ON public.corporate_employees;
CREATE POLICY corporate_employees_corp_admin_insert ON public.corporate_employees
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_corp_admin(corporate_account_id) OR is_admin()
  );

-- ─────────────────────────────────────────────────────────────────────────
-- RATING-01: BEFORE UPDATE guard so a customer cannot self-edit rating_avg.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_customer_profiles_protect_rating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- apply_user_rating (the reviews + cancellation-events recompute) sets this flag.
  IF current_setting('app.trusted_driver_update', true) = '1' THEN RETURN NEW; END IF;

  -- rating_avg is the only system-maintained column on customer_profiles; revert any
  -- non-trusted change (no-op when the update does not touch it). Everything else
  -- (saved_locations, ride_preferences, emergency_contact, default_payment_method)
  -- stays user-editable.
  NEW.rating_avg := OLD.rating_avg;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_customer_profiles_protect_rating ON public.customer_profiles;
CREATE TRIGGER trg_customer_profiles_protect_rating
  BEFORE UPDATE ON public.customer_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_customer_profiles_protect_rating();
