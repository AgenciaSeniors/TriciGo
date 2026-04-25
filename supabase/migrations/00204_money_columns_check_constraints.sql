-- ============================================================
-- BUG-162: many money / fee columns across the schema lacked CHECK
-- constraints, leaving them as untyped INTEGER fields. While most
-- write paths go through SECDEF RPCs that validate, defense in
-- depth says the table itself should reject negative or absurd
-- values. The existing data is clean (verified all min values >= 0),
-- so we add NOT VALID + VALIDATE in one migration.
--
-- Columns covered:
--   payment_intents.amount_cup / amount_usd / fee_usd  — never < 0
--   ride_disputes.refund_amount_trc                    — never < 0
--   referrals.bonus_amount                             — > 0 only
--   cancellation_penalties.amount                      — >= 0
--   rides.discount_amount_cup / cancellation_fee_cup
--        / cancellation_fee_trc / estimated_fare_cup
--        / estimated_fare_trc / cash_amount_cup        — >= 0
--   lost_items.return_fee_cup                          — >= 0
--   ride_splits.amount_trc                             — >= 0
--   ride_pricing_snapshots.base_fare / commission_amount
--        / surge_multiplier (>=1) / commission_rate (0..1)
--   corporate_rides.fare_trc                           — >= 0
--
-- ledger_entries.amount and balance_after are intentionally left
-- WITHOUT CHECK because they're double-entry — a debit is negative
-- by design.
-- ============================================================

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_amount_cup_nonneg CHECK (amount_cup >= 0) NOT VALID;
ALTER TABLE public.payment_intents VALIDATE CONSTRAINT payment_intents_amount_cup_nonneg;

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_amount_usd_nonneg CHECK (amount_usd IS NULL OR amount_usd >= 0) NOT VALID;
ALTER TABLE public.payment_intents VALIDATE CONSTRAINT payment_intents_amount_usd_nonneg;

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_fee_usd_nonneg CHECK (fee_usd IS NULL OR fee_usd >= 0) NOT VALID;
ALTER TABLE public.payment_intents VALIDATE CONSTRAINT payment_intents_fee_usd_nonneg;

ALTER TABLE public.ride_disputes
  ADD CONSTRAINT ride_disputes_refund_nonneg CHECK (refund_amount_trc IS NULL OR refund_amount_trc >= 0) NOT VALID;
ALTER TABLE public.ride_disputes VALIDATE CONSTRAINT ride_disputes_refund_nonneg;

ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_bonus_positive CHECK (bonus_amount > 0) NOT VALID;
ALTER TABLE public.referrals VALIDATE CONSTRAINT referrals_bonus_positive;

ALTER TABLE public.cancellation_penalties
  ADD CONSTRAINT cancellation_penalties_amount_nonneg CHECK (amount >= 0) NOT VALID;
ALTER TABLE public.cancellation_penalties VALIDATE CONSTRAINT cancellation_penalties_amount_nonneg;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_discount_amount_nonneg CHECK (discount_amount_cup IS NULL OR discount_amount_cup >= 0) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_discount_amount_nonneg;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_cancellation_fee_cup_nonneg CHECK (cancellation_fee_cup IS NULL OR cancellation_fee_cup >= 0) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_cancellation_fee_cup_nonneg;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_cancellation_fee_trc_nonneg CHECK (cancellation_fee_trc IS NULL OR cancellation_fee_trc >= 0) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_cancellation_fee_trc_nonneg;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_estimated_fare_cup_nonneg CHECK (estimated_fare_cup IS NULL OR estimated_fare_cup >= 0) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_estimated_fare_cup_nonneg;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_estimated_fare_trc_nonneg CHECK (estimated_fare_trc IS NULL OR estimated_fare_trc >= 0) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_estimated_fare_trc_nonneg;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_cash_amount_nonneg CHECK (cash_amount_cup IS NULL OR cash_amount_cup >= 0) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_cash_amount_nonneg;

ALTER TABLE public.lost_items
  ADD CONSTRAINT lost_items_return_fee_nonneg CHECK (return_fee_cup IS NULL OR return_fee_cup >= 0) NOT VALID;
ALTER TABLE public.lost_items VALIDATE CONSTRAINT lost_items_return_fee_nonneg;

ALTER TABLE public.ride_splits
  ADD CONSTRAINT ride_splits_amount_trc_nonneg CHECK (amount_trc IS NULL OR amount_trc >= 0) NOT VALID;
ALTER TABLE public.ride_splits VALIDATE CONSTRAINT ride_splits_amount_trc_nonneg;

ALTER TABLE public.ride_pricing_snapshots
  ADD CONSTRAINT rps_base_fare_nonneg CHECK (base_fare IS NULL OR base_fare >= 0) NOT VALID;
ALTER TABLE public.ride_pricing_snapshots VALIDATE CONSTRAINT rps_base_fare_nonneg;

ALTER TABLE public.ride_pricing_snapshots
  ADD CONSTRAINT rps_commission_amount_nonneg CHECK (commission_amount IS NULL OR commission_amount >= 0) NOT VALID;
ALTER TABLE public.ride_pricing_snapshots VALIDATE CONSTRAINT rps_commission_amount_nonneg;

ALTER TABLE public.ride_pricing_snapshots
  ADD CONSTRAINT rps_surge_multiplier_min1 CHECK (surge_multiplier IS NULL OR surge_multiplier >= 1) NOT VALID;
ALTER TABLE public.ride_pricing_snapshots VALIDATE CONSTRAINT rps_surge_multiplier_min1;

ALTER TABLE public.ride_pricing_snapshots
  ADD CONSTRAINT rps_commission_rate_unit CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 1)) NOT VALID;
ALTER TABLE public.ride_pricing_snapshots VALIDATE CONSTRAINT rps_commission_rate_unit;

ALTER TABLE public.corporate_rides
  ADD CONSTRAINT corporate_rides_fare_trc_nonneg CHECK (fare_trc >= 0) NOT VALID;
ALTER TABLE public.corporate_rides VALIDATE CONSTRAINT corporate_rides_fare_trc_nonneg;
