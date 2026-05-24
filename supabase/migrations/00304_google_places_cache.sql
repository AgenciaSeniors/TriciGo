-- ============================================================
-- Migration 00304: Google Places search cache + daily budget counter
--
-- PR 4 of the POI parity program. Supports the search-places-google Edge
-- Function:
--   - Cache table for autocomplete responses (TOS-allowed max 30 days)
--   - Daily counter table for budget cap protection ($500/mo target)
--
-- Why server-side cache:
--   - EFs are stateless: in-memory cache lost on every cold start (~5-10 min)
--   - Hit rate at scale (60%+) saves $$$ on Google Places billing
--   - Postgres is already in our stack — no Redis dep needed
--
-- TOS compliance:
--   - Google: cache max 30 days for content (place names, addresses, etc.)
--   - place_id can be cached indefinitely — we hash query+proximity as the
--     cache key, not the place_id, so this is moot for our use case
--   - Cleanup is handled lazily in the EF on each call (no pg_cron dep)
--
-- This is a STAGING migration — no existing data is touched.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Cache table
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.google_places_cache (
  query_hash    TEXT PRIMARY KEY,        -- sha256(query + proximity_key)
  query         TEXT NOT NULL,           -- original query (for debugging)
  proximity_key TEXT,                    -- "lat,lng" rounded to 2 decimals, or NULL
  response_json JSONB NOT NULL,          -- normalized SearchBoxResult[]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_google_cache_created_at
  ON public.google_places_cache (created_at DESC);

COMMENT ON TABLE public.google_places_cache IS
  'Caches Google Places Autocomplete responses for up to 30 days (TOS limit). Hit-rate target 60%+.';


-- ─────────────────────────────────────────────────────────────────
-- Daily counter table (budget cap protection)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.google_places_daily_counter (
  day         DATE PRIMARY KEY,
  call_count  INTEGER NOT NULL DEFAULT 0,
  cache_hits  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.google_places_daily_counter IS
  'Per-day count of Google Places API calls + cache hits. The Edge Function checks this against a daily cap (default 1000) before calling Google. Drops to Mapbox-only when exceeded.';


-- ─────────────────────────────────────────────────────────────────
-- RLS — only service_role and EFs can touch these tables
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.google_places_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_places_daily_counter ENABLE ROW LEVEL SECURITY;

-- No policies for authenticated/anon — service_role bypasses RLS, EFs
-- run as service_role. Means client-side code can't query these tables
-- directly; they always go through the EF.


-- ─────────────────────────────────────────────────────────────────
-- RPCs (for the Edge Function to use via service_role connection)
-- ─────────────────────────────────────────────────────────────────

-- Get a cached response if it exists AND is fresh (<30 days). Increments
-- hit_count atomically as a side effect of returning a hit.
CREATE OR REPLACE FUNCTION public.google_cache_get(p_query_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT response_json, created_at INTO v_row
  FROM public.google_places_cache
  WHERE query_hash = p_query_hash
    AND created_at > NOW() - INTERVAL '30 days';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Increment hit counter (best-effort, ignore concurrency)
  UPDATE public.google_places_cache
  SET hit_count = hit_count + 1
  WHERE query_hash = p_query_hash;

  -- Also increment today's cache_hits counter
  INSERT INTO public.google_places_daily_counter (day, call_count, cache_hits, updated_at)
  VALUES (CURRENT_DATE, 0, 1, NOW())
  ON CONFLICT (day) DO UPDATE
    SET cache_hits = google_places_daily_counter.cache_hits + 1,
        updated_at = NOW();

  RETURN v_row.response_json;
END;
$$;

REVOKE ALL ON FUNCTION public.google_cache_get FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_cache_get TO service_role;


-- Upsert a fresh response into the cache.
CREATE OR REPLACE FUNCTION public.google_cache_put(
  p_query_hash TEXT,
  p_query TEXT,
  p_proximity_key TEXT,
  p_response_json JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.google_places_cache (
    query_hash, query, proximity_key, response_json, created_at, hit_count
  ) VALUES (
    p_query_hash, p_query, p_proximity_key, p_response_json, NOW(), 0
  )
  ON CONFLICT (query_hash) DO UPDATE
    SET response_json = EXCLUDED.response_json,
        created_at = NOW(),
        hit_count = 0;
END;
$$;

REVOKE ALL ON FUNCTION public.google_cache_put FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_cache_put TO service_role;


-- Returns today's API call count (excluding cache hits). The EF checks
-- this against a configured cap (default 1000) to protect the budget.
CREATE OR REPLACE FUNCTION public.google_cache_daily_count()
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT call_count FROM public.google_places_daily_counter WHERE day = CURRENT_DATE),
    0
  );
$$;

REVOKE ALL ON FUNCTION public.google_cache_daily_count FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_cache_daily_count TO service_role;


-- Atomic increment of today's API call counter. Called by the EF AFTER
-- a successful Google API call.
CREATE OR REPLACE FUNCTION public.google_cache_increment_call()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  INSERT INTO public.google_places_daily_counter (day, call_count, cache_hits, updated_at)
  VALUES (CURRENT_DATE, 1, 0, NOW())
  ON CONFLICT (day) DO UPDATE
    SET call_count = google_places_daily_counter.call_count + 1,
        updated_at = NOW()
  RETURNING call_count INTO v_new_count;

  RETURN v_new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.google_cache_increment_call FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_cache_increment_call TO service_role;


-- Lazy cleanup of entries >30 days old. Called periodically by the EF
-- (e.g. once per 100 requests via random sampling).
CREATE OR REPLACE FUNCTION public.google_cache_cleanup()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.google_places_cache
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Also prune daily counter > 90 days (auditing only)
  DELETE FROM public.google_places_daily_counter
  WHERE day < CURRENT_DATE - INTERVAL '90 days';

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.google_cache_cleanup FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.google_cache_cleanup TO service_role;
