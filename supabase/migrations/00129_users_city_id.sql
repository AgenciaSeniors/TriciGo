-- ============================================================
-- TriciGo — users.city_id
-- Link users to their primary city so segment "por ciudad" in
-- /segments and /campaigns admin pages can filter by city.
-- Nullable: existing rows default to NULL; apps can prompt users
-- to set it or infer from first ride origin.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_city_id
  ON users(city_id)
  WHERE city_id IS NOT NULL;
