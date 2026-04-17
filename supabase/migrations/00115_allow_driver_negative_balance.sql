-- Fix: Cash ride completion fails because driver wallet balance goes negative
-- when platform deducts commission. Driver accounts need to allow negative
-- balance (accumulated debt settled periodically), like Uber/99.
-- Only customer_cash accounts must maintain balance >= 0.

ALTER TABLE wallet_accounts DROP CONSTRAINT IF EXISTS wallet_accounts_balance_non_negative;

ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_customer_balance_non_negative
  CHECK (account_type != 'customer_cash' OR balance >= 0);
