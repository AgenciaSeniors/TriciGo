-- Performance indexes for high-traffic queries
CREATE INDEX IF NOT EXISTS idx_rides_customer_status ON rides(customer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rides_driver_status ON rides(driver_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rides_searching ON rides(status, created_at DESC) WHERE status = 'searching';
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_accounts_user ON wallet_accounts(user_id, account_type);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_online ON driver_profiles(status, is_online) WHERE is_online = true;
