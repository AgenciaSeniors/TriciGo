-- ============================================================================
-- Migration 00581: POI taxonomy v2, garbage cleanup, duplicate merge, brand fix
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §4.5 / §4.7
-- Depends on 00579 (curation columns, poi_taxonomy(), dictionary triggers).
-- Rehearsed on supabase/tests/poi/ (T7); idempotent — every step is guarded.
--
-- 1. map_category_to_tricigo v2: theatre/cinema → venue, monuments/historic →
--    landmark, stadiums → stadium, Foursquare "Landmarks and Outdoors" split.
--    Full CREATE OR REPLACE over the 00302 body (live md5 asserted first).
-- 2. Search keywords for the new categories.
-- 3. import_search_poi allow-list accepts the new values (in-place patch).
-- 4. Re-map rows whose stored category now resolves to a new value.
-- 5. Deactivate Wikidata-Swedish descriptor rows ("Arroyo X (vattendrag i
--    Kuba…)") — 195 streams / islets / hills imported as landmarks.
-- 6. CUPET brand → gas_station via category_override (sync-proof).
-- 7. Exact duplicates (same normalised name + category ≤ 150 m): one winner.
-- 8. Validate the tricigo_category CHECK left NOT VALID by 00579.
-- ============================================================================

-- 1. Guard: the live mapper must be the 00302 body we edited from, or already v2.
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE proname = 'map_category_to_tricigo' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS NULL THEN RAISE NOTICE '00581: map_category_to_tricigo absent — creating v2';
  ELSIF v_md5 = '2ef5ae47ff6e2c349f9884b2f6735d58' THEN RAISE NOTICE '00581: live mapper is the 00302 body — replacing with v2';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'map_category_to_tricigo' AND pronamespace = 'public'::regnamespace AND prosrc LIKE '%00581: venue%') THEN
    RAISE NOTICE '00581: mapper already v2 — re-applying the same body';
  ELSE
    RAISE EXCEPTION '00581: map_category_to_tricigo has an unknown body (md5 %). Re-derive v2 from pg_get_functiondef before applying.', v_md5;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.map_category_to_tricigo(p_category text, p_subcategory text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF p_subcategory IS NOT NULL THEN
    CASE
      WHEN p_subcategory IN ('restaurant','fast_food','food_court','bakery') THEN RETURN 'restaurant';
      WHEN p_subcategory IN ('cafe','coffee','coffee_shop') THEN RETURN 'cafe';
      WHEN p_subcategory IN ('bar','pub','nightclub','dance_club') THEN RETURN 'bar';
      WHEN p_subcategory = 'paladar' THEN RETURN 'paladar';
      WHEN p_subcategory IN ('hotel','guest_house','hostel','apartment','motel','resort',
                              'casa_particular','holiday_rental_home') THEN RETURN 'hotel';
      WHEN p_subcategory IN ('supermarket','convenience','marketplace') THEN
        RETURN CASE WHEN p_subcategory = 'supermarket' THEN 'supermarket' ELSE 'shop' END;
      WHEN p_subcategory IN ('shop','clothes','electronics','jewelry','beauty','hairdresser',
                              'hair_salon','beauty_salon','mall','kiosk','mobile_phone') THEN RETURN 'shop';
      WHEN p_subcategory IN ('hospital','clinic','doctors','dentist','health_and_medical') THEN RETURN 'hospital';
      WHEN p_subcategory = 'pharmacy' THEN RETURN 'pharmacy';
      WHEN p_subcategory IN ('bank','bureau_de_change') THEN RETURN 'bank';
      WHEN p_subcategory = 'atm' THEN RETURN 'atm';
      WHEN p_subcategory IN ('school','university','college','kindergarten','education',
                              'college_university') THEN RETURN 'school';
      WHEN p_subcategory IN ('police','fire_station','townhall','courthouse','post_office',
                              'public_and_government_association','public_service_and_government',
                              'social_service_organizations','non_governmental_association',
                              'community_services_non_profits') THEN RETURN 'gov';
      WHEN p_subcategory IN ('embassy','consulate') THEN RETURN 'embassy';
      WHEN p_subcategory IN ('place_of_worship','church','synagogue','mosque',
                              'religious_organization','catholic_church','evangelical_church') THEN RETURN 'religion';
      WHEN p_subcategory IN ('museum','gallery','history_museum') THEN RETURN 'museum';
      -- 00581: venue / landmark / stadium split out of the old museum-else-park group.
      WHEN p_subcategory IN ('theatre','cinema','topic_concert_venue','music_production','cabaret',
                              'nightclub_venue','concert_hall','performing_arts','amphitheatre') THEN RETURN 'venue';
      WHEN p_subcategory IN ('monument','attraction','artwork','landmark','landmark_and_historical_building',
                              'historic','memorial','ruins','archaeological_site','fort','fortress','castle',
                              'lighthouse','public_plaza','tower','viewpoint','wayside_shrine') THEN RETURN 'landmark';
      WHEN p_subcategory IN ('stadium','sports_stadium','sports_complex','arena','baseball_stadium',
                              'soccer_stadium') THEN RETURN 'stadium';
      WHEN p_subcategory IN ('arts_centre','cultural_center','arts_and_entertainment','arts_and_crafts') THEN RETURN 'park';
      WHEN p_subcategory IN ('park','garden','playground','active_life','gym') THEN RETURN 'park';
      WHEN p_subcategory IN ('beach','coastal') THEN RETURN 'beach';
      WHEN p_subcategory IN ('fuel','gas_station') THEN RETURN 'gas_station';
      WHEN p_subcategory IN ('bus_station','bus_stop','taxi','ferry_terminal','aerodrome',
                              'aeroway','transportation','tours','travel_services','tourism') THEN RETURN 'transport';
      ELSE NULL;
    END CASE;
  END IF;

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
      WHEN p_category IN ('museum','gallery','history_museum') THEN RETURN 'museum';
      -- 00581: venue / landmark / stadium split out of the old museum-else-park group.
      WHEN p_category IN ('theatre','cinema','topic_concert_venue','music_production','cabaret',
                          'nightclub_venue','concert_hall','performing_arts','amphitheatre') THEN RETURN 'venue';
      WHEN p_category IN ('monument','attraction','artwork','landmark','landmark_and_historical_building',
                          'historic','memorial','ruins','archaeological_site','fort','fortress','castle',
                          'lighthouse','public_plaza','tower','viewpoint','wayside_shrine') THEN RETURN 'landmark';
      WHEN p_category IN ('stadium','sports_stadium','sports_complex','arena','baseball_stadium',
                          'soccer_stadium') THEN RETURN 'stadium';
      WHEN p_category IN ('arts_centre','cultural_center','arts_and_entertainment') THEN RETURN 'park';
      WHEN p_category IN ('park','garden','playground') THEN RETURN 'park';
      WHEN p_category IN ('beach','coastal') THEN RETURN 'beach';
      WHEN p_category IN ('fuel','gas_station') THEN RETURN 'gas_station';
      WHEN p_category IN ('bus_station','bus_stop','taxi','ferry_terminal','aerodrome',
                          'aeroway','transportation','tours','travel_services','tourism') THEN RETURN 'transport';
      ELSE NULL;
    END CASE;

    IF p_category ILIKE 'travel and transportation%' THEN RETURN 'transport'; END IF;
    -- 00581: Foursquare "Landmarks and Outdoors > …" (neighbourhood/city rows stay
    -- 'other'; beaches, parks and marinas keep their own category; the rest is a landmark).
    IF p_category ILIKE 'landmarks and outdoors > states and municipalities%' THEN RETURN 'other'; END IF;
    IF p_category ILIKE 'landmarks and outdoors%' THEN
      IF p_category ~* '(beach|bathing area|\ybay\y|dive spot|surf spot|waterfront)' THEN RETURN 'beach'; END IF;
      IF p_category ~* '(harbor|marina)' THEN RETURN 'transport'; END IF;
      IF p_category ~* '(park|garden|cave|waterfall|scenic lookout|mountain|river|lake|hiking|nature preserve|forest|campground|great outdoors)' THEN RETURN 'park'; END IF;
      IF p_category ~* '(farm|stable|\yfield\y|\ytree\y|roof deck)' THEN RETURN 'other'; END IF;
      RETURN 'landmark';
    END IF;
    IF p_category ILIKE 'arts and entertainment > night club' OR p_category ILIKE 'arts and entertainment > salsa club' THEN RETURN 'bar'; END IF;
    IF p_category ILIKE 'arts and entertainment > museum%' OR p_category ILIKE 'arts and entertainment > art gallery' THEN RETURN 'museum'; END IF;
    IF p_category ILIKE 'arts and entertainment > performing arts venue%' OR p_category ILIKE 'arts and entertainment > movie theater%'
       OR p_category ILIKE 'arts and entertainment > comedy club' THEN RETURN 'venue'; END IF;
    IF p_category ILIKE 'arts and entertainment > stadium%' THEN RETURN 'stadium'; END IF;
    IF p_category ILIKE 'arts and entertainment > public art%' THEN RETURN 'landmark'; END IF;
    IF p_category ILIKE 'arts and entertainment%' THEN RETURN 'park'; END IF;
    IF p_category ILIKE 'food and dining%' THEN RETURN 'restaurant'; END IF;
    IF p_category ILIKE 'shopping%' THEN RETURN 'shop'; END IF;
    IF p_category ILIKE 'health%' THEN RETURN 'hospital'; END IF;
  END IF;

  RETURN 'other';
END;
$function$;

-- 2. Keywords (categories only — 00551 keeps brands out of this table).
INSERT INTO public.cuba_search_keywords (keyword, tricigo_category) VALUES
  ('teatro','venue'), ('cine','venue'), ('cabaret','venue'), ('sala de conciertos','venue'),
  ('estadio','stadium'), ('coliseo','stadium'), ('monumento','landmark'), ('memorial','landmark'),
  ('fortaleza','landmark'), ('castillo','landmark'), ('faro','landmark'), ('malecon','landmark')
ON CONFLICT (keyword) DO UPDATE SET tricigo_category = EXCLUDED.tricigo_category;

-- 3. import_search_poi allow-list: patch in place (the literal appears once in the live body).
DO $patch$
DECLARE v_src text; v_n int;
  c_t CONSTANT text := '''supermarket'',''restaurant'',''paladar'',''cafe'',''bar'',''shop'',''atm''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'import_search_poi';
  IF v_src IS NULL OR position('''landmark''' IN v_src) > 0 THEN RAISE NOTICE '00581: import_search_poi absent or already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_t, ''))) / length(c_t);
  IF v_n <> 1 THEN RAISE EXCEPTION '00581: import_search_poi allow-list found % times', v_n; END IF;
  EXECUTE replace(v_src, c_t, c_t || ',''landmark'',''venue'',''stadium''');
  RAISE NOTICE '00581: import_search_poi allow-list patched';
