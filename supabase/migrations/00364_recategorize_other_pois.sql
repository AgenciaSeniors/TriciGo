-- ============================================================
-- Migration 00364: re-categorize high-confidence "other" cuba_pois
--
-- WHY:
--   `other` is the 2nd-biggest tricigo_category. Many of those rows carry a
--   raw provider/OSM/Foursquare category that maps cleanly to an EXISTING
--   tricigo category, but were left as `other` → generic 📍 in search and
--   wrong map badges / category filters. PR-F1 already guarantees a display
--   emoji client-side; this fixes the DATA so the category is actually right.
--
-- WHAT THIS DOES (conservative — only high-confidence raw-category rules;
--   ambiguous rows like `other`/`professional_services`/`river` stay as-is):
--     public_transport / platform / stop_position   → transport  (~923)
--     eat_and_drink / dining* / fast_food            → restaurant (~81)
--     *church / place_of_worship / mosque / temple   → religion   (~34)
--     retail* / shopping_mall                        → shop       (~166)
--     botanical_garden / public_plaza / garden       → park       (~37)
--
--   Idempotent: each UPDATE re-filters by tricigo_category = 'other', so a
--   re-run is a no-op. Counts validated read-only against prod before writing.
-- ============================================================

UPDATE public.cuba_pois SET tricigo_category = 'transport'
WHERE tricigo_category = 'other'
  AND (
    category = 'public_transport'
    OR category ILIKE '%transit%'
    OR subcategory IN ('platform', 'stop_position', 'bus_stop', 'station')
  );

UPDATE public.cuba_pois SET tricigo_category = 'restaurant'
WHERE tricigo_category = 'other'
  AND (
    category = 'eat_and_drink'
    OR category ILIKE 'dining%'
    OR category ILIKE '%fast_food%'
  );

UPDATE public.cuba_pois SET tricigo_category = 'religion'
WHERE tricigo_category = 'other'
  AND (
    category ILIKE '%church%'
    OR category ILIKE '%place_of_worship%'
    OR category ILIKE '%mosque%'
    OR category ILIKE '%temple%'
  );

UPDATE public.cuba_pois SET tricigo_category = 'shop'
WHERE tricigo_category = 'other'
  AND (
    category ILIKE 'retail%'
    OR category ILIKE '%shopping_mall%'
  );

UPDATE public.cuba_pois SET tricigo_category = 'park'
WHERE tricigo_category = 'other'
  AND category IN ('botanical_garden', 'public_plaza', 'garden');
