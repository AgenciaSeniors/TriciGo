-- ============================================================
-- BUG-145: rev_insert had WITH CHECK (reviewer_id = auth.uid()) but
-- did not require the reviewer to actually be a participant in the
-- ride, did not require the reviewee to be the other participant,
-- and did not prevent self-reviews. A customer who never took the
-- ride could insert a 1-star review for any driver. Combined with
-- the rating_avg trigger from BUG-117, this lets:
--   - drivers tank competitors via fake customer accounts
--   - drivers self-boost via fake 5-star reviews
--   - customers leave reviews on rides they weren't on
--
-- Verified: under SET LOCAL "request.jwt.claims" of a customer's
-- UUID who was NOT the customer on a ride, INSERT INTO reviews
-- succeeded with rating=1 — fake review accepted.
--
-- Fix: tighten the policy WITH CHECK to require:
--   1. reviewer_id = auth.uid() (existing, kept)
--   2. reviewer_id <> reviewee_id (no self-reviews)
--   3. The ride exists and is completed
--   4. The reviewer must be the customer with reviewee = driver's
--      user_id, OR the reviewer must be the driver's user_id with
--      reviewee = customer
-- Plus a UNIQUE (ride_id, reviewer_id) so each participant can
-- review each ride at most once.
-- ============================================================

DROP POLICY IF EXISTS rev_insert ON public.reviews;

CREATE POLICY rev_insert
  ON public.reviews
  FOR INSERT
  TO authenticated
  WITH CHECK (
    reviewer_id = (SELECT auth.uid())
    AND reviewer_id <> reviewee_id
    AND EXISTS (
      SELECT 1
      FROM rides r
      LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
      WHERE r.id = reviews.ride_id
        AND r.status = 'completed'
        AND (
          -- Customer reviewing the driver
          (r.customer_id = reviews.reviewer_id
           AND dp.user_id = reviews.reviewee_id)
          OR
          -- Driver reviewing the customer
          (dp.user_id = reviews.reviewer_id
           AND r.customer_id = reviews.reviewee_id)
        )
    )
  );

COMMENT ON POLICY rev_insert ON public.reviews IS
  'BUG-145: review writer must be an actual participant of the completed ride, and reviewee must be the other participant. Prevents fake reviews from non-participants.';

-- One review per direction per ride (customer→driver and driver→customer)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reviews_ride_reviewer
  ON public.reviews (ride_id, reviewer_id);
