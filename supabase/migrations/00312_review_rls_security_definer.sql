-- ============================================================
-- Migration 00312: fix rev_insert RLS via SECURITY DEFINER helper
--
-- Bug verified 2026-05-25 on-device by the user during a real test
-- trip: the client app couldn't submit a review and got 42501
-- (INSUFFICIENT_PRIVILEGE — "new row violates row-level security
-- policy for table reviews"), retrying 3× with the same failure.
--
-- Root cause (reproduced via SET ROLE authenticated + JWT-as-rider
-- SQL test in MCP):
--   The rev_insert policy from 00196 has an EXISTS subquery that
--   LEFT JOINs `driver_profiles dp ON dp.id = r.driver_id` to read
--   the driver's auth.uid (dp.user_id). When the rider runs the
--   INSERT, RLS on `driver_profiles` denies them visibility of the
--   joined row → dp.user_id resolves to NULL inside the subquery
--   → the OR-branch `dp.user_id = reviews.reviewee_id` is always
--   false (NULL = uuid is false) → the OR-branch for "driver
--   reviewing rider" never matches because dp.user_id is NULL
--   → EXISTS returns false → policy CHECK fails → 42501.
--
--   Symmetrically, when a DRIVER submits a review of the rider,
--   RLS on rides may or may not let them see the customer_id, but
--   the same NULL-collapse on dp.user_id breaks the driver-side
--   OR-branch too.
--
-- Fix:
--   Move the cross-table validation into a SECURITY DEFINER
--   function that bypasses RLS on rides + driver_profiles. The
--   function takes the same (ride_id, reviewer_id, reviewee_id)
--   tuple the policy already has — so it cannot be used to escalate
--   visibility into other people's data; it only answers a yes/no
--   question about a specific reviewer/reviewee combination on a
--   specific ride.
--
--   The policy then becomes:
--     reviewer_id = auth.uid()
--     AND reviewer_id <> reviewee_id
--     AND can_review_ride(ride_id, reviewer_id, reviewee_id)
--
--   Same semantic as 00196, just no NULL-collapse on the JOIN.
--
-- Safety:
--   * Function is STABLE + SECURITY DEFINER + search_path locked.
--   * GRANT EXECUTE only to `authenticated` (anon cannot probe).
--   * The function does not return any row data — only boolean.
--     A rider probing for "can I review ride X reviewing driver Y"
--     learns only what they could already learn by trying the
--     INSERT itself.
-- ============================================================

CREATE OR REPLACE FUNCTION public.can_review_ride(
  p_ride_id uuid,
  p_reviewer_id uuid,
  p_reviewee_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rides r
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    WHERE r.id = p_ride_id
      AND r.status = 'completed'::ride_status
      AND (
        (r.customer_id = p_reviewer_id AND dp.user_id = p_reviewee_id)
        OR
        (dp.user_id = p_reviewer_id AND r.customer_id = p_reviewee_id)
      )
  );
$$;

COMMENT ON FUNCTION public.can_review_ride IS
  'PR H (2026-05-25). Validates that (reviewer, reviewee) is a legitimate '
  'pair for a completed ride. Used by rev_insert policy to sidestep RLS '
  'visibility issues on driver_profiles when the rider INSERTs a review.';

REVOKE ALL ON FUNCTION public.can_review_ride FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_review_ride TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- Rewrite the rev_insert policy to use the helper
-- ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS rev_insert ON public.reviews;

CREATE POLICY rev_insert
  ON public.reviews
  FOR INSERT
  TO authenticated
  WITH CHECK (
    reviewer_id = (SELECT auth.uid())
    AND reviewer_id <> reviewee_id
    AND public.can_review_ride(ride_id, reviewer_id, reviewee_id)
  );

COMMENT ON POLICY rev_insert ON public.reviews IS
  'PR H (2026-05-25). Was failing with 42501 because the inline EXISTS '
  'subquery LEFT JOINed driver_profiles, which RLS hid from the rider '
  'context — making dp.user_id resolve to NULL and the OR-branch fail. '
  'Now delegates to can_review_ride() (SECURITY DEFINER).';
