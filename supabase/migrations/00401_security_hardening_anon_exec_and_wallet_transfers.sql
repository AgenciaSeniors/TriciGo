-- ============================================================================
-- 00401 — Security hardening: anon-exec writers + wallet_transfers spoof (P3)
-- ============================================================================
-- Audit pass #2 (2026-06-10), approved P3 security hardening.
--
-- (1) anon-executable SECDEF WRITERS. The security advisor flagged 34 SECDEF
--     functions executable by anon. Most are legitimate public reads (guest
--     search, shared-ride tokens). These four WRITE (directly or via a nested
--     dispatch) and have NO client callers — they are only invoked by triggers
--     / other SECDEF functions, which run in the definer's context and do NOT
--     consult the caller's EXECUTE grant. So locking them away from
--     anon/authenticated/PUBLIC is safe and removes a pre-auth write surface:
--       * apply_user_rating(uuid)      — UPDATEs users.rating_avg
--       * recompute_user_level(uuid)   — UPDATEs users.level/total_rides
--       * calculate_wait_charge(uuid)  — UPDATEs rides.wait_time_charge_cup
--       * dispatch_searching_rides_for_driver(uuid) — creates ride_offers (proxy)
--
-- (2) wallet_transfers direct-INSERT spoof. The RLS INSERT policy "Users can
--     insert own transfers" (WITH CHECK auth.uid()=from_user_id) let any user
--     INSERT a wallet_transfers row directly — a fake "gift received" in the
--     recipient's history (display-only; no money moves, that's the ledger).
--     The only legit writer is send_gift() (SECURITY DEFINER → bypasses RLS),
--     and no app code inserts directly. Dropping the user INSERT policy closes
--     the spoof; admins (ALL policy) + service-role + send_gift still write.
--
-- NOT applied to prod yet (MCP guard).
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.apply_user_rating(uuid)                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_user_level(uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_wait_charge(uuid)                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_searching_rides_for_driver(uuid)     FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Users can insert own transfers" ON public.wallet_transfers;
