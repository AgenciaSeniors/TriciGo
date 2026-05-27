-- ============================================================
-- 00328_notifications_type_check.sql
--
-- Defense-in-depth against cross-event template contamination on
-- the `notifications` inbox table (created by 00040). Today the
-- `type` column is `TEXT NOT NULL` with no constraint — any
-- caller can insert any string. Send-push is gated to service_role
-- + admin, so the risk is low in practice, but a typo'd category
-- (`'ride_completed'` instead of `'ride'`) silently breaks the
-- inbox deep-link without any error signal.
--
-- This adds a curated CHECK constraint listing every legitimate
-- notification type currently produced by the codebase. The
-- `send-push` EF gets a parallel validation against the same list
-- (see PR for the EF change) so failures surface at the API edge
-- instead of as silent CHECK violations downstream.
--
-- ── Pre-flight (REQUIRED before applying to prod) ──
-- Run this query first to confirm existing rows fit the new
-- constraint. If any rows return values not listed below, either
-- (a) backfill them to a valid value, or (b) add the missing value
-- to the CHECK list before applying:
--
--   SELECT type, COUNT(*) AS n
--   FROM notifications
--   GROUP BY type
--   ORDER BY n DESC;
--
-- Values catalogued from the codebase (2026-05-27):
--   ride               00124 (status changes accepted/en_route/arrived/in_progress/completed/canceled)
--   ride_offer         00327 (NEW — driver push on new offer)
--   ride_matching      00269 (dispatch retry rounds 2/3)
--   chat               00054 (new chat message)
--   proximity          00095/00096 (driver near pickup/dropoff)
--   payment                  00134 + NETOPIA webhook (recharge result)
--   wallet_recharge          NETOPIA webhook (sendPaymentNotification data.type)
--   wallet_recharge_refund   NETOPIA webhook (sendRefundNotification data.type)
--   wallet_credit            alternate path
--   wallet_debit             alternate path
--   scheduled_ride     00042 (scheduled ride activation push to drivers)
--   lost_item          00054 (lost-and-found state change)
--   dispute_update     generic dispute category
--   sos                00165 (safety/SOS)
--   delivery           00325 (delivery recipient notify)
--   system             00040 fallback + admin broadcast + lost item driver-side
--   promo              marketing campaign broadcast
--
-- Legacy values (kept for backward-compat with existing inbox rows;
-- TODO consolidate in a follow-up PR by remapping to canonical):
--   ride_updates       00095/00096 (proximity pushes — category should be 'proximity')
--   wallet_v2_migration 00245 (one-shot admin push during wallet migration)
-- ============================================================

-- Strip any prior version of the constraint (idempotent re-apply).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

-- Add the curated CHECK. NOT VALID lets us add it without scanning
-- existing rows immediately — we VALIDATE in a separate statement
-- so a non-conforming row blocks validation rather than the ALTER.
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'ride',
    'ride_offer',
    'ride_matching',
    'chat',
    'proximity',
    'payment',
    'wallet_recharge',
    'wallet_recharge_refund',
    'wallet_credit',
    'wallet_debit',
    'scheduled_ride',
    'lost_item',
    'dispute_update',
    'sos',
    'delivery',
    'system',
    'promo',
    -- Legacy values — see migration header. Backward-compat only.
    'ride_updates',
    'wallet_v2_migration'
  ))
  NOT VALID;

-- Validate against existing rows. If this fails, the operator
-- should run the pre-flight query, backfill rogue values, and
-- re-run this VALIDATE step. The CHECK is already protecting new
-- INSERTs at this point, so backfill is safe.
ALTER TABLE notifications
  VALIDATE CONSTRAINT notifications_type_check;

COMMENT ON CONSTRAINT notifications_type_check ON notifications IS
  '00328: Curated discriminator for inbox routing. Keep in sync with send-push EF validator and the codebase grep ''category|type'': ride, ride_offer, ride_matching, chat, proximity, payment, wallet_*, scheduled_ride, lost_item, dispute_update, sos, delivery, system, promo.';
