-- ============================================================================
-- Migration 00581: POI taxonomy v2, garbage cleanup, duplicate merge, brand fix
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §4.5 / §4.7
-- Depends on 00579 (curation columns, poi_taxonomy(), dictionary triggers).
-- Rehearsed on supabase/tests/poi/ (T7); idempotent — every step is guarded.
--
-- 1. map_category_to_tricigo v2: theatre/cinema → venue, monuments/historic →
--    landmark, stadiums → stadium, Foursquare "Landmarks and Outdoors" split.
--    The body is GENERATED from scripts/sync-pois/categories.json by
--    scripts/sync-pois/gen-sql-mapper.mjs (same PR) and CI keeps both equal, so
--    the weekly sync — which rewrites tricigo_category from that JSON — can never
--    flip what this migration sets. Live md5 asserted first.
-- 2. Search keywords for the new categories.
-- 3. import_search_poi allow-list accepts the new values (in-place patch).
-- 4. Re-map rows whose stored category now resolves to a new value.
-- 5. Deactivate Wikidata-Swedish natural-feature rows ("Arroyo X (vattendrag i
--    Kuba…)") — streams / mines / shoals / hills imported as landmarks; islands
--    and towns keep their (cleaned) name and stay active.
-- 5b. Rows nobody can ride to: no Latin letter in the name, flight codes,
--    pins outside every province polygon (guarded by the admin-area count).
-- 6. CUPET brand → gas_station via category_override (sync-proof).
-- 7. Duplicates: same normalised name and (a) same category ≤ 150 m or
--    (b) different category ≤ 60 m with neither side a transport stop: one winner.
-- 8. Validate the tricigo_category CHECK left NOT VALID by 00579.
-- ============================================================================

