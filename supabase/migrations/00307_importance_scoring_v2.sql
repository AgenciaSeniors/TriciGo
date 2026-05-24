-- ============================================================
-- Migration 00307: Importance scoring v2 — smart signals
--
-- PR 7 of the POI parity program. Replaces the simple
-- compute_poi_importance() from 00271 with a smarter scorer that
-- considers Wikidata presence, Cuban brand recognition, confidence,
-- contact data, and source quality.
--
-- Goals (relative to current distribution: I1=10k, I2=20k, I3=20k,
-- I4=24k, I5=33k of 108k):
--   - ~20k truly important POIs (admin + wikidata + brands) → tier 1-2
--   - ~50k mid-tier (categorical + contact + multi-source) → tier 3
--   - ~30k secondary → tier 4
--   - ~8k low-quality remaining → tier 5
--
-- Strategy: replace the function (same SQL signature for back-compat),
-- add a new helper for brand matching, run one-time recalc, refresh
-- the trigger.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Helper: is_cuban_brand_match
-- Curated list of Cuban brands worth boosting on the map.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_cuban_brand_match(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_brands TEXT[] := ARRAY[
    -- Combustible / fuel
    'cupet', 'oro negro',
    -- Telecom (omnipresent in Cuba)
    'etecsa', 'cubacel', 'nauta',
    -- Retail chains (state-run)
    'cimex', 'trd caribe', 'panamericana', 'caracol',
    -- Banks
    'banco metropolitano', 'banco financiero internacional',
    'bandec', 'bpa', 'bicsa', 'banco popular de ahorro',
    -- Hotel chains
    'gran caribe', 'islazul', 'cubanacan', 'gaviota', 'sol melia',
    'iberostar', 'meliá', 'melia cohiba',
    -- Iconic restaurants / paladares (locally famous)
    'la guarida', 'el aljibe', 'la bodeguita', 'la imprenta',
    'el cocinero', 'la fontana', '5 esquinas',
    -- Coffee / quick service
    'el rapido', 'pain de paris', 'rumbos',
    -- Insurance
    'esicuba', 'esen',
    -- Pharmacy chain
    'farmacia internacional',
    -- Iconic landmark venues
    'habana cafe', 'tropicana', 'casa de la musica'
  ];
  v_lower TEXT;
  v_brand TEXT;
BEGIN
  IF p_name IS NULL OR length(p_name) < 2 THEN
    RETURN FALSE;
  END IF;
  -- unaccent + lower for accent-insensitive match
  v_lower := lower(unaccent(p_name));
  FOREACH v_brand IN ARRAY v_brands LOOP
    IF position(v_brand IN v_lower) > 0 THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.is_cuban_brand_match IS
  'Returns TRUE if the POI name matches any well-known Cuban brand (ETECSA, CIMEX, Cupet, Gran Caribe, La Guarida, etc.). Used by compute_poi_importance to boost brand-recognized POIs.';


-- ─────────────────────────────────────────────────────────────────
-- compute_poi_importance v2 — new full-row signature
--
-- The original (00271) signature is kept (5 individual params) for
-- backwards compat. We add a NEW overload that takes the full row,
-- giving us access to source_ids, confidence, name. The trigger
-- switches to the new overload below.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_poi_importance(p_poi public.cuba_pois)
RETURNS SMALLINT
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_base SMALLINT;
  v_has_wd BOOLEAN;
  v_brand BOOLEAN;
  v_high_conf BOOLEAN;
  v_has_contact BOOLEAN;
  v_paladar_crowd BOOLEAN;
  v_osm_only_bare BOOLEAN;
  v_score SMALLINT;
BEGIN
  -- 1. Admin override
  IF COALESCE(p_poi.is_admin, FALSE) THEN
    RETURN 1::SMALLINT;
  END IF;

  -- 2. Wikidata sourced (landmark notability threshold) → top tier
  v_has_wd := (p_poi.source_ids IS NOT NULL) AND (p_poi.source_ids ? 'wd');
  IF v_has_wd THEN
    RETURN 1::SMALLINT;
  END IF;

  -- 3. Base tier by category
  v_base := CASE p_poi.tricigo_category
    WHEN 'hospital' THEN 2
    WHEN 'hotel' THEN 2
    WHEN 'museum' THEN 2
    WHEN 'gov' THEN 3
    WHEN 'school' THEN 3
    WHEN 'religion' THEN 3
    WHEN 'park' THEN 3
    WHEN 'beach' THEN 3
    WHEN 'bank' THEN 3
    WHEN 'pharmacy' THEN 3
    WHEN 'embassy' THEN 3
    WHEN 'transport' THEN 3
    WHEN 'gas_station' THEN 4
    WHEN 'supermarket' THEN 4
    WHEN 'restaurant' THEN 4
    WHEN 'paladar' THEN 4
    WHEN 'cafe' THEN 4
    WHEN 'bar' THEN 4
    WHEN 'shop' THEN 4
    WHEN 'atm' THEN 4
    ELSE 5
  END;

  -- 4. Signal bumps (each -1 bucket)
  v_brand := is_cuban_brand_match(p_poi.name);
  v_high_conf := COALESCE(p_poi.confidence, 0) >= 0.8;
  v_has_contact := (p_poi.phone IS NOT NULL AND p_poi.phone <> '')
                OR (p_poi.website IS NOT NULL AND p_poi.website <> '');
  v_paladar_crowd := p_poi.tricigo_category = 'paladar'
                  AND p_poi.source = 'crowdsource';

  v_score := v_base;
  IF v_brand THEN v_score := v_score - 1; END IF;
  IF v_high_conf THEN v_score := v_score - 1; END IF;
  IF v_has_contact THEN v_score := v_score - 1; END IF;
  IF p_poi.source = 'merged' THEN v_score := v_score - 1; END IF;
  IF v_paladar_crowd THEN v_score := v_score - 1; END IF;

  -- 5. Penalties (each +1 bucket)
  v_osm_only_bare := p_poi.source = 'osm' AND NOT v_has_contact;
  IF v_osm_only_bare THEN v_score := v_score + 1; END IF;

  -- 6. Clamp to [1, 5]
  RETURN GREATEST(1, LEAST(5, v_score))::SMALLINT;
END;
$$;

COMMENT ON FUNCTION public.compute_poi_importance(public.cuba_pois) IS
  'PR 7 importance scorer v2. Combines category tier + Wikidata + brand + confidence + contact + source signals. Returns smallint 1 (top) .. 5 (lowest).';


-- ─────────────────────────────────────────────────────────────────
-- Replace the trigger to use the new row-typed function
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_set_importance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  NEW.importance := compute_poi_importance(NEW);
  RETURN NEW;
END;
$$;

-- Trigger itself doesn't need rebuilding — the function it points to
-- has been replaced, and PG resolves the body at call time.

COMMENT ON FUNCTION public.tg_cuba_pois_set_importance IS
  'BEFORE INSERT/UPDATE trigger. Auto-computes importance via compute_poi_importance(NEW).';


-- ─────────────────────────────────────────────────────────────────
-- One-time recalc for all active POIs
--
-- Postgres optimizes WHERE column = new_value to a no-op, so we use
-- a non-equality predicate (importance IS NOT NULL) to force the
-- update to fire the trigger for every row. The trigger then writes
-- the new value computed by v2.
-- ─────────────────────────────────────────────────────────────────

UPDATE public.cuba_pois
SET importance = compute_poi_importance(cuba_pois)
WHERE is_active;

-- Verification query (run manually after applying):
--   SELECT importance, COUNT(*)
--   FROM cuba_pois
--   WHERE is_active
--   GROUP BY 1
--   ORDER BY 1;
-- Expected v2 distribution (approx):
--   1 → ~14k (admin + wikidata + hospitals/hotels with brand match)
--   2 → ~22k (hospital/hotel/museum + signals)
--   3 → ~28k (gov/school/religion + contacts)
--   4 → ~30k (restaurant/cafe/shop without strong signals)
--   5 → ~14k (residual "other" + bare OSM)