END $patch$;

-- 4. Re-map rows whose stored category now resolves to a NEW value (only where
--    nothing was curated). Rows the sync labelled museum/park/other from a
--    theatre / monument / stadium source category move to venue / landmark /
--    stadium; scripts/sync-pois/categories.json (same PR) makes the weekly sync
--    agree, so it cannot flip them back.
UPDATE public.cuba_pois p SET tricigo_category = public.map_category_to_tricigo(p.category, p.subcategory)
 WHERE p.is_active AND NOT p.is_admin AND p.category_override IS NULL
   AND public.map_category_to_tricigo(p.category, p.subcategory) IN ('landmark','venue','stadium')
   AND p.tricigo_category IS DISTINCT FROM public.map_category_to_tricigo(p.category, p.subcategory);

-- 5. Wikidata Swedish descriptors imported by Overture as "landmarks": streams,
--    islets, hills. 182 rows carry "… i Kuba", 13 more only the noun.
UPDATE public.cuba_pois SET is_active = false, updated_at = now()
 WHERE is_active AND NOT is_admin
   AND (name ~* '\(((ö|öar|vattendrag|periodiskt|sjö|berg|by|ort|udde|bukt|flod|kulle|kommun|stad|halvö|lagun|vik|kanal|damm|grotta)\s+)+i\s+kuba\y'
     OR name ~* '\(((periodiskt|vattendrag|ö|öar|sjö|udde|bukt|flod|kulle|halvö|lagun|vik|kanal|damm|grotta)\s*)+\)');