-- 1. Guard: the live mapper must be the 00302 body we edited from, or already v2.
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE proname = 'map_category_to_tricigo' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS NULL THEN RAISE NOTICE '00581: map_category_to_tricigo absent — creating v2';
  ELSIF v_md5 = '2ef5ae47ff6e2c349f9884b2f6735d58' THEN RAISE NOTICE '00581: live mapper is the 00302 body — replacing with v2';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'map_category_to_tricigo' AND pronamespace = 'public'::regnamespace AND prosrc LIKE '%GENERATED from scripts/sync-pois/categories.json%') THEN
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
-- GENERATED from scripts/sync-pois/categories.json by scripts/sync-pois/gen-sql-mapper.mjs.
-- Do not edit by hand: edit the JSON, regenerate, paste into a NEW migration.
-- Mirror of merge_and_upsert.py: OSM `tag=value` exact then `tag=*`; a Foursquare label
-- (anything with whitespace or '>') takes the FIRST keyword found in its normalised path,
-- so the order of c_fsq is semantics; any other single category (Overture, merged rows)
-- is exact then first substring. Unknown → 'other'.
DECLARE
  v_cat  text := lower(btrim(p_category));
  v_sub  text := lower(btrim(p_subcategory));
  v_key  text;
  v_wild text;
  v_pair text[];
  c_osm CONSTANT text[][] := ARRAY[
    ['amenity=hospital', 'hospital'],
    ['amenity=clinic', 'hospital'],
    ['amenity=doctors', 'hospital'],
    ['amenity=dentist', 'hospital'],
    ['amenity=pharmacy', 'pharmacy'],
    ['healthcare=hospital', 'hospital'],
    ['healthcare=pharmacy', 'pharmacy'],
    ['healthcare=*', 'hospital'],
    ['amenity=school', 'school'],
    ['amenity=university', 'school'],
    ['amenity=college', 'school'],
    ['amenity=kindergarten', 'school'],
    ['amenity=library', 'school'],
    ['amenity=townhall', 'gov'],
    ['amenity=courthouse', 'gov'],
    ['amenity=post_office', 'gov'],
    ['amenity=public_building', 'gov'],
    ['amenity=police', 'gov'],
    ['amenity=fire_station', 'gov'],
    ['amenity=prison', 'gov'],
    ['amenity=community_centre', 'gov'],
    ['amenity=social_facility', 'gov'],
    ['office=government', 'gov'],
    ['office=diplomatic', 'embassy'],
    ['amenity=embassy', 'embassy'],
    ['tourism=hotel', 'hotel'],
    ['tourism=guest_house', 'hotel'],
    ['tourism=hostel', 'hotel'],
    ['tourism=motel', 'hotel'],
    ['tourism=apartment', 'hotel'],
    ['tourism=chalet', 'hotel'],
    ['tourism=camp_site', 'hotel'],
    ['tourism=cabin', 'hotel'],
    ['tourism=wilderness_hut', 'hotel'],
    ['tourism=alpine_hut', 'hotel'],
    ['tourism=beach_resort', 'hotel'],
    ['amenity=restaurant', 'restaurant'],
    ['amenity=food_court', 'restaurant'],
    ['amenity=cafe', 'cafe'],
    ['amenity=ice_cream', 'cafe'],
    ['amenity=fast_food', 'restaurant'],
    ['amenity=bar', 'bar'],
    ['amenity=pub', 'bar'],
    ['amenity=biergarten', 'bar'],
    ['amenity=nightclub', 'bar'],
    ['shop=supermarket', 'supermarket'],
    ['shop=convenience', 'supermarket'],
    ['shop=mall', 'shop'],
    ['shop=department_store', 'shop'],
    ['amenity=marketplace', 'supermarket'],
    ['shop=*', 'shop'],
    ['amenity=bank', 'bank'],
    ['amenity=bureau_de_change', 'bank'],
    ['amenity=atm', 'atm'],
    ['amenity=fuel', 'gas_station'],
    ['tourism=museum', 'museum'],
    ['tourism=gallery', 'museum'],
    ['tourism=attraction', 'landmark'],
    ['tourism=viewpoint', 'landmark'],
    ['tourism=artwork', 'landmark'],
    ['tourism=zoo', 'park'],
    ['tourism=theme_park', 'park'],
    ['tourism=aquarium', 'park'],
    ['tourism=information', 'other'],
    ['amenity=cinema', 'venue'],
    ['amenity=theatre', 'venue'],
    ['amenity=arts_centre', 'venue'],
    ['historic=*', 'landmark'],
    ['leisure=stadium', 'stadium'],
    ['leisure=marina', 'transport'],
    ['leisure=park', 'park'],
    ['leisure=garden', 'park'],
    ['leisure=playground', 'park'],
    ['leisure=*', 'park'],
    ['natural=beach', 'beach'],
    ['amenity=place_of_worship', 'religion'],
    ['amenity=bus_station', 'transport'],
    ['amenity=ferry_terminal', 'transport'],
    ['amenity=taxi', 'transport'],
    ['amenity=fuel_station', 'gas_station'],
    ['public_transport=*', 'transport'],
    ['railway=station', 'transport'],
    ['railway=halt', 'transport'],
    ['aeroway=aerodrome', 'transport'],
    ['aeroway=terminal', 'transport'],
    ['office=*', 'gov']
  ];
  c_fsq CONSTANT text[][] := ARRAY[
    ['hospital', 'hospital'],
    ['clinic', 'hospital'],
    ['doctor', 'hospital'],
    ['medical', 'hospital'],
    ['pharmacy', 'pharmacy'],
    ['drugstore', 'pharmacy'],
    ['school', 'school'],
    ['university', 'school'],
    ['college', 'school'],
    ['library', 'school'],
    ['government', 'gov'],
    ['post_office', 'gov'],
    ['embassy', 'embassy'],
    ['consulate', 'embassy'],
    ['hotel', 'hotel'],
    ['lodging', 'hotel'],
    ['guest_house', 'hotel'],
    ['hostel', 'hotel'],
    ['bnb', 'hotel'],
    ['motel', 'hotel'],
    ['resort', 'hotel'],
    ['restaurant', 'restaurant'],
    ['paladar', 'paladar'],
    ['cafe', 'cafe'],
    ['coffee', 'cafe'],
    ['bakery', 'cafe'],
    ['ice_cream', 'cafe'],
    ['barber', 'shop'],
    ['bar', 'bar'],
    ['public_art', 'landmark'],
    ['public_plaza', 'landmark'],
    ['public_transportation', 'transport'],
    ['public_service', 'gov'],
    ['pub', 'bar'],
    ['nightclub', 'bar'],
    ['lounge', 'bar'],
    ['grocery', 'supermarket'],
    ['supermarket', 'supermarket'],
    ['market', 'supermarket'],
    ['convenience', 'supermarket'],
    ['bank', 'bank'],
    ['atm', 'atm'],
    ['gas_station', 'gas_station'],
    ['fuel', 'gas_station'],
    ['museum', 'museum'],
    ['gallery', 'museum'],
    ['theater', 'venue'],
    ['theatre', 'venue'],
    ['cinema', 'venue'],
    ['movie', 'venue'],
    ['concert', 'venue'],
    ['performing_arts', 'venue'],
    ['night_club', 'bar'],
    ['salsa_club', 'bar'],
    ['comedy_club', 'venue'],
    ['stadium', 'stadium'],
    ['arena', 'stadium'],
    ['shopping_plaza', 'shop'],
    ['park', 'park'],
    ['garden', 'park'],
    ['fair', 'park'],
    ['great_outdoors', 'park'],
    ['lake', 'park'],
    ['campground', 'park'],
    ['plaza', 'landmark'],
    ['square', 'landmark'],
    ['beach', 'beach'],
    ['church', 'religion'],
    ['mosque', 'religion'],
    ['temple', 'religion'],
    ['synagogue', 'religion'],
    ['religious', 'religion'],
    ['bus_station', 'transport'],
    ['train_station', 'transport'],
    ['airport', 'transport'],
    ['taxi', 'transport'],
    ['ferry', 'transport'],
    ['pier', 'transport'],
    ['harbor', 'transport'],
    ['marina', 'transport'],
    ['states_and_municipalities', 'other'],
    ['neighborhood', 'other'],
    ['farm', 'other'],
    ['stable', 'other'],
    ['field', 'other'],
    ['roof_deck', 'other'],
    ['internet_cafe', 'cafe'],
    ['gaming_cafe', 'cafe'],
    ['bathing_area', 'beach'],
    ['dive_spot', 'beach'],
    ['surf_spot', 'beach'],
    ['waterfront', 'beach'],
    ['bay', 'beach'],
    ['cave', 'park'],
    ['waterfall', 'park'],
    ['scenic', 'park'],
    ['mountain', 'park'],
    ['river', 'park'],
    ['hiking', 'park'],
    ['nature_preserve', 'park'],
    ['forest', 'park'],
    ['zoo', 'park'],
    ['aquarium', 'park'],
    ['tree', 'other'],
    ['monument', 'landmark'],
    ['memorial', 'landmark'],
    ['historic', 'landmark'],
    ['castle', 'landmark'],
    ['lighthouse', 'landmark'],
    ['attraction', 'landmark'],
    ['landmark', 'landmark'],
    ['travel_and_transportation', 'transport'],
    ['dining_and_drinking', 'restaurant'],
    ['retail', 'shop'],
    ['health_and_medicine', 'hospital']
  ];
  c_ovt CONSTANT text[][] := ARRAY[
    ['hospital', 'hospital'],
    ['clinic', 'hospital'],
    ['medical_center', 'hospital'],
    ['pharmacy', 'pharmacy'],
    ['drugstore', 'pharmacy'],
    ['school', 'school'],
    ['university', 'school'],
    ['college', 'school'],
    ['library', 'school'],
    ['preschool', 'school'],
    ['city_hall', 'gov'],
    ['government_office', 'gov'],
    ['post_office', 'gov'],
    ['embassy', 'embassy'],
    ['consulate', 'embassy'],
    ['hotel', 'hotel'],
    ['motel', 'hotel'],
    ['hostel', 'hotel'],
    ['bed_and_breakfast', 'hotel'],
    ['guest_house', 'hotel'],
    ['casa_particular', 'hotel'],
    ['resort', 'hotel'],
    ['accommodation', 'hotel'],
    ['restaurant', 'restaurant'],
    ['cuban_restaurant', 'paladar'],
    ['paladar', 'paladar'],
    ['cafe', 'cafe'],
    ['coffee_shop', 'cafe'],
    ['ice_cream_shop', 'cafe'],
    ['bakery', 'cafe'],
    ['bar', 'bar'],
    ['pub', 'bar'],
    ['nightclub', 'bar'],
    ['dance_club', 'bar'],
    ['lounge', 'bar'],
    ['barber', 'shop'],
    ['barber_shop', 'shop'],
    ['hair_salon', 'shop'],
    ['beauty_salon', 'shop'],
    ['nail_salon', 'shop'],
    ['supermarket', 'supermarket'],
    ['grocery_store', 'supermarket'],
    ['convenience_store', 'supermarket'],
    ['bank', 'bank'],
    ['atm', 'atm'],
    ['gas_station', 'gas_station'],
    ['museum', 'museum'],
    ['art_gallery', 'museum'],
    ['history_museum', 'museum'],
    ['art_museum', 'museum'],
    ['modern_art_museum', 'museum'],
    ['arts_and_entertainment', 'park'],
    ['cultural_center', 'venue'],
    ['historic_site', 'landmark'],
    ['landmark_and_historical_building', 'landmark'],
    ['monument', 'landmark'],
    ['memorial', 'landmark'],
    ['tourist_attraction', 'landmark'],
    ['public_plaza', 'landmark'],
    ['castle', 'landmark'],
    ['fort', 'landmark'],
    ['fortress', 'landmark'],
    ['lighthouse', 'landmark'],
    ['palace', 'landmark'],
    ['bridge', 'landmark'],
    ['tower', 'landmark'],
    ['ruins', 'landmark'],
    ['archaeological_site', 'landmark'],
    ['theatre', 'venue'],
    ['theater', 'venue'],
    ['cinema', 'venue'],
    ['movie_theater', 'venue'],
    ['performing_arts', 'venue'],
    ['concert_hall', 'venue'],
    ['music_production', 'venue'],
    ['topic_concert_venue', 'venue'],
    ['music_venue', 'venue'],
    ['theatrical_productions', 'venue'],
    ['theaters_and_performance_venues', 'venue'],
    ['drive_in_theater', 'venue'],
    ['comedy_club', 'venue'],
    ['stadium_arena', 'stadium'],
    ['stadium', 'stadium'],
    ['sports_stadium', 'stadium'],
    ['football_stadium', 'stadium'],
    ['baseball_stadium', 'stadium'],
    ['soccer_stadium', 'stadium'],
    ['park', 'park'],
    ['playground', 'park'],
    ['garden', 'park'],
    ['zoo', 'park'],
    ['aquarium', 'park'],
    ['petting_zoo', 'park'],
    ['amusement_park', 'park'],
    ['water_park', 'park'],
    ['botanical_garden', 'park'],
    ['national_park', 'park'],
    ['nature_reserve', 'park'],
    ['cave', 'park'],
    ['waterfall', 'park'],
    ['beach', 'beach'],
    ['church', 'religion'],
    ['church_cathedral', 'religion'],
    ['mosque', 'religion'],
    ['temple', 'religion'],
    ['bus_station', 'transport'],
    ['train_station', 'transport'],
    ['airport', 'transport'],
    ['taxi_stand', 'transport'],
    ['pier', 'transport'],
    ['marina', 'transport'],
    ['harbor', 'transport'],
    ['professional_services', 'other'],
    ['structure_and_geography', 'other'],
    ['other', 'other']
  ];
  c_ovt_sub CONSTANT text[][] := ARRAY[
    ['hospital', 'hospital'],
    ['school', 'school'],
    ['hotel', 'hotel'],
    ['restaurant', 'restaurant'],
    ['cafe', 'cafe'],
    ['bar', 'bar'],
    ['shop', 'shop'],
    ['store', 'shop'],
    ['park', 'park'],
    ['museum', 'museum'],
    ['stadium', 'stadium'],
    ['theat', 'venue'],
    ['landmark', 'landmark'],
    ['monument', 'landmark']
  ];
