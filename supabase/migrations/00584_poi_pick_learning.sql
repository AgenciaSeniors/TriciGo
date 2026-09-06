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

-- 5. Venue name → POI on ride creation --------------------------------------
CREATE OR REPLACE FUNCTION public._poi_leading_venue_name(p_addr text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
  -- The venue part of a ride address: "Coppelia, Calle 23 e/ L y K, Plaza, La Habana" → "Coppelia".
  -- NULL for placeholders, corner / street forms, zone names, numeric or too-short text.
  SELECT CASE
    WHEN public._ride_address_is_placeholder(p_addr) THEN NULL
    WHEN v.lead IS NULL OR length(v.lead) < 3 OR length(v.lead) > 80 THEN NULL
    WHEN v.lead !~ '[[:alpha:]].*[[:alpha:]]' THEN NULL
    WHEN v.lead ~* '(^|\s)(e/|entre|esq\.?|esquina|y)(\s|$)' THEN NULL
    WHEN v.lead ~* '^(calle|calzada|avenida|ave\.?|av\.?|avda\.?|carretera|camino|callejon|callejón|paseo|linea|línea|km|kilometro|kilómetro|autopista|circunvalacion|circunvalación|reparto|rpto\.?|edificio|edif\.?|apto\.?|apartamento|cerca de)(\s|$)' THEN NULL
    WHEN v.lead ~ '^\d' THEN NULL
    WHEN lower(unaccent(v.lead)) IN (
      'vedado', 'el vedado', 'nuevo vedado', 'miramar', 'centro habana', 'habana vieja', 'la habana vieja', 'cerro',
      'playa', 'marianao', 'la lisa', 'boyeros', 'alamar', 'cojimar', 'santos suarez', 'lawton', 'luyano',
      'la vibora', 'vibora', 'siboney', 'kohly', 'casino deportivo', 'santa fe', 'guanabo', 'regla', 'guanabacoa',
      'la habana', 'habana', 'varadero', 'centro historico', 'reparto flores', 'buenavista', 'buena vista') THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.cuba_admin_areas a
                 WHERE lower(unaccent(a.name)) = lower(unaccent(v.lead))
                    OR lower(unaccent(COALESCE(a.name_es, ''))) = lower(unaccent(v.lead))) THEN NULL
    ELSE v.lead END
  FROM (SELECT NULLIF(btrim(split_part(COALESCE(p_addr, ''), ',', 1)), '') AS lead) v;
$$;
REVOKE ALL ON FUNCTION public._poi_leading_venue_name(text) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public._poi_leading_venue_name(text) IS
  '00584: the venue part of a ride address (text before the first comma) or NULL when it is a placeholder, a corner/street form, a zone name, numeric or too short.';

CREATE OR REPLACE FUNCTION public.tg_rides_learn_poi_picks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ep   record;
  v_name text;
  v_poi  bigint;
BEGIN
  FOR v_ep IN
    SELECT * FROM (VALUES
      ('pickup',  NEW.pickup_address,
         COALESCE(NEW.pickup_lat,  ST_Y(NEW.pickup_location::geometry)),
         COALESCE(NEW.pickup_lng,  ST_X(NEW.pickup_location::geometry))),
      ('dropoff', NEW.dropoff_address,
         COALESCE(NEW.dropoff_lat, ST_Y(NEW.dropoff_location::geometry)),
         COALESCE(NEW.dropoff_lng, ST_X(NEW.dropoff_location::geometry)))
    ) AS e(endpoint, addr, lat, lng)
  LOOP
    v_name := public._poi_leading_venue_name(v_ep.addr);
    IF v_name IS NULL OR v_ep.lat IS NULL OR v_ep.lng IS NULL THEN CONTINUE; END IF;
    v_poi := public.find_nearby_poi_match(v_name, v_ep.lat, v_ep.lng, 60);
    IF v_poi IS NOT NULL THEN
      UPDATE public.cuba_pois SET pick_count = pick_count + 1, last_picked_at = now()
       WHERE id = v_poi AND is_active AND merged_into IS NULL;
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.poi_import_queue q
        WHERE q.status = 'pending'
          AND lower(unaccent(q.name)) = lower(unaccent(v_name))
          AND abs(q.lat - v_ep.lat) < 0.002 AND abs(q.lng - v_ep.lng) < 0.002) THEN
      INSERT INTO public.poi_import_queue (ride_id, endpoint, name, lat, lng)
      VALUES (NEW.id, v_ep.endpoint, v_name, v_ep.lat, v_ep.lng);
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_rides_learn_poi_picks: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rides_learn_poi_picks ON public.rides;
CREATE TRIGGER trg_rides_learn_poi_picks
  AFTER INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_learn_poi_picks();
COMMENT ON FUNCTION public.tg_rides_learn_poi_picks() IS
  '00584: after a ride is created, the venue part of each address credits the matching POI (pick_count) or is queued in poi_import_queue. Defensive: never blocks the insert.';

-- 6. Drain cron (every 15 min, only when there is work) ----------------------
CREATE OR REPLACE FUNCTION public.drain_poi_import_queue_tick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.poi_import_queue WHERE status = 'pending') THEN
    RETURN NULL;
  END IF;
  RETURN public.cron_http_post('drain-poi-import-queue',
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/import-mapbox-poi',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || public.get_service_role_key(),
                 'apikey', public.get_service_role_key()),
    body    := '{"drain": 20}'::jsonb,
    timeout_milliseconds := 30000);
END $$;
REVOKE ALL ON FUNCTION public.drain_poi_import_queue_tick() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.drain_poi_import_queue_tick() IS
  '00584: cron body — posts {drain:20} to import-mapbox-poi through cron_http_post only when poi_import_queue has pending rows.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-poi-import-queue') THEN
      PERFORM cron.unschedule('drain-poi-import-queue');
    END IF;
    PERFORM cron.schedule('drain-poi-import-queue', '*/15 * * * *', $c$ SELECT public.drain_poi_import_queue_tick(); $c$);
    RAISE NOTICE '00584: cron drain-poi-import-queue scheduled (*/15)';
  ELSE
    RAISE NOTICE '00584: pg_cron absent; drain job not scheduled';
  END IF;
END $$;

RESET statement_timeout;
