-- ============================================================================
-- 00584 — learning from what riders pick
--
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §5.3
-- Plan: docs/superpowers/plans/2026-09-06-poi-quality-pr2-search.md
-- Depends on 00579 (pick_count, last_picked_at, merged_into, display_name,
-- cuba_poi_aliases), 00105 (check_rate_limit), 00506 (cron_http_post),
-- 00546 (_ride_address_is_placeholder).
--
-- 1. poi_import_queue — venue names from real rides that matched no POI
--    (RLS: admin read; the drain worker uses the service role).
-- 2. bump_poi_pick(id) — service-only +1 (drain worker).
-- 3. record_poi_pick(id) — authenticated, 60/h per user (PR-3 app taps).
-- 4. find_nearby_poi_match v2 — also matches display_name and aliases,
--    skips merged rows (feeds the trigger AND import_search_poi's dedupe).
-- 5. _poi_leading_venue_name + tg_rides_learn_poi_picks — AFTER INSERT ON
--    rides: the venue part of each address credits the POI (+1 pick) or is
--    queued. Defensive: never blocks the ride.
-- 6. drain_poi_import_queue_tick + cron every 15 min → import-mapbox-poi
--    {drain:20} through cron_http_post (CLAUDE.md rule: never raw
--    net.http_post), only when the queue has pending work.
-- ============================================================================
SET statement_timeout = 0;

-- 1. Queue ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.poi_import_queue (
  id           bigserial PRIMARY KEY,
  ride_id      uuid REFERENCES public.rides(id) ON DELETE SET NULL,
  endpoint     text NOT NULL CHECK (endpoint IN ('pickup', 'dropoff')),
  name         text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  poi_id       bigint REFERENCES public.cuba_pois(id) ON DELETE SET NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_poi_import_queue_pending ON public.poi_import_queue (created_at) WHERE status = 'pending';
ALTER TABLE public.poi_import_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS poi_import_queue_admin_read ON public.poi_import_queue;
CREATE POLICY poi_import_queue_admin_read ON public.poi_import_queue FOR SELECT TO authenticated USING (public.is_admin());
COMMENT ON TABLE public.poi_import_queue IS
  '00584: venue names from real rides that matched no POI. Drained every 15 min by import-mapbox-poi {drain:N} (service role). Admin reads it (PR-4 suspects tab); nobody else.';

-- 2. Service-only bump (drain worker) ----------------------------------------
CREATE OR REPLACE FUNCTION public.bump_poi_pick(p_poi_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  UPDATE public.cuba_pois SET pick_count = pick_count + 1, last_picked_at = now()
   WHERE id = p_poi_id AND is_active AND merged_into IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.bump_poi_pick(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_poi_pick(bigint) TO service_role;

-- 3. Rider pick (PR-3 app taps) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.record_poi_pick(p_poi_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_allowed boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT allowed INTO v_allowed FROM public.check_rate_limit('poi_pick:' || v_uid::text, 60, 3600);
  IF NOT COALESCE(v_allowed, false) THEN RETURN false; END IF;
  UPDATE public.cuba_pois SET pick_count = pick_count + 1, last_picked_at = now()
   WHERE id = p_poi_id AND is_active AND merged_into IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.record_poi_pick(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_poi_pick(bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public.record_poi_pick(bigint) IS
  '00584: +1 pick_count for a POI the rider chose in the app; 60/h per user; false when unauthenticated, rate-limited, inactive or merged.';

-- 4. find_nearby_poi_match v2 (same signature; live v1 md5 1cd4989ffe20bb7842cac5d3ef411823)
CREATE OR REPLACE FUNCTION public.find_nearby_poi_match(p_name text, p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 50)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_norm TEXT;
  v_id BIGINT;
BEGIN
  IF p_name IS NULL OR length(p_name) < 2 THEN
    RETURN NULL;
  END IF;
  v_norm := lower(unaccent(p_name));
  -- 00584: best of raw name, cleaned display_name and every alias; merged rows out.
  SELECT cp.id INTO v_id
  FROM public.cuba_pois cp
  CROSS JOIN LATERAL (
    SELECT GREATEST(
      similarity(cp.name_normalized, v_norm),
      similarity(lower(unaccent(COALESCE(cp.display_name, ''))), v_norm),
      COALESCE((SELECT max(similarity(a.alias_norm, v_norm)) FROM public.cuba_poi_aliases a WHERE a.poi_id = cp.id), 0)
    ) AS sim
  ) s
  WHERE cp.is_active
    AND cp.merged_into IS NULL
    AND cp.location IS NOT NULL
    AND ST_DWithin(cp.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, p_radius_m)
    AND cp.name_normalized IS NOT NULL
    AND s.sim >= 0.6
  ORDER BY s.sim DESC,
           ST_Distance(cp.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) ASC,
           cp.id ASC
  LIMIT 1;
  RETURN v_id;
END;
$function$;
COMMENT ON FUNCTION public.find_nearby_poi_match(text, double precision, double precision, integer) IS
  '00584 v2: similarity ≥ 0.6 against raw name, display_name or any alias within p_radius_m; merged rows excluded; ties by distance then id.';

RESET statement_timeout;
