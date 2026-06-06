-- ============================================================
-- Migration 00389: Google Directions route cache + daily budget counter
--
-- Supports the `directions-google` Edge Function (controlled experiment to
-- try Google Directions as the route provider, behind a platform_config
-- flag, with Mapbox fallback). Mirrors 00304 (google_places_cache):
--   - Cache table for route responses (TOS-allowed max 30 days)
--   - Daily counter for budget-cap protection (Directions is pay-per-use)
--   - platform_config flags: routing_google_enabled (default OFF) +
--     routing_google_daily_cap
--
-- STAGING migration — no existing data is touched. NOT applied to prod
-- until explicitly authorized (MCP guard). The flag defaults OFF, so
-- nothing changes until an admin flips routing_google_enabled=true AND the
-- GOOGLE_DIRECTIONS_API_KEY secret is set.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Cache table
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.google_directions_cache (
  route_hash    TEXT PRIMARY KEY,        -- sha256(origin|waypoints|dest|mode), coords ~4 dec
  request_summary TEXT,                  -- human-readable "lat,lng -> … -> lat,lng" (debug)
  response_json JSONB NOT NULL,          -- { coordinates:[lat,lng][], distance_m, duration_s }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_google_dir_cache_created_at
  ON public.google_directions_cache (created_at DESC);

COMMENT ON TABLE public.google_directions_cache IS
  '00389: caches Google Directions route responses for up to 30 days (TOS limit). Used by the directions-google EF to cut cost.';


-- ─────────────────────────────────────────────────────────────────
-- Daily counter table (budget cap protection)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.google_directions_daily_counter (
  day         DATE PRIMARY KEY,
  call_count  INTEGER NOT NULL DEFAULT 0,
  cache_hits  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.google_directions_daily_counter IS
  '00389: per-day Google Directions API calls + cache hits. The directions-google EF checks call_count against routing_google_daily_cap before calling Google; over cap → falls back to Mapbox.';


-- ─────────────────────────────────────────────────────────────────
-- RLS — only service_role / EFs touch these tables
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.google_directions_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_directions_daily_counter ENABLE ROW LEVEL SECURITY;
-- No authenticated/anon policies — service_role bypasses RLS; clients always
-- go through the EF.


-- ─────────────────────────────────────────────────────────────────
-- RPCs (for the EF via service_role connection)
-- ─────────────────────────────────────────────────────────────────

-- Get a cached route if fresh (<30 days); bumps hit_count + today's cache_hits.
CREATE OR REPLACE FUNCTION public.google_dir_cache_get(p_route_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT response_json, created_at INTO v_row
  FROM public.google_directions_cache
  WHERE route_hash = p_route_hash
    AND created_at > NOW() - INTERVAL '30 days';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.google_directions_cache
  SET hit_count = hit_count + 1
  WHERE route_hash = p_route_hash;

  INSERT INTO public.google_directions_daily_counter (day, call_count, cache_hits, updated_at)
  VALUES (CURRENT_DATE, 0, 1, NOW())
  ON CONFLICT (day) DO UPDATE
    SET cache_hits = google_directions_daily_counter.cache_hits + 1,
        updated_at = NOW();

  RETURN v_row.response_json;
END;
$$;
REVOKE ALL ON FUNCTION public.google_dir_cache_get FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_dir_cache_get TO service_role;


-- Upsert a fresh route into the cache.
CREATE OR REPLACE FUNCTION public.google_dir_cache_put(
  p_route_hash TEXT,
  p_request_summary TEXT,
  p_response_json JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.google_directions_cache (
    route_hash, request_summary, response_json, created_at, hit_count
  ) VALUES (
    p_route_hash, p_request_summary, p_response_json, NOW(), 0
  )
  ON CONFLICT (route_hash) DO UPDATE
    SET response_json = EXCLUDED.response_json,
        created_at = NOW(),
        hit_count = 0;
END;
$$;
REVOKE ALL ON FUNCTION public.google_dir_cache_put FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_dir_cache_put TO service_role;


-- Today's API call count (excluding cache hits), for the cap check.
CREATE OR REPLACE FUNCTION public.google_dir_cache_daily_count()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT call_count FROM public.google_directions_daily_counter WHERE day = CURRENT_DATE),
    0
  );
$$;
REVOKE ALL ON FUNCTION public.google_dir_cache_daily_count FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_dir_cache_daily_count TO service_role;


-- Atomic increment of today's API call counter — called AFTER a Google call.
CREATE OR REPLACE FUNCTION public.google_dir_cache_increment_call()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  INSERT INTO public.google_directions_daily_counter (day, call_count, cache_hits, updated_at)
  VALUES (CURRENT_DATE, 1, 0, NOW())
  ON CONFLICT (day) DO UPDATE
    SET call_count = google_directions_daily_counter.call_count + 1,
        updated_at = NOW()
  RETURNING call_count INTO v_new_count;
  RETURN v_new_count;
END;
$$;
REVOKE ALL ON FUNCTION public.google_dir_cache_increment_call FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_dir_cache_increment_call TO service_role;


-- Lazy cleanup of entries >30 days old (called ~1% of requests by the EF).
CREATE OR REPLACE FUNCTION public.google_dir_cache_cleanup()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.google_directions_cache
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  DELETE FROM public.google_directions_daily_counter
  WHERE day < CURRENT_DATE - INTERVAL '90 days';

  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.google_dir_cache_cleanup FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_dir_cache_cleanup TO service_role;


-- ─────────────────────────────────────────────────────────────────
-- platform_config flags (admin-editable, no redeploy). Default OFF.
-- ─────────────────────────────────────────────────────────────────
INSERT INTO public.platform_config (key, value)
VALUES
  ('routing_google_enabled', 'false'),
  ('routing_google_daily_cap', '2000')
ON CONFLICT (key) DO NOTHING;
