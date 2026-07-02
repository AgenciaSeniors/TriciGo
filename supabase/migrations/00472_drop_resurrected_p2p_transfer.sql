-- ============================================================================
-- 00472 — DB hygiene: drop the resurrected transfer_wallet_p2p + pin
--         set_updated_at search_path
-- ============================================================================
-- Context (launch-readiness audit 2026-07-01):
--
-- 1) transfer_wallet_p2p was removed by 00274_remove_p2p_transfer.sql
--    (e-money risk decision), and gifts later returned deliberately as the
--    closed-loop send_gift RPC (00343-00346) with its own controls
--    (kind='gift', admin reversal, role-aware wallet routing).
--    The Supabase security advisors flagged that transfer_wallet_p2p is ALIVE
--    in prod again (same signature 00274 dropped — recreated by hand or via a
--    manual re-apply of 00211). It carries the hardened caller gates from
--    00211 (is_admin() OR auth.uid() = p_from_user_id), so it is not a
--    vulnerability, but it is a parallel P2P money channel without the gift
--    controls, and the repo says it must not exist. Zero callers in the
--    codebase (walletService uses send_gift).
--
-- 2) public.set_updated_at() was the only function flagged by the
--    function_search_path_mutable advisor. Pin its search_path.
--
-- Both statements are idempotent / safe on a fresh DB.

DROP FUNCTION IF EXISTS public.transfer_wallet_p2p(uuid, uuid, integer, text);

DO $$
BEGIN
  ALTER FUNCTION public.set_updated_at() SET search_path = public;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'public.set_updated_at() absent; skipping search_path pin';
END $$;