BEGIN
  IF v_cat IS NULL OR v_cat = '' THEN RETURN 'other'; END IF;

  -- OSM tag/value (also merged rows, whose category/subcategory come from the OSM member).
  v_key  := CASE WHEN v_sub IS NOT NULL AND v_sub <> '' THEN v_cat || '=' || v_sub END;
  v_wild := NULL;
  FOREACH v_pair SLICE 1 IN ARRAY c_osm LOOP
    IF v_pair[1] = v_key THEN RETURN v_pair[2]; END IF;
    IF v_wild IS NULL AND v_pair[1] = v_cat || '=*' THEN v_wild := v_pair[2]; END IF;
  END LOOP;
  IF v_wild IS NOT NULL THEN RETURN v_wild; END IF;

  -- Foursquare category label ("Landmarks and Outdoors > Beach").
  IF v_cat ~ '[[:space:]>]' THEN
    v_key := replace(replace(v_cat, ' ', '_'), '-', '_');
    FOREACH v_pair SLICE 1 IN ARRAY c_fsq LOOP
      IF position(v_pair[1] IN v_key) > 0 THEN RETURN v_pair[2]; END IF;
    END LOOP;
    RETURN 'other';
  END IF;

  -- Overture primary category (and any other bare category).
  FOREACH v_pair SLICE 1 IN ARRAY c_ovt LOOP
    IF v_pair[1] = v_cat THEN RETURN v_pair[2]; END IF;
  END LOOP;
  FOREACH v_pair SLICE 1 IN ARRAY c_ovt_sub LOOP
    IF position(v_pair[1] IN v_cat) > 0 THEN RETURN v_pair[2]; END IF;
  END LOOP;
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
--    stadium. Foursquare "Landmarks and Outdoors > …" / "Arts and Entertainment
--    > …" rows are re-mapped whatever the new value: the sync's keyword matcher
--    hit 'landmark' before 'beach'/'park', so 77 beaches, 44 parks and 86
--    neighbourhoods are labelled museum today. scripts/sync-pois/categories.json
--    (same PR) makes the weekly sync agree, so it cannot flip them back.
UPDATE public.cuba_pois p SET tricigo_category = public.map_category_to_tricigo(p.category, p.subcategory)
 WHERE p.is_active AND NOT p.is_admin AND p.category_override IS NULL
   AND (public.map_category_to_tricigo(p.category, p.subcategory) IN ('landmark','venue','stadium')
        OR p.category ILIKE 'landmarks and outdoors%' OR p.category ILIKE 'arts and entertainment%')
   AND p.tricigo_category IS DISTINCT FROM public.map_category_to_tricigo(p.category, p.subcategory);

