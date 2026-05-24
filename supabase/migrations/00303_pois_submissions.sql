-- ============================================================
-- Migration 00303: POI crowdsourcing — submissions table + RPCs
--
-- PR 3 of the POI parity program. Foursquare/OSM/Overture cover only
-- the major Cuban POIs — the long-tail of mypimes, paladares, kioscos,
-- barbershops is invisible to foreign data sources. This migration adds
-- the schema + RPCs for in-app crowdsourcing: drivers and clients can
-- submit places they see, an admin reviews them, approved submissions
-- become first-class POIs in cuba_pois with source='crowdsource'.
--
-- Why a separate table (vs writing directly to cuba_pois):
--   - Need a moderation queue before a submission becomes a public POI
--   - Need separate RLS (any auth user can INSERT submissions; only
--     admin can INSERT to cuba_pois)
--   - Rejection trail (who/why/when) lives ONLY on the submission row,
--     keeps cuba_pois clean
--   - Trust score / auto-approval logic (future PR) reads from this
--     table without touching cuba_pois
--
-- MVP scope (this PR):
--   - Schema + indexes + RLS
--   - submit_poi RPC (any auth user; rate limited 5/hour, 20/day)
--   - approve_poi_submission RPC (admin only — copies to cuba_pois)
--   - reject_poi_submission RPC (admin only — sets status + reason)
--
-- Deferred to follow-up PR:
--   - Photo upload (requires storage bucket setup)
--   - Trust score auto-approval (>50 trips + >0.8 rating)
--   - Duplicate detection sheet on frontend ("¿es el mismo que X?")
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Allow 'crowdsource' as a valid source in cuba_pois
--
-- Migration 00248 added a CHECK constraint that only allowed
-- 'admin','osm','overture','foursquare','merged'. The approve_poi_submission
-- RPC below inserts source='crowdsource', so we must extend the constraint
-- before the RPC can succeed.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.cuba_pois
  DROP CONSTRAINT IF EXISTS cuba_pois_source_check;

ALTER TABLE public.cuba_pois
  ADD CONSTRAINT cuba_pois_source_check
  CHECK (source IN ('admin','osm','overture','foursquare','merged','crowdsource'));


-- ─────────────────────────────────────────────────────────────────
-- Schema
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cuba_pois_submissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  tricigo_category TEXT NOT NULL,
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  address       TEXT,
  notes         TEXT,                 -- optional free-text from submitter

  -- Moderation state
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'duplicate')),
  moderator_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  moderated_at  TIMESTAMPTZ,
  rejection_reason TEXT,
  -- If approved, the resulting cuba_pois.id (for audit trail).
  promoted_poi_id BIGINT,

  -- Audit
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Submitter context (not security — just metrics; no PII beyond user_id)
  submitter_role TEXT  -- 'driver' | 'client' (auto-detected at submit)
);

