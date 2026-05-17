-- ============================================================
-- POI prominence — make `cuba_pois.importance` a real ranking.
--
-- Problem: `importance` (the field the viewport RPC filters by) was
-- never assigned by the sync — `bulk_upsert_pois` doesn't set it, so
-- every synced POI fell to the column DEFAULT 5. Result: all 3.7k
-- Foursquare + 15.6k Overture POIs sit at importance 5 → invisible at
-- the ride-booking zoom. The map showed a biased, stale subset.
--
-- Also: ~43k POIs had NULL `tricigo_category`. Most are non-POI noise
-- (hamlets, rivers, rail, buildings, landuse) the viewport RPC already
-- excludes — but mixed in are REAL POIs whose category the sync's
-- `categories.json` never mapped (police, marketplaces, Overture/
-- Foursquare categories like accommodation / church / landmark).
--
-- This migration:
--   (a) backfills `tricigo_category` for the real-but-unmapped POIs;
--   (b) defines `compute_poi_importance()` — a deterministic prominence
--       score from category + contact data + source;
--   (c) backfills `importance` for every POI;
--   (d) adds a BEFORE INSERT/UPDATE trigger so `importance` is kept
--       correct forever (every sync / admin edit recomputes it).
-- ============================================================

-- (a) Classify the real POIs that the sync left with NULL tricigo_category.
--     The genuine noise (place / waterway / building / landuse / natural /
--     railway / highway) is left NULL — the viewport RPC filters it out.
UPDATE cuba_pois
SET tricigo_category = CASE
  -- amenity: real POIs the sync's categories.json never mapped.
  WHEN category = 'amenity' AND subcategory = 'police'           THEN 'gov'
  WHEN category = 'amenity' AND subcategory = 'marketplace'      THEN 'supermarket'
  WHEN category = 'amenity' AND subcategory = 'bureau_de_change' THEN 'bank'
  WHEN category = 'amenity' AND subcategory = 'food_court'       THEN 'restaurant'
  WHEN category = 'amenity' AND subcategory IN ('townhall','courthouse',
                                  'prison','fire_station')       THEN 'gov'
  WHEN category = 'amenity' AND subcategory IN ('library',
                                  'community_centre','social_facility') THEN 'gov'
  WHEN category = 'amenity' AND subcategory IN ('cinema','theatre',
                                  'arts_centre')                 THEN 'museum'
  -- tourism: information desks, attractions, lodging.
  WHEN category = 'tourism'  AND subcategory = 'information'      THEN 'other'
  WHEN category = 'tourism'  AND subcategory IN ('attraction','artwork',
                                  'viewpoint','gallery','museum','zoo',
                                  'theme_park','aquarium')        THEN 'museum'
  WHEN category = 'tourism'  AND subcategory IN ('guest_house','hostel','apartment',
                                  'motel','chalet','hotel','camp_site','cabin',
                                  'wilderness_hut','alpine_hut','beach_resort') THEN 'hotel'
  -- Overture / Foursquare top-level categories the sync left unmapped.
  WHEN category = 'accommodation'                                THEN 'hotel'
  WHEN category = 'church_cathedral'                             THEN 'religion'
  WHEN category = 'landmark_and_historical_building'             THEN 'museum'
  WHEN category = 'historic'                                     THEN 'museum'
  WHEN category = 'healthcare'                                   THEN 'hospital'
  WHEN category = 'leisure'                                      THEN 'park'
  WHEN category IN ('professional_services','office',
                    'structure_and_geography','other')           THEN 'other'
  ELSE tricigo_category
END
WHERE tricigo_category IS NULL
  AND category NOT IN ('highway','landuse','waterway','building',
                       'natural','barrier','place','man_made','railway');

-- (b) Deterministic prominence score → importance 1 (top) .. 5 (lowest).
--     Signals: curated flag, category tier, and corroboration (multi-
--     source merge or having contact data) which bumps a POI up a tier.
CREATE OR REPLACE FUNCTION public.compute_poi_importance(
  p_tricigo_category text,
  p_is_admin         boolean,
  p_website          text,
  p_phone            text,
  p_source           text
)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT GREATEST(1, LEAST(5,
    (CASE
      WHEN COALESCE(p_is_admin, false) THEN 1
      WHEN p_tricigo_category IN ('hospital','hotel','museum') THEN 2
      WHEN p_tricigo_category IN ('gov','school','embassy','bank','park',
                                  'beach','religion','supermarket','pharmacy',
                                  'gas_station') THEN 3
      WHEN p_tricigo_category IN ('restaurant','paladar','cafe','bar','atm',
                                  'shop','transport') THEN 4
      ELSE 5
    END)
    - (CASE
        WHEN NOT COALESCE(p_is_admin, false)
         AND ( p_source = 'merged'
            OR (p_website IS NOT NULL AND p_website <> '')
            OR (p_phone   IS NOT NULL AND p_phone   <> '') )
        THEN 1 ELSE 0 END)
  ))::smallint;
$$;

COMMENT ON FUNCTION public.compute_poi_importance(text,boolean,text,text,text) IS
  'Prominence score for a POI → importance 1 (top) .. 5 (lowest). Used by the importance backfill and the maintenance trigger.';

-- (c) Backfill importance for every POI from the score.
UPDATE cuba_pois
SET importance = compute_poi_importance(tricigo_category, is_admin, website, phone, source);

-- (d) Keep importance correct on every future insert / update (the sync
--     never set it — this is the root-cause fix so it can't rot again).
CREATE OR REPLACE FUNCTION public.tg_cuba_pois_set_importance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  NEW.importance := compute_poi_importance(
    NEW.tricigo_category, NEW.is_admin, NEW.website, NEW.phone, NEW.source);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cuba_pois_importance ON cuba_pois;
CREATE TRIGGER trg_cuba_pois_importance
  BEFORE INSERT OR UPDATE ON cuba_pois
  FOR EACH ROW
  EXECUTE FUNCTION tg_cuba_pois_set_importance();