-- 5. Wikidata Swedish descriptors imported by Overture as "landmarks" (prod dry-run
--    2026-09-05: 191 rows say "… i Kuba", 13 more carry only the noun). Natural
--    features nobody rides to — streams, mines, shoals, hills, swamps, canals, river
--    mouths — are deactivated. Islands (Cayo Coco, Cayo Levisa), towns, bays and
--    peninsulas STAY: they are destinations, and _poi_clean_name already shows them
--    without the descriptor.
UPDATE public.cuba_pois SET is_active = false, updated_at = now()
 WHERE is_active AND NOT is_admin
   AND name ~* '\((periodiskt|vattendrag|sjö|berg|kulle|damm|grotta|kanal|havskanal|sumpmark|grund|gruva|flodmynning|flod|källa|träsk|rev)(\s+(periodiskt|vattendrag|sjö|berg|kulle|damm|grotta|kanal|havskanal|sumpmark|grund|gruva|flodmynning|flod|källa|träsk|rev))*\s*(i\s+kuba\y|\))';

-- 5b. Rows that cannot be a Cuban destination: names without a single Latin letter
--     (91 in prod: Cyrillic/Thai/Persian duplicates, digits-only), flight codes
--     ("AV 959 HAV-LIM", 4 rows), and pins outside every province polygon (13:
--     cruise ships, "Caribbean Sea", a café in Bangalore) — that last rule only runs
--     with the full admin set loaded, so a partial fixture never triggers it.
UPDATE public.cuba_pois SET is_active = false, updated_at = now()
 WHERE is_active AND NOT is_admin
   AND (name !~ '[A-Za-zÀ-ÿ]' OR name ~ '^[A-Z]{2}\s?\d{2,4}\s+[A-Z]{3}-[A-Z]{3}$');