-- 6. Brand → category (curated override so the weekly sync cannot undo it).
UPDATE public.cuba_pois SET category_override = 'gas_station'
 WHERE is_active AND category_override IS NULL
   AND (lower(coalesce(tags->>'brand','')) = 'cupet' OR lower(coalesce(tags->>'operator','')) LIKE 'cupet%' OR name_normalized ~ '^cupet\M')
   AND coalesce(tricigo_category,'') <> 'gas_station';

-- 7. Exact duplicates: same normalised name, same effective category, ≤ 150 m.
--    One winner per pair: is_admin > merged > overture > foursquare > osm, then
--    confidence, then lowest id. The loser is deactivated with merged_into set
--    (its dictionary rows leave via the 00579 trigger); the winner inherits the
--    loser's source_ids so the sync keeps matching both upstream ids. Admin rows
--    are never deactivated (0 admin-admin pairs in prod; PR-4 lists any).
DO $merge$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    WITH act AS (
      SELECT id, name_normalized, coalesce(category_override, tricigo_category) AS cat, location, source, is_admin, confidence, source_ids
      FROM public.cuba_pois WHERE is_active AND merged_into IS NULL),
    pairs AS (
      SELECT a.id AS a_id, b.id AS b_id,
        CASE WHEN a.is_admin THEN 4 WHEN a.source='merged' THEN 3 WHEN a.source='overture' THEN 2 WHEN a.source='foursquare' THEN 1 ELSE 0 END AS a_rank,
        CASE WHEN b.is_admin THEN 4 WHEN b.source='merged' THEN 3 WHEN b.source='overture' THEN 2 WHEN b.source='foursquare' THEN 1 ELSE 0 END AS b_rank,
        a.confidence AS a_conf, b.confidence AS b_conf
      FROM act a JOIN act b ON a.id < b.id AND a.name_normalized = b.name_normalized AND a.cat IS NOT DISTINCT FROM b.cat
       AND ST_DWithin(a.location, b.location, 150))
    SELECT CASE WHEN (a_rank, coalesce(a_conf,0), -a_id) >= (b_rank, coalesce(b_conf,0), -b_id) THEN a_id ELSE b_id END AS winner,
           CASE WHEN (a_rank, coalesce(a_conf,0), -a_id) >= (b_rank, coalesce(b_conf,0), -b_id) THEN b_id ELSE a_id END AS loser
    FROM pairs
  LOOP
    -- A row already merged in an earlier iteration is skipped (cluster of 3+).
    IF EXISTS (SELECT 1 FROM public.cuba_pois WHERE id IN (r.winner, r.loser) AND (merged_into IS NOT NULL OR NOT is_active)) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.cuba_pois WHERE id = r.loser AND is_admin) THEN CONTINUE; END IF;
    UPDATE public.cuba_pois w SET source_ids = w.source_ids || l.source_ids, updated_at = now()
      FROM public.cuba_pois l WHERE w.id = r.winner AND l.id = r.loser;
    UPDATE public.cuba_pois SET is_active = false, merged_into = r.winner, updated_at = now() WHERE id = r.loser;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '00581: % duplicate rows merged', v_n;
END $merge$;

-- 8. Every stored category is inside the taxonomy now → validate the NOT VALID
--    CHECK from 00579 (0 rows outside it in prod on 2026-09-05; the UPDATE is a belt).
UPDATE public.cuba_pois SET tricigo_category = 'other' WHERE tricigo_category IS NOT NULL AND NOT (tricigo_category = ANY (public.poi_taxonomy()));
ALTER TABLE public.cuba_pois VALIDATE CONSTRAINT cuba_pois_tricigo_category_chk;
