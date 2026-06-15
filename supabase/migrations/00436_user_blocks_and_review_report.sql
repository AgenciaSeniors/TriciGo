-- 00436 — Bloquear usuario + Reportar reseña (Apple Guideline 1.2 UGC moderation)
--
-- Adds peer-to-peer blocking (mutual / no-rematch) and review reporting.
-- Design: docs/superpowers/specs/2026-06-15-block-user-report-review-design.md
--
-- Decisions:
--   * Block is MUTUAL: a single block excludes the pair from matching in BOTH
--     directions. Enforced in dispatch_ride (see 00437).
--   * A reported review STAYS VISIBLE until an admin acts (protects against
--     censoring legitimate negative reviews). Report reuses incident_reports.
--
-- Idempotent: safe to re-run.

-- ── 1. user_blocks ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_no_self CHECK (blocker_id <> blocked_id),
  CONSTRAINT user_blocks_unique  UNIQUE (blocker_id, blocked_id)
);

-- Indexes for the mutual lookup in dispatch_ride (both directions).
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON public.user_blocks (blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON public.user_blocks (blocked_id);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

-- RLS: a user only ever sees / creates / removes their OWN blocks.
-- Nobody can see who blocked them (no anti-signal). The matching engine reads
-- via SECURITY DEFINER so it bypasses RLS.
DROP POLICY IF EXISTS user_blocks_select_own ON public.user_blocks;
CREATE POLICY user_blocks_select_own ON public.user_blocks
  FOR SELECT USING (blocker_id = auth.uid());

DROP POLICY IF EXISTS user_blocks_insert_own ON public.user_blocks;
CREATE POLICY user_blocks_insert_own ON public.user_blocks
  FOR INSERT WITH CHECK (blocker_id = auth.uid());

DROP POLICY IF EXISTS user_blocks_delete_own ON public.user_blocks;
CREATE POLICY user_blocks_delete_own ON public.user_blocks
  FOR DELETE USING (blocker_id = auth.uid());

GRANT SELECT, INSERT, DELETE ON public.user_blocks TO authenticated;

-- ── 2. incident_reports: review-abuse support ──────────────────────────────
-- New enum value for reporting a review. (ADD VALUE is fine in this migration:
-- the value is only referenced inside CREATE FUNCTION bodies below, which are
-- late-bound by plpgsql and not evaluated at migration time. If a future apply
-- ever errors on this, split this ALTER TYPE into its own prior migration.)
ALTER TYPE public.incident_type ADD VALUE IF NOT EXISTS 'review_abuse';

ALTER TABLE public.incident_reports
  ADD COLUMN IF NOT EXISTS review_id uuid REFERENCES public.reviews(id) ON DELETE CASCADE;

-- ── 3. RPCs ────────────────────────────────────────────────────────────────

-- block_user: insert a block for the caller. Idempotent. Mutual effect lives
-- in dispatch_ride. Self-block and unknown targets are rejected.
CREATE OR REPLACE FUNCTION public.block_user(p_blocked_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_blocked_id IS NULL OR p_blocked_id = v_uid THEN
    RAISE EXCEPTION 'Cannot block this user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_blocked_id) THEN
    RAISE EXCEPTION 'User not found';
  END IF;
  INSERT INTO public.user_blocks (blocker_id, blocked_id, reason)
  VALUES (v_uid, p_blocked_id, NULLIF(btrim(p_reason), ''))
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
END;
$$;

-- unblock_user: remove the caller's block of the target.
CREATE OR REPLACE FUNCTION public.unblock_user(p_blocked_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  DELETE FROM public.user_blocks WHERE blocker_id = v_uid AND blocked_id = p_blocked_id;
END;
$$;

-- get_blocked_users: the caller's block list, with display name + avatar
-- resolved so the "Blocked users" screen can render without extra round-trips.
CREATE OR REPLACE FUNCTION public.get_blocked_users()
RETURNS TABLE(blocked_id uuid, full_name text, avatar_url text, reason text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT ub.blocked_id, u.full_name, u.avatar_url, ub.reason, ub.created_at
  FROM public.user_blocks ub
  JOIN public.users u ON u.id = ub.blocked_id
  WHERE ub.blocker_id = auth.uid()
  ORDER BY ub.created_at DESC;
$$;

-- report_review: the REVIEWEE (the person the review is about) flags a review
-- they received as abusive. Files an incident_report (type='review_abuse').
-- Does NOT change reviews.is_visible — the review stays visible until an admin
-- acts. Idempotent per (reported_by, review_id).
CREATE OR REPLACE FUNCTION public.report_review(p_review_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_review public.reviews%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_review FROM public.reviews WHERE id = p_review_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review not found'; END IF;

  -- Only the person the review is ABOUT can report it.
  IF v_review.reviewee_id <> v_uid THEN
    RAISE EXCEPTION 'You can only report reviews left about you';
  END IF;

  -- Idempotent: one open report per (reporter, review).
  IF EXISTS (
    SELECT 1 FROM public.incident_reports
    WHERE review_id = p_review_id AND reported_by = v_uid AND type = 'review_abuse'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.incident_reports
    (ride_id, reported_by, against_user_id, review_id, type, severity, description, status)
  VALUES
    (v_review.ride_id, v_uid, v_review.reviewer_id, p_review_id, 'review_abuse', 'low',
     COALESCE(NULLIF(btrim(p_reason), ''), 'Reseña reportada como abusiva'), 'open');
END;
$$;

GRANT EXECUTE ON FUNCTION public.block_user(uuid, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_user(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_blocked_users()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_review(uuid, text) TO authenticated;

COMMENT ON TABLE public.user_blocks IS
  '00436: peer-to-peer mutual blocks (no-rematch). Enforced in dispatch_ride (00437).';