UPDATE public.cuba_pois p SET is_active = false, updated_at = now()
 WHERE p.is_active AND NOT p.is_admin
   AND (SELECT count(*) FROM public.cuba_admin_areas WHERE admin_level = 4) >= 15
   AND NOT EXISTS (SELECT 1 FROM public.cuba_admin_areas a
                    WHERE a.admin_level = 4 AND a.geom && p.location::geometry AND ST_Contains(a.geom, p.location::geometry));

-- 6. Brand → category (curated override so the weekly sync cannot undo it).
UPDATE public.cuba_pois SET category_override = 'gas_station'
 WHERE is_active AND category_override IS NULL
   AND (lower(coalesce(tags->>'brand','')) = 'cupet' OR lower(coalesce(tags->>'operator','')) LIKE 'cupet%' OR name_normalized ~ '^cupet\M')
   AND coalesce(tricigo_category,'') <> 'gas_station';

-- 7. Exact duplicates: same normalised name and (a) same effective category ≤ 150 m
--    (761 pairs in prod) or (b) different category ≤ 60 m when neither side is
--    transport (185 more: "Teatro La Caridad" museum vs park, "Jardín Zoológico de la
--    Habana" ×3 — the same place labelled by three sources; a bus stop named after a
--    hotel is NOT the hotel, hence the transport guard).
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
      FROM act a JOIN act b ON a.id < b.id AND a.name_normalized = b.name_normalized
       AND ((a.cat IS NOT DISTINCT FROM b.cat AND ST_DWithin(a.location, b.location, 150))
         OR (a.cat IS DISTINCT FROM b.cat AND coalesce(a.cat,'') <> 'transport' AND coalesce(b.cat,'') <> 'transport'
             AND ST_DWithin(a.location, b.location, 60))))
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
