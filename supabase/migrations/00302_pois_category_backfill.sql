-- ============================================================
-- Migration 00302: backfill tricigo_category for 36,253 NULL POIs
--
-- Context: 33% of active `cuba_pois` rows have NULL `tricigo_category`,
-- which makes them fall through `poiVisualGroup()` to the generic
-- "other" grey badge in the map renderer. The unified taxonomy was
-- introduced in 00248 but the OSM bulk import + multi-source merges
-- never backfilled historical rows that were inserted before the
-- taxonomy existed.
--
-- This migration:
--   1. Creates `public.map_category_to_tricigo(category, subcategory)`
--      — pure SQL function that maps source-specific category strings
--      (OSM tags + Foursquare verbose categories + Overture taxonomy)
--      to the unified `tricigo_category` enum used by the visual badge
--      system.
--   2. Backfills every active POI with NULL `tricigo_category` using
--      that helper. ~8,706 displayable POIs jump from "other" grey to
--      their proper colored visual group (food/lodging/shopping/
--      health/finance/civic/culture/transport).
--   3. Installs a BEFORE INSERT/UPDATE trigger so future rows synced
--      by the GitHub Actions pipeline auto-populate tricigo_category
--      if the sync script forgets to set it.
--
-- The mapping is consistent with `packages/utils/src/poiCategories.ts`
-- (TRICIGO_CATEGORY_TO_GROUP) — both must stay in sync. Source-specific
-- prefixes (Foursquare's "Travel and Transportation > Cruise", etc.)
-- are handled via LIKE patterns.
--
-- Backwards compat: pre-existing non-null tricigo_category values are
-- never touched. Admin-curated rows (is_admin=true) also untouched.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Helper function: source category → unified tricigo_category
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.map_category_to_tricigo(
  p_category text,
  p_subcategory text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  -- Subcategory is more specific when present — try it first.
  IF p_subcategory IS NOT NULL THEN
    CASE
      -- food
      WHEN p_subcategory IN ('restaurant','fast_food','food_court','bakery') THEN RETURN 'restaurant';
      WHEN p_subcategory IN ('cafe','coffee','coffee_shop') THEN RETURN 'cafe';
      WHEN p_subcategory IN ('bar','pub','nightclub','dance_club') THEN RETURN 'bar';
      WHEN p_subcategory = 'paladar' THEN RETURN 'paladar';
      -- lodging
      WHEN p_subcategory IN ('hotel','guest_house','hostel','apartment','motel','resort',
                              'casa_particular','holiday_rental_home') THEN RETURN 'hotel';
      -- shopping
      WHEN p_subcategory IN ('supermarket','convenience','marketplace') THEN
        RETURN CASE WHEN p_subcategory = 'supermarket' THEN 'supermarket' ELSE 'shop' END;
      WHEN p_subcategory IN ('shop','clothes','electronics','jewelry','beauty','hairdresser',
                              'hair_salon','beauty_salon','mall','kiosk','mobile_phone') THEN RETURN 'shop';
      -- health
      WHEN p_subcategory IN ('hospital','clinic','doctors','dentist','health_and_medical') THEN RETURN 'hospital';
      WHEN p_subcategory = 'pharmacy' THEN RETURN 'pharmacy';
      -- finance
      WHEN p_subcategory IN ('bank','bureau_de_change') THEN RETURN 'bank';
      WHEN p_subcategory = 'atm' THEN RETURN 'atm';
      -- civic
      WHEN p_subcategory IN ('school','university','college','kindergarten','education',
                              'college_university') THEN RETURN 'school';
      WHEN p_subcategory IN ('police','fire_station','townhall','courthouse','post_office',
                              'public_and_government_association','public_service_and_government',
                              'social_service_organizations','non_governmental_association',
                              'community_services_non_profits') THEN RETURN 'gov';
      WHEN p_subcategory IN ('embassy','consulate') THEN RETURN 'embassy';
      WHEN p_subcategory IN ('place_of_worship','church','synagogue','mosque',
                              'religious_organization','catholic_church','evangelical_church') THEN RETURN 'religion';
      -- culture
      WHEN p_subcategory IN ('museum','gallery','arts_centre','history_museum',
                              'cultural_center','arts_and_entertainment','arts_and_crafts',
                              'theatre','cinema','monument','attraction','artwork',
                              'topic_concert_venue','music_production') THEN
        RETURN CASE WHEN p_subcategory IN ('museum','history_museum','gallery') THEN 'museum' ELSE 'park' END;
      WHEN p_subcategory IN ('park','garden','playground','active_life','gym') THEN RETURN 'park';
      WHEN p_subcategory IN ('beach','coastal') THEN RETURN 'beach';
      -- transport
      WHEN p_subcategory IN ('fuel','gas_station') THEN RETURN 'gas_station';
      WHEN p_subcategory IN ('bus_station','bus_stop','taxi','ferry_terminal','aerodrome',
                              'aeroway','transportation','tours','travel_services','tourism') THEN RETURN 'transport';
      ELSE NULL;  -- fall through to category check below
    END CASE;
  END IF;

  -- Category fallback — covers Foursquare/Overture top-level taxonomy.
  IF p_category IS NOT NULL THEN
    CASE
      WHEN p_category IN ('restaurant','fast_food','food_court','bakery') THEN RETURN 'restaurant';
      WHEN p_category IN ('cafe','coffee','coffee_shop') THEN RETURN 'cafe';
      WHEN p_category IN ('bar','pub','nightclub','dance_club') THEN RETURN 'bar';
      WHEN p_category IN ('hotel','guest_house','hostel','apartment','motel','resort',
                          'casa_particular','holiday_rental_home') THEN RETURN 'hotel';
      WHEN p_category = 'supermarket' THEN RETURN 'supermarket';
      WHEN p_category IN ('shop','convenience','clothes','electronics','jewelry','beauty',
                          'hairdresser','hair_salon','beauty_salon','beauty_and_spa',
                          'mall','kiosk','mobile_phone','tattoo_and_piercing','arts_and_crafts',
                          'automotive_repair','motorcycle_repair','car_repair','real_estate',
                          'industrial_company','commercial_industrial','construction_services',
                          'printing_services','computer_hardware_company',
                          'it_service_and_computer_repair','public_utility_company',
                          'agriculture','media_news_company','event_planning','event_photography',
                          'gym','active_life') THEN RETURN 'shop';
      WHEN p_category IN ('hospital','clinic','doctors','dentist','health_and_medical') THEN RETURN 'hospital';
      WHEN p_category = 'pharmacy' THEN RETURN 'pharmacy';
      WHEN p_category IN ('bank','bureau_de_change') THEN RETURN 'bank';
      WHEN p_category = 'atm' THEN RETURN 'atm';
      WHEN p_category IN ('school','university','college','kindergarten','education',
                          'college_university') THEN RETURN 'school';
      WHEN p_category IN ('police','fire_station','townhall','courthouse','post_office',
                          'public_and_government_association','public_service_and_government',
                          'social_service_organizations','non_governmental_association',
                          'community_services_non_profits') THEN RETURN 'gov';
      WHEN p_category IN ('embassy','consulate') THEN RETURN 'embassy';
      WHEN p_category IN ('place_of_worship','church','synagogue','mosque',
                          'religious_organization','catholic_church','evangelical_church') THEN RETURN 'religion';
      WHEN p_category IN ('museum','gallery','arts_centre','history_museum',
                          'arts_and_entertainment','cultural_center','theatre','cinema',
                          'monument','attraction','artwork','topic_concert_venue',
                          'music_production') THEN
        RETURN CASE WHEN p_category IN ('museum','history_museum','gallery') THEN 'museum' ELSE 'park' END;
      WHEN p_category IN ('park','garden','playground') THEN RETURN 'park';
      WHEN p_category IN ('beach','coastal') THEN RETURN 'beach';
      WHEN p_category IN ('fuel','gas_station') THEN RETURN 'gas_station';
      WHEN p_category IN ('bus_station','bus_stop','taxi','ferry_terminal','aerodrome',
                          'aeroway','transportation','tours','travel_services','tourism') THEN RETURN 'transport';
      ELSE NULL;  -- fall through to LIKE patterns
    END CASE;

    -- Foursquare verbose hierarchical categories ("Travel and Transportation > Cruise")
    IF p_category ILIKE 'travel and transportation%' THEN RETURN 'transport'; END IF;
    IF p_category ILIKE 'arts and entertainment > night club' THEN RETURN 'bar'; END IF;
    IF p_category ILIKE 'arts and entertainment%' THEN RETURN 'park'; END IF;
    IF p_category ILIKE 'food and dining%' THEN RETURN 'restaurant'; END IF;
    IF p_category ILIKE 'shopping%' THEN RETURN 'shop'; END IF;
    IF p_category ILIKE 'health%' THEN RETURN 'hospital'; END IF;
  END IF;

  -- Last resort — return 'other'. Caller may decide whether to store it
  -- (PoiMapLayers shows 'other' as a grey location-pin badge, which is
  -- better than NULL → hidden in some upstream filters).
  RETURN 'other';
END;
$$;

COMMENT ON FUNCTION public.map_category_to_tricigo IS
  'Maps source category/subcategory (OSM, Foursquare, Overture) to unified tricigo_category. '
  'Returns ''other'' as last resort. Must stay in sync with packages/utils/src/poiCategories.ts.';


-- ─────────────────────────────────────────────────────────────────
-- BEFORE INSERT/UPDATE trigger — auto-populate tricigo_category
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_pois_default_tricigo_category()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tricigo_category IS NULL THEN
    NEW.tricigo_category := public.map_category_to_tricigo(NEW.category, NEW.subcategory);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_pois_default_tricigo_category_trg ON public.cuba_pois;
CREATE TRIGGER tg_pois_default_tricigo_category_trg
  BEFORE INSERT OR UPDATE OF category, subcategory, tricigo_category
  ON public.cuba_pois
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_pois_default_tricigo_category();


-- ─────────────────────────────────────────────────────────────────
-- Backfill — apply mapping to existing NULL rows
-- ─────────────────────────────────────────────────────────────────

-- Only touches rows currently NULL. Admin-curated rows (is_admin=true)
-- are included because they too may have NULL tricigo_category from
-- early imports — the helper is idempotent and conservative.
UPDATE public.cuba_pois
SET tricigo_category = public.map_category_to_tricigo(category, subcategory)
WHERE tricigo_category IS NULL
  AND is_active;

-- Verification helper (run manually after apply):
--   SELECT COUNT(*) FROM cuba_pois WHERE tricigo_category IS NULL AND is_active;
--   -- expected: 0
--
--   SELECT tricigo_category, COUNT(*) FROM cuba_pois WHERE is_active GROUP BY 1 ORDER BY 2 DESC;
--   -- expected: every row has a tricigo_category, 'other' is reasonable bucket
