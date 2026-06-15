-- 00439_account_deletion_settle_and_scrub.sql
-- ============================================================================
-- Pre-launch audit round 8 — PR-B: account-deletion completeness.
--
-- DIC-03 (P2, user decision = auto-zero): on account deletion, wallet_accounts.user_id
-- is ON DELETE SET NULL (mig 00422), so a deleted user's positive balance is left in a
-- userless, unreachable wallet — orphaned money with no audit trail. Fix: before the
-- user is deleted, move any non-zero balance to platform_revenue with a proper
-- double-entry ledger transaction (auditable unclaimed-funds record).
--
-- PII-02 (P3, GDPR): the deletion flow only re-points FK ids to the anon user; it never
-- scrubs the free text the user authored. Fix: overwrite/NULL the user's authored
-- free-text (chat, review comments, incident/ticket descriptions) before anonymize
-- re-points the author FK.
--
-- This RPC is invoked by the delete-account Edge Function BEFORE
-- anonymize_user_references (so author FKs still point at the real user) and BEFORE
-- auth.admin.deleteUser. It is idempotent (per-account ledger idempotency_key; the
-- scrub UPDATEs are no-ops once the rows are scrubbed / re-pointed).
--
-- NOTE: rides.pickup_address / dropoff_address are intentionally NOT scrubbed here —
-- the rides table has many BEFORE UPDATE triggers (active-city enforcement, coord
-- sync, transition guard) that a bare address overwrite would fire; and the ride is
-- already de-identified by anonymize (customer_id -> anon). Deferred as a careful
-- follow-up if address scrubbing becomes a requirement.
-- ============================================================================

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
  -- Never settle/scrub the system or anonymous accounts.
  IF p_user_id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099') THEN
    RAISE EXCEPTION 'cannot settle a system account';
  END IF;

  -- ── DIC-03: move any non-zero wallet balance to platform_revenue (double-entry) ──
  v_platform_acct := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_revenue');

  FOR v_acct IN
    SELECT id, balance FROM wallet_accounts WHERE user_id = p_user_id AND balance <> 0 FOR UPDATE
  LOOP
    -- idempotency: skip if this account was already settled.
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

    -- debit the user wallet to zero
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_tx, v_acct.id, -v_acct.balance, 0);
    UPDATE wallet_accounts SET balance = 0 WHERE id = v_acct.id;

    -- credit platform_revenue
    SELECT balance INTO v_plat_balance FROM wallet_accounts WHERE id = v_platform_acct FOR UPDATE;
    UPDATE wallet_accounts SET balance = balance + v_acct.balance WHERE id = v_platform_acct;
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_tx, v_platform_acct, v_acct.balance, v_plat_balance + v_acct.balance);

    v_zeroed := v_zeroed + 1;
  END LOOP;

  -- ── PII-02: scrub free text authored by the deleting user ──
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

-- Only the service role (the delete-account EF) may call this.
REVOKE ALL ON FUNCTION public.settle_and_scrub_for_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_and_scrub_for_deletion(uuid) TO service_role;
