-- ============================================================
-- TriciGo — Stripe recharge minimum: $20 USD
--
-- Business rule update: card recharges from the mobile client must
-- be at least $20 USD. The ledger is still denominated in CUP
-- (post-00094 rebase 1 TRC = 1 CUP), so we convert at the current
-- USD↔CUP rate when the user initiates the PaymentIntent.
--
-- Storing 10,000 CUP as the floor covers the $20 USD minimum at
-- typical Cuban rates (~500 CUP/USD). The edge function does the
-- final conversion check at intent creation time using the live
-- exchange rate.
-- ============================================================

UPDATE platform_config
SET value = '10000'::jsonb
WHERE key = 'stripe_min_recharge_cup';

-- Keep max at 50,000 CUP (~$100 USD) for now — raise when compliance
-- and KYC are in place.
UPDATE platform_config
SET value = '50000'::jsonb
WHERE key = 'stripe_max_recharge_cup';
