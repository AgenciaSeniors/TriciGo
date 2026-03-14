-- ============================================================
-- Migration 00026: Rider Rating System
-- Adds bidirectional rating support (driver → rider)
-- ============================================================

-- 1. Add cached average rating to customer_profiles
ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) NOT NULL DEFAULT 5.00;

-- 2. RPC: get_review_summary — aggregates ratings for any user
CREATE OR REPLACE FUNCTION get_review_summary(p_user_id UUID)
RETURNS JSON AS $$
  SELECT json_build_object(
    'user_id', p_user_id,
    'average_rating', COALESCE(ROUND(AVG(rating)::numeric, 2), 5.00),
    'total_reviews', COUNT(*)::int,
    'rating_distribution', json_build_object(
      '1', COUNT(*) FILTER (WHERE rating = 1),
      '2', COUNT(*) FILTER (WHERE rating = 2),
      '3', COUNT(*) FILTER (WHERE rating = 3),
      '4', COUNT(*) FILTER (WHERE rating = 4),
      '5', COUNT(*) FILTER (WHERE rating = 5)
    )
  )
  FROM reviews
  WHERE reviewee_id = p_user_id AND is_visible = true;
$$ LANGUAGE sql STABLE;

-- 3. Trigger function: auto-update customer_profiles.rating_avg on new review
CREATE OR REPLACE FUNCTION update_customer_rating_avg() RETURNS TRIGGER AS $$
BEGIN
  UPDATE customer_profiles
  SET rating_avg = (
    SELECT COALESCE(ROUND(AVG(r.rating)::numeric, 2), 5.00)
    FROM reviews r
    JOIN users u ON u.id = r.reviewee_id
    WHERE r.reviewee_id = NEW.reviewee_id
      AND r.is_visible = true
      AND u.role = 'customer'
  )
  WHERE user_id = NEW.reviewee_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Create trigger on reviews table
DROP TRIGGER IF EXISTS trg_update_customer_rating ON reviews;
CREATE TRIGGER trg_update_customer_rating
  AFTER INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_customer_rating_avg();
