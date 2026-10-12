-- ============================================================
-- 00657 — account deletion: all or nothing, and not while something is open
--
-- Measured in prod on 2026-10-11, inside a rolled-back block, with two real
-- drivers that were both referred:
--   * delete-account settles the wallet (settle_and_scrub_for_deletion), then
--     re-points every reference to the anonymous user …0099
--     (anonymize_user_references), then asks GoTrue to delete the auth user.
--     Each step is its own transaction.
--   * anonymize_user_references catches a failed UPDATE per column and moves on.
--     referrals.referee_id is UNIQUE, so the first referee who deletes the
--     account moves the row to …0099 and the second one hits 23505: the row keeps
--     pointing at the user, GoTrue cannot delete the auth user (the FK has no
--     ON DELETE action) and the function answers 500. By then the wallet was
--     already moved to platform_revenue: the second driver went from 11,000 CUP
--     to 0 and kept a live account that can never be deleted. There are 30
--     referrals in prod. promotion_uses (promotion, user), corporate_employees
--     (company, user) and reviews (ride, reviewer) have the same kind of unique
--     key.
--   * Nothing looked at what the account still had going on. A rider or driver
--     could delete mid-ride (the ride kept running with the anonymous rider or
--     with no driver), a driver accused in an open report or dispute could wipe
--     their identity, a negative balance (commission debt) was left without an
--     owner, and a recharge still being paid would be credited to …0099.
--
-- The rule (decided with the owner on 2026-10-11):
--   * The four unique keys ignore the anonymous user, so any number of deleted
--     accounts can point there.
--   * prepare_account_deletion(user) runs the gates, the settlement and the
--     anonymization in ONE transaction, and fails if any reference could not be
--     moved. The Edge Functions call it before asking GoTrue to delete the user,
--     so a failure leaves the account, its money and its history as they were.
--   * It refuses, with a Spanish MESSAGE and a code in DETAIL, while the account:
--       - is part of a ride that is not over (as rider, as driver, or as an
--         invited payer who accepted), scheduled rides included
--         (deletion_active_ride);
--       - is accused in an open incident, or is a party to an open dispute
--         (deletion_open_case);
--       - owes money: any wallet below zero (deletion_debt);
--       - has a payment that started in the last two hours and has not finished
--         (deletion_payment_pending).
--   * Driver documents, vehicle and trip GPS are still deleted at once, as before
--     (owner's decision).
--
-- Rehearsal: supabase/tests/00657/run.sh.
-- ============================================================

SET lock_timeout = '5s';

-- ── Unique keys that ignore the anonymous user ──────────────────────────
-- No foreign key depends on these constraints and no function or app writes
-- with ON CONFLICT on them (checked in prod on 2026-10-11).
ALTER TABLE public.referrals DROP CONSTRAINT IF EXISTS referrals_referee_id_key;
DROP INDEX IF EXISTS public.referrals_referee_id_key;
CREATE UNIQUE INDEX referrals_referee_id_key ON public.referrals (referee_id)
  WHERE referee_id <> '00000000-0000-0000-0000-000000000099'::uuid;

ALTER TABLE public.promotion_uses DROP CONSTRAINT IF EXISTS promotion_uses_promotion_id_user_id_key;
DROP INDEX IF EXISTS public.promotion_uses_promotion_id_user_id_key;
CREATE UNIQUE INDEX promotion_uses_promotion_id_user_id_key ON public.promotion_uses (promotion_id, user_id)
  WHERE user_id <> '00000000-0000-0000-0000-000000000099'::uuid;

ALTER TABLE public.corporate_employees DROP CONSTRAINT IF EXISTS corporate_employees_corporate_account_id_user_id_key;
DROP INDEX IF EXISTS public.corporate_employees_corporate_account_id_user_id_key;
CREATE UNIQUE INDEX corporate_employees_corporate_account_id_user_id_key ON public.corporate_employees (corporate_account_id, user_id)
  WHERE user_id <> '00000000-0000-0000-0000-000000000099'::uuid;

-- reviews had the same key twice (a constraint and a plain index).
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS reviews_ride_id_reviewer_id_key;
DROP INDEX IF EXISTS public.reviews_ride_id_reviewer_id_key;
DROP INDEX IF EXISTS public.uniq_reviews_ride_reviewer;
CREATE UNIQUE INDEX reviews_ride_id_reviewer_id_key ON public.reviews (ride_id, reviewer_id)
  WHERE reviewer_id <> '00000000-0000-0000-0000-000000000099'::uuid;

RESET lock_timeout;

-- ── prepare_account_deletion ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_anon constant uuid := '00000000-0000-0000-0000-000000000099';
  c_platform constant uuid := '00000000-0000-0000-0000-000000000001';
  v_debt bigint;
  v_settled jsonb;
  v_anonymized jsonb;
  v_failed text;
BEGIN
  IF p_user_id IS NULL OR p_user_id IN (c_anon, c_platform) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Esta cuenta no se puede eliminar.',
      DETAIL = 'deletion_system_account';
  END IF;

  -- Two deletions of the same account run one after the other.
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.rides r
     WHERE r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                        'in_progress', 'arrived_at_destination')
       AND (r.customer_id = p_user_id
            OR r.driver_id IN (SELECT dp.id FROM public.driver_profiles dp WHERE dp.user_id = p_user_id)
            OR EXISTS (SELECT 1 FROM public.ride_splits s
                        WHERE s.ride_id = r.id AND s.user_id = p_user_id AND s.accepted_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Tienes un viaje en curso o programado. Termínalo o cancélalo antes de eliminar tu cuenta.',
      DETAIL = 'deletion_active_ride';
  END IF;

  IF EXISTS (SELECT 1 FROM public.incident_reports i
              WHERE i.against_user_id = p_user_id AND i.status IN ('open', 'investigating'))
     OR EXISTS (SELECT 1 FROM public.ride_disputes d
                 WHERE (d.opened_by = p_user_id OR d.respondent_id = p_user_id)
                   AND d.resolved_at IS NULL
                   AND d.status IN ('open', 'under_review', 'escalated')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Tienes un reporte o una disputa abierta. Escríbenos a soporte para cerrarla antes de eliminar tu cuenta.',
      DETAIL = 'deletion_open_case';
  END IF;

  SELECT -sum(w.balance) INTO v_debt
    FROM public.wallet_accounts w
   WHERE w.user_id = p_user_id AND w.balance < 0;
  IF v_debt > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('Tienes una deuda de %s CUP con TriciGo. Págala antes de eliminar tu cuenta.', v_debt),
      DETAIL = 'deletion_debt';
  END IF;

  IF EXISTS (SELECT 1 FROM public.payment_intents pi
              WHERE pi.user_id = p_user_id
                AND pi.status IN ('created', 'pending', 'processing')
                AND pi.created_at > now() - interval '2 hours') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Tienes un pago en proceso. Espera unos minutos e inténtalo de nuevo.',
      DETAIL = 'deletion_payment_pending';
  END IF;

  v_settled := public.settle_and_scrub_for_deletion(p_user_id);
  v_anonymized := public.anonymize_user_references(p_user_id);

  -- anonymize_user_references reports a failed column instead of raising. Any
  -- failure undoes the settlement and the anonymization too.
  SELECT string_agg(e.key, ', ' ORDER BY e.key) INTO v_failed
    FROM jsonb_each(v_anonymized) e
   WHERE jsonb_typeof(e.value) = 'object' AND e.value ? 'error';
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No pudimos eliminar tu cuenta. Escríbenos a soporte.',
      DETAIL = 'deletion_incomplete',
      HINT = v_failed;
  END IF;

  RETURN jsonb_build_object('settled', v_settled, 'anonymized', v_anonymized);
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO service_role;

COMMENT ON FUNCTION public.prepare_account_deletion(uuid) IS
  '00657: gates, settlement and anonymization of an account in one transaction. '
  'The delete-account and admin-delete-pending-account Edge Functions call it before '
  'GoTrue deletes the auth user. Errors carry a Spanish MESSAGE and DETAIL deletion_*.';

-- ── verification ─────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(e.idx, ', ') INTO v_bad
    FROM (VALUES ('referrals_referee_id_key'),
                 ('promotion_uses_promotion_id_user_id_key'),
                 ('corporate_employees_corporate_account_id_user_id_key'),
                 ('reviews_ride_id_reviewer_id_key')) AS e(idx)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.' || e.idx)
        AND i.indisunique
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%00000000-0000-0000-0000-000000000099%');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00657: unique keys without the anonymous-user exception: %', v_bad;
  END IF;

  IF to_regclass('public.uniq_reviews_ride_reviewer') IS NOT NULL THEN
    RAISE EXCEPTION '00657: uniq_reviews_ride_reviewer still exists';
  END IF;

  IF has_function_privilege('anon', 'public.prepare_account_deletion(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.prepare_account_deletion(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00657: prepare_account_deletion is executable by clients';
  END IF;
END
$verify$;
