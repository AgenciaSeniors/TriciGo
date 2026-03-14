-- ============================================================
-- Migration 00043: Categorized Ratings (Tag-Based)
-- Adds selectable tag chips to the review flow (Uber-style)
-- ============================================================

-- 1. Tag definitions catalog
CREATE TABLE review_tag_definitions (
  key         TEXT PRIMARY KEY,
  direction   TEXT NOT NULL,
  sentiment   TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT chk_tag_direction CHECK (direction IN ('rider_to_driver', 'driver_to_rider')),
  CONSTRAINT chk_tag_sentiment CHECK (sentiment IN ('positive', 'negative'))
);

-- 2. Junction table: reviews ↔ tags
CREATE TABLE review_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id  UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  tag_key    TEXT NOT NULL REFERENCES review_tag_definitions(key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(review_id, tag_key)
);

-- 3. Indexes
CREATE INDEX idx_review_tags_review_id ON review_tags(review_id);
CREATE INDEX idx_review_tags_tag_key   ON review_tags(tag_key);

-- 4. Seed: rider → driver (positive, ≥4★)
INSERT INTO review_tag_definitions (key, direction, sentiment, display_order) VALUES
  ('clean_vehicle',         'rider_to_driver', 'positive', 1),
  ('great_conversation',    'rider_to_driver', 'positive', 2),
  ('expert_navigation',     'rider_to_driver', 'positive', 3),
  ('smooth_driving',        'rider_to_driver', 'positive', 4),
  ('went_above_and_beyond', 'rider_to_driver', 'positive', 5);

-- 5. Seed: rider → driver (negative, ≤3★)
INSERT INTO review_tag_definitions (key, direction, sentiment, display_order) VALUES
  ('dirty_vehicle',   'rider_to_driver', 'negative', 1),
  ('unsafe_driving',  'rider_to_driver', 'negative', 2),
  ('rude_behavior',   'rider_to_driver', 'negative', 3),
  ('wrong_route',     'rider_to_driver', 'negative', 4),
  ('long_wait',       'rider_to_driver', 'negative', 5);

-- 6. Seed: driver → rider (positive, ≥4★)
INSERT INTO review_tag_definitions (key, direction, sentiment, display_order) VALUES
  ('respectful',       'driver_to_rider', 'positive', 1),
  ('good_conversation','driver_to_rider', 'positive', 2),
  ('on_time_pickup',   'driver_to_rider', 'positive', 3),
  ('pleasant_ride',    'driver_to_rider', 'positive', 4);

-- 7. Seed: driver → rider (negative, ≤3★)
INSERT INTO review_tag_definitions (key, direction, sentiment, display_order) VALUES
  ('rude',            'driver_to_rider', 'negative', 1),
  ('left_mess',       'driver_to_rider', 'negative', 2),
  ('late_pickup',     'driver_to_rider', 'negative', 3),
  ('unsafe_behavior', 'driver_to_rider', 'negative', 4),
  ('bad_directions',  'driver_to_rider', 'negative', 5);

-- 8. RLS on review_tag_definitions (read-only for everyone)
ALTER TABLE review_tag_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active tag definitions"
  ON review_tag_definitions FOR SELECT
  USING (is_active = true);

CREATE POLICY "Admins can manage tag definitions"
  ON review_tag_definitions FOR ALL
  USING (is_admin());

-- 9. RLS on review_tags
ALTER TABLE review_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read tags on their reviews"
  ON review_tags FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.id = review_tags.review_id
        AND (r.reviewer_id = auth.uid() OR r.reviewee_id = auth.uid())
    )
    OR is_admin()
  );

CREATE POLICY "Reviewers can insert tags on their reviews"
  ON review_tags FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.id = review_tags.review_id
        AND r.reviewer_id = auth.uid()
    )
  );

CREATE POLICY "Admins can manage review tags"
  ON review_tags FOR ALL
  USING (is_admin());

-- 10. RPC: get tag summary for a user (top tags received)
CREATE OR REPLACE FUNCTION get_review_tag_summary(p_user_id UUID)
RETURNS JSON AS $$
  SELECT COALESCE(
    json_agg(row_to_json(t) ORDER BY t.count DESC),
    '[]'::json
  )
  FROM (
    SELECT rt.tag_key, COUNT(*)::int AS count
    FROM review_tags rt
    JOIN reviews r ON r.id = rt.review_id
    WHERE r.reviewee_id = p_user_id
      AND r.is_visible = true
    GROUP BY rt.tag_key
    ORDER BY count DESC
    LIMIT 10
  ) t;
$$ LANGUAGE sql STABLE;

-- 11. Feature flag
INSERT INTO feature_flags (key, enabled, description)
VALUES ('categorized_ratings_enabled', false, 'Enable tag-based categorized ratings after star review')
ON CONFLICT (key) DO NOTHING;