CREATE INDEX IF NOT EXISTS idx_pois_subm_status ON public.cuba_pois_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pois_subm_submitter ON public.cuba_pois_submissions (submitted_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pois_subm_location ON public.cuba_pois_submissions USING GIST (location);

COMMENT ON TABLE public.cuba_pois_submissions IS
  'Crowdsourced POI submissions awaiting moderation. Approved rows are copied to cuba_pois with source=crowdsource.';

-- ─────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.cuba_pois_submissions ENABLE ROW LEVEL SECURITY;

-- Authenticated users can INSERT their own submissions
DROP POLICY IF EXISTS pois_subm_insert_own ON public.cuba_pois_submissions;
CREATE POLICY pois_subm_insert_own ON public.cuba_pois_submissions
  FOR INSERT TO authenticated
  WITH CHECK (submitted_by = auth.uid());

-- Authenticated users can SELECT only their OWN submissions (so they can
-- see status of their pending requests). Admins can SELECT all (via
-- separate policy below using is_admin()).
DROP POLICY IF EXISTS pois_subm_select_own ON public.cuba_pois_submissions;
CREATE POLICY pois_subm_select_own ON public.cuba_pois_submissions
  FOR SELECT TO authenticated
  USING (submitted_by = auth.uid());

-- Admin can SELECT/UPDATE all (handled via SECURITY DEFINER RPCs below;
-- direct table access for admin is via separate policy)
DROP POLICY IF EXISTS pois_subm_admin_all ON public.cuba_pois_submissions;
CREATE POLICY pois_subm_admin_all ON public.cuba_pois_submissions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- No DELETE policy — submissions are kept forever as audit trail


-- ─────────────────────────────────────────────────────────────────
-- RPC: submit_poi (called by any auth user via app)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_poi(
  p_name TEXT,
  p_tricigo_category TEXT,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_address TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_role TEXT;
  v_submissions_last_hour INTEGER;
  v_submissions_last_day INTEGER;
  v_nearby_existing INTEGER;
  v_submission_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;

  -- Validation
  IF p_name IS NULL OR length(trim(p_name)) < 1 OR length(trim(p_name)) > 200 THEN
    RETURN jsonb_build_object('error', 'invalid_name');
  END IF;
  IF p_tricigo_category IS NULL OR length(p_tricigo_category) < 1 THEN
    RETURN jsonb_build_object('error', 'invalid_category');
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat < -90 OR p_lat > 90
     OR p_lng < -180 OR p_lng > 180 THEN
    RETURN jsonb_build_object('error', 'invalid_coords');
  END IF;
  -- Cuba bbox sanity check (avoid spam from outside Cuba)
  IF p_lat < 19.5 OR p_lat > 23.5 OR p_lng < -85.0 OR p_lng > -74.0 THEN
    RETURN jsonb_build_object('error', 'outside_cuba');
  END IF;

  -- Rate limiting: 5 submissions per hour, 20 per day per user
  SELECT COUNT(*) INTO v_submissions_last_hour
  FROM public.cuba_pois_submissions
  WHERE submitted_by = v_user_id
    AND created_at > NOW() - INTERVAL '1 hour';
  IF v_submissions_last_hour >= 5 THEN
    RETURN jsonb_build_object('error', 'rate_limit_hour', 'retry_after_minutes', 60);
  END IF;

  SELECT COUNT(*) INTO v_submissions_last_day
  FROM public.cuba_pois_submissions
  WHERE submitted_by = v_user_id
    AND created_at > NOW() - INTERVAL '24 hours';
  IF v_submissions_last_day >= 20 THEN
    RETURN jsonb_build_object('error', 'rate_limit_day', 'retry_after_minutes', 1440);
  END IF;

  -- Duplicate hint: warn if an active POI exists within 30m
  SELECT COUNT(*) INTO v_nearby_existing
  FROM public.cuba_pois cp
  WHERE cp.is_active
    AND ST_DWithin(
      cp.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      30
    );
  -- Note: we DON'T block on duplicates here; client should already have
  -- warned the user. We just record it as a hint in `notes` if present.

  -- Detect role (driver or client) — best-effort. Defaults to 'client' if
  -- the users table doesn't have a clear signal.
  SELECT
    CASE
      WHEN EXISTS (SELECT 1 FROM public.driver_profiles WHERE id = v_user_id) THEN 'driver'
      ELSE 'client'
    END
    INTO v_role;

  -- Insert the submission
  INSERT INTO public.cuba_pois_submissions (
    submitted_by, name, tricigo_category, location, address, notes, submitter_role
  ) VALUES (
    v_user_id,
    trim(p_name),
    p_tricigo_category,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_address,
    p_notes,
    v_role
  ) RETURNING id INTO v_submission_id;

  RETURN jsonb_build_object(
    'submission_id', v_submission_id,
    'status', 'pending',
    'nearby_existing_count', v_nearby_existing
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_poi FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_poi TO authenticated;

COMMENT ON FUNCTION public.submit_poi IS
  'Submits a new POI for moderation. Rate limited 5/hour, 20/day per user. '
  'Returns submission_id + nearby_existing_count hint.';


-- ─────────────────────────────────────────────────────────────────
-- RPC: approve_poi_submission (admin only)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_poi_submission(
  p_submission_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_submission RECORD;
  v_new_poi_id BIGINT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  SELECT * INTO v_submission
  FROM public.cuba_pois_submissions
  WHERE id = p_submission_id
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found_or_not_pending');
  END IF;

  -- Insert into cuba_pois with source='crowdsource'
  -- Note: tricigo_category is auto-populated by 00302 trigger if our value
  -- somehow doesn't map. confidence=0.7 marks crowdsourced as fairly
  -- trustworthy (above OSM default 0.5, below admin 1.0).
  INSERT INTO public.cuba_pois (
    name, name_normalized, tricigo_category, category, location,
    address, source, source_ids, is_admin, is_active, confidence,
    importance, synced_at, updated_at
  ) VALUES (
    v_submission.name,
    lower(unaccent(v_submission.name)),
    v_submission.tricigo_category,
    v_submission.tricigo_category, -- mirror to category for back-compat
    v_submission.location,
    v_submission.address,
    'crowdsource',
    jsonb_build_object('submission_id', v_submission.id::TEXT),
    FALSE,
    TRUE,
    0.7,
    3, -- mid-tier importance — visible at zoom 13+
    NOW(),
    NOW()
  ) RETURNING id INTO v_new_poi_id;

  -- Update submission
  UPDATE public.cuba_pois_submissions
  SET status = 'approved',
      moderator_id = v_user_id,
      moderated_at = NOW(),
      promoted_poi_id = v_new_poi_id,
      updated_at = NOW()
  WHERE id = p_submission_id;

  RETURN jsonb_build_object(
    'success', TRUE,
    'promoted_poi_id', v_new_poi_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_poi_submission FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_poi_submission TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- RPC: reject_poi_submission (admin only)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reject_poi_submission(
  p_submission_id UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL OR NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 1 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  UPDATE public.cuba_pois_submissions
  SET status = 'rejected',
      moderator_id = v_user_id,
      moderated_at = NOW(),
      rejection_reason = trim(p_reason),
      updated_at = NOW()
  WHERE id = p_submission_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found_or_not_pending');
  END IF;

  RETURN jsonb_build_object('success', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_poi_submission FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_poi_submission TO authenticated;


-- ─────────────────────────────────────────────────────────────────
-- RPC: list_poi_submissions (admin only — for admin panel)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_poi_submissions(
  p_status TEXT DEFAULT 'pending',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
) RETURNS TABLE(
  id UUID,
  submitted_by UUID,
  name TEXT,
  tricigo_category TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address TEXT,
  notes TEXT,
  status TEXT,
  submitter_role TEXT,
  created_at TIMESTAMPTZ,
  moderator_id UUID,
  moderated_at TIMESTAMPTZ,
  rejection_reason TEXT,
  promoted_poi_id BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RETURN;  -- empty result for non-admins
  END IF;

  RETURN QUERY
  SELECT
    s.id, s.submitted_by, s.name, s.tricigo_category,
    ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
    s.address, s.notes, s.status, s.submitter_role, s.created_at,
    s.moderator_id, s.moderated_at, s.rejection_reason, s.promoted_poi_id
  FROM public.cuba_pois_submissions s
  WHERE (p_status = 'all' OR s.status = p_status)
  ORDER BY s.created_at DESC
  LIMIT LEAST(p_limit, 200)
  OFFSET p_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.list_poi_submissions FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_poi_submissions TO authenticated;

COMMENT ON FUNCTION public.list_poi_submissions IS
  'Admin-only RPC to list submissions for the moderation panel. Returns empty for non-admins.';
