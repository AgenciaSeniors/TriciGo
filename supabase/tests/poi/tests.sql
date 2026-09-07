-- supabase/tests/poi/tests.sql — behaviour tests for 00579 / 00580 / 00581.
-- Run through run.sh (fresh database every time). Harness: _t(name, cond)
-- prints PASS/FAIL; `IF cond IS NOT TRUE` so a NULL condition counts as FAIL.
CREATE OR REPLACE FUNCTION public._t(p_name text, p_cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE WARNING 'FAIL: %', p_name; INSERT INTO _t_fail VALUES (p_name);
  ELSE RAISE NOTICE 'PASS: %', p_name; END IF;
END $$;
CREATE TEMP TABLE IF NOT EXISTS _t_fail (name text);

-- T1: admin_update_poi / admin_create_poi / approve_poi_submission work again
DO $$
DECLARE v_id bigint; v_new bigint; v_sub uuid; v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', (SELECT id::text FROM users WHERE role='super_admin' LIMIT 1), true);
  SELECT min(id) INTO v_id FROM cuba_pois WHERE NOT is_admin;
  PERFORM admin_update_poi(v_id, 'Nombre Editado');
  PERFORM _t('T1a admin_update_poi renames', (SELECT name = 'Nombre Editado' AND name_normalized = 'nombre editado' FROM cuba_pois WHERE id = v_id));
  v_new := admin_create_poi('Café De Prueba', 'cafe', 23.1357, -82.3666, 'Calle 23', 'Plaza de la Revolución', 'La Habana');
  PERFORM _t('T1b admin_create_poi inserts', (SELECT name_normalized = 'cafe de prueba' AND is_admin FROM cuba_pois WHERE id = v_new));
  INSERT INTO cuba_pois_submissions (name, tricigo_category, location, address)
    VALUES ('Paladar Nueva', 'paladar', ST_SetSRID(ST_MakePoint(-82.36,23.13),4326)::geography, 'Calle 25') RETURNING id INTO v_sub;
  v_res := approve_poi_submission(v_sub);
  PERFORM _t('T1c approve_poi_submission promotes', (v_res->>'success')::boolean AND EXISTS (SELECT 1 FROM cuba_pois WHERE id = (v_res->>'promoted_poi_id')::bigint AND source='crowdsource'));
END $$;

-- T2: name cleaner (real prod names captured 2026-09-05)
DO $$ BEGIN
  PERFORM _t('T2a swedish descriptor', _poi_clean_name('Arroyo Naranjo (periodiskt vattendrag i Kuba, Provincia de Holguín, lat 20,48, long -75,18)') = 'Arroyo Naranjo');
  PERFORM _t('T2b habana suffix', _poi_clean_name('Capitolio Nacional (habana -Cuba )') = 'Capitolio Nacional');
  PERFORM _t('T2c city suffix comma', _poi_clean_name('La Roca, La Habana, Cuba') = 'La Roca');
  PERFORM _t('T2d city suffix no comma', _poi_clean_name('Casa Medina La Habana Cuba') = 'Casa Medina');
  PERFORM _t('T2e trinidad suffix', _poi_clean_name('Museo Nacional De La Lucha Contra Los Bandidos, Trinidad, Cuba') = 'Museo Nacional de la Lucha Contra los Bandidos');
  PERFORM _t('T2f lowercase', _poi_clean_name('estadio latinoamericano') = 'Estadio Latinoamericano');
  PERFORM _t('T2g caps long word', _poi_clean_name('ESTUDIO REY') = 'Estudio Rey');
  PERFORM _t('T2h acronym kept', _poi_clean_name('ETECSA') = 'ETECSA');
  PERFORM _t('T2i acronym in mixed', _poi_clean_name('DHL Express') = 'DHL Express');
  PERFORM _t('T2j real parens kept', _poi_clean_name('Teatro Karl Marx (antiguo Blanquita)') = 'Teatro Karl Marx (antiguo Blanquita)');
  PERFORM _t('T2k airport code kept', _poi_clean_name('Máximo Gómez Airport (AVI)') = 'Máximo Gómez Airport (AVI)');
  PERFORM _t('T2l never empty', _poi_clean_name('(ö i Kuba)') = '(ö i Kuba)');
  PERFORM _t('T2m quotes', _poi_clean_name('B&B Boutique “Los Villanueva”') = 'B&B Boutique "Los Villanueva"');
  PERFORM _t('T2n bare hotel', _poi_bare_name('Hotel Habana Libre') = 'habana libre');
  PERFORM _t('T2o bare article', _poi_bare_name('El Capitolio') = 'capitolio');
  PERFORM _t('T2p bare keeps whole', _poi_bare_name('Hotel') = 'hotel');
  PERFORM _t('T2q bare accents', _poi_bare_name('Cafetería La Ideal') = 'la ideal');
  -- guards against the false positives the first draft of the regexes had
  PERFORM _t('T2r bare Cuba word kept', _poi_clean_name('Banco Central de Cuba') = 'Banco Central de Cuba');
  PERFORM _t('T2s habana without comma kept', _poi_clean_name('Universidad de La Habana') = 'Universidad de La Habana');
  PERFORM _t('T2t single article kept', _poi_clean_name('Restaurante Los Nardos') = 'Restaurante Los Nardos');
  PERFORM _t('T2u by-marriott kept', _poi_clean_name('Four Points (by Sheraton)') = 'Four Points (by Sheraton)');
  PERFORM _t('T2v caps acronym allow-list', _poi_clean_name('TRD CARIBE OBISPO') = 'TRD Caribe Obispo');
  PERFORM _t('T2w wrapped quotes stripped', _poi_clean_name('"La Guarida"') = 'La Guarida');
  PERFORM _t('T2x bare generic + de la', _poi_bare_name('Casa de la Música') = 'musica');
  PERFORM _t('T2y null', _poi_clean_name(NULL) IS NULL AND _poi_bare_name(NULL) IS NULL);
END $$;
-- T2 (cont.): cases from a 157-name prod sample run through the first draft
DO $$ BEGIN
  PERFORM _t('T2z1 lone De lowered', _poi_clean_name('Palacio De Convenciones, La Habana') = 'Palacio de Convenciones');
  PERFORM _t('T2z2 trailing period then suffix', _poi_clean_name('Loma de La Cruz, Holguín, Cuba.') = 'Loma de La Cruz');
  PERFORM _t('T2z3 unbalanced quote', _poi_clean_name('Teatro Mariana Grajales"') = 'Teatro Mariana Grajales');
  PERFORM _t('T2z4 S.A. kept', _poi_clean_name('MCV Servicios, S.A.') = 'MCV Servicios, S.A.');
  PERFORM _t('T2z5 period-separated city', _poi_clean_name('Lago De Los Sueños. Camagüey. Cuba') = 'Lago de los Sueños');
  PERFORM _t('T2z6 La Habana keeps capital', _poi_clean_name('FACULTAD DE CONTABILIDAD DE LA HABANA') = 'Facultad de Contabilidad de La Habana');
  PERFORM _t('T2z7 outer quotes with inner quotes', _poi_clean_name('"Restaurante Paladar "La Casa""') = 'Restaurante Paladar "La Casa"');
  PERFORM _t('T2z8 space before comma', _poi_clean_name('Hostal la Casita , Trinidad, Cuba') = 'Hostal la Casita');
  PERFORM _t('T2z9 ETECSA (Cuba cell)', _poi_clean_name('ETECSA (Cuba cell)') = 'ETECSA');
  PERFORM _t('T2z10 hotel named after city kept', _poi_clean_name('Hotel Santiago de Cuba') = 'Hotel Santiago de Cuba');
  PERFORM _t('T2z11 initial E. kept', _poi_clean_name('Feria De Comidas (Antorcha E.)') = 'Feria de Comidas (Antorcha E.)');
  PERFORM _t('T2z12 .cuba garbage', _poi_clean_name('Iglesia Del Cobre, Santiago De Cuba.cuba') = 'Iglesia del Cobre');
  PERFORM _t('T2z13 swedish-only parenthetical', _poi_clean_name('Arroyo Conuco (periodiskt vattendrag)') = 'Arroyo Conuco' AND _poi_clean_name('Cayo del Medio (halvö)') = 'Cayo del Medio');
END $$;

-- T3: display_name derivation survives a sync-style UPDATE of name; overrides win
DO $$ DECLARE v_id bigint; BEGIN
  INSERT INTO cuba_pois (name, category, location, source, confidence) VALUES
   ('LA ROCA, La Habana, Cuba', 'restaurant', ST_SetSRID(ST_MakePoint(-82.38,23.14),4326)::geography, 'overture', 0.9) RETURNING id INTO v_id;
  PERFORM _t('T3a display derived on insert', (SELECT display_name = 'La Roca' FROM cuba_pois WHERE id = v_id));
  UPDATE cuba_pois SET name = 'LA ROCA BAR, La Habana, Cuba' WHERE id = v_id;           -- what bulk_upsert does
  PERFORM _t('T3b display follows sync rename', (SELECT display_name = 'La Roca Bar' FROM cuba_pois WHERE id = v_id));
  UPDATE cuba_pois SET name_override = 'La Roca (Vedado)' WHERE id = v_id;
  UPDATE cuba_pois SET name = 'LA ROCA, Cuba' WHERE id = v_id;
  PERFORM _t('T3c override wins over sync', (SELECT display_name = 'La Roca (Vedado)' FROM cuba_pois WHERE id = v_id));
  PERFORM _t('T3d defaults', (SELECT is_landmark = false AND pick_count = 0 AND merged_into IS NULL FROM cuba_pois WHERE id = v_id));
  BEGIN
    UPDATE cuba_pois SET category_override = 'bogus' WHERE id = v_id;
    PERFORM _t('T3e category_override CHECK', false);
  EXCEPTION WHEN check_violation THEN PERFORM _t('T3e category_override CHECK', true); END;
  PERFORM _t('T3f backfill left no NULL display_name', NOT EXISTS (SELECT 1 FROM cuba_pois WHERE display_name IS NULL));
  PERFORM _t('T3g fixture cleaned', (SELECT display_name = 'Casa Medina' FROM cuba_pois WHERE name = 'Casa Medina La Habana Cuba'));
  PERFORM _t('T3h taxonomy has 24 values', array_length(poi_taxonomy(), 1) = 24 AND 'landmark' = ANY (poi_taxonomy()));
END $$;

-- T4: aliases
DO $$ DECLARE v_id bigint; BEGIN
  SELECT id INTO v_id FROM cuba_pois WHERE name = 'Hospital Miguel Enríquez' LIMIT 1;   -- fixture row
  PERFORM _t('T4a curated seed resolved', EXISTS (SELECT 1 FROM cuba_poi_aliases WHERE poi_id = v_id AND alias = 'La Benéfica' AND kind = 'popular' AND source = 'seed'));
  PERFORM _t('T4b alias_norm', (SELECT alias_norm = 'la benefica' FROM cuba_poi_aliases WHERE poi_id = v_id AND alias = 'La Benéfica'));
  PERFORM _t('T4c osm brand seed', EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE p.tags->>'brand' = 'Cupet' AND a.alias = 'Cupet' AND a.kind = 'brand' AND a.source = 'osm'));
  PERFORM _t('T4d no alias equal to name', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE a.alias_norm = p.name_normalized));
  PERFORM _t('T4e missing seed target is skipped', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases WHERE alias = 'Alias Sin Destino'));
  PERFORM _t('T4f alias never lands on a bus stop', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE a.alias = 'Calixto García' AND p.category = 'public_transport'));
  PERFORM _t('T4g seed equal to the target name is skipped', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases WHERE alias = 'Coppelia'));
  PERFORM _t('T4h osm alt_name seeded', EXISTS (SELECT 1 FROM cuba_poi_aliases WHERE alias = 'Hospital Ameijeiras' AND kind = 'popular' AND source = 'osm'));
  PERFORM _t('T4i inactive rows get no osm alias', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE NOT p.is_active));
  PERFORM _t('T4j rls enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cuba_poi_aliases'::regclass));
  PERFORM _t('T4k curated reactivation by prod id', (SELECT is_active AND is_landmark AND category_override = 'venue' FROM cuba_pois WHERE id = 120847));
  PERFORM _t('T4l reactivated row is searchable', EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = 120847 AND norm = 'tropicana'));
  PERFORM _t('T4m a seed may target a transport row', EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE a.alias = 'Terminal de Ómnibus' AND p.tricigo_category = 'transport'));
END $$;

-- T5: dictionary
DO $$ DECLARE v_id bigint; BEGIN
  SELECT id INTO v_id FROM cuba_pois WHERE name = 'Hotel Habana Libre' LIMIT 1;   -- fixture row
  PERFORM _t('T5a display row',  EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='display' AND norm='hotel habana libre'));
  PERFORM _t('T5b bare row',     EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='bare' AND norm='habana libre'));
  INSERT INTO cuba_poi_aliases (poi_id, alias, alias_norm, kind, source) VALUES (v_id, 'El Libre', 'el libre', 'popular', 'admin');
  PERFORM _t('T5c alias row appears', EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='alias' AND norm='el libre'));
  DELETE FROM cuba_poi_aliases WHERE poi_id = v_id AND alias_norm = 'el libre';
  PERFORM _t('T5d alias row removed', NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='alias' AND norm='el libre'));
  UPDATE cuba_pois SET name_override = 'Habana Libre Tryp' WHERE id = v_id;
  PERFORM _t('T5e display row follows override', EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='display' AND norm='habana libre tryp') AND NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND norm='hotel habana libre'));
  UPDATE cuba_pois SET is_active = false WHERE id = v_id;
  PERFORM _t('T5f inactive rows leave', NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id));
  UPDATE cuba_pois SET is_active = true, name_override = NULL WHERE id = v_id;
  PERFORM _t('T5g reactivation rebuilds', (SELECT count(*) FILTER (WHERE kind='display') = 1 AND count(*) FILTER (WHERE kind='bare') = 1 AND count(*) FILTER (WHERE kind='alias' AND norm='habana libre') = 1 FROM poi_search_names WHERE poi_id = v_id));
  PERFORM _t('T5h brand alias is kind brand', EXISTS (SELECT 1 FROM poi_search_names n JOIN cuba_pois p ON p.id = n.poi_id WHERE p.tags->>'brand' = 'Cupet' AND n.kind = 'brand' AND n.norm = 'cupet'));
  PERFORM _t('T5i inactive fixture absent', NOT EXISTS (SELECT 1 FROM poi_search_names n JOIN cuba_pois p ON p.id = n.poi_id WHERE NOT p.is_active));
  PERFORM _t('T5j every active poi has a display row', NOT EXISTS (SELECT 1 FROM cuba_pois p WHERE p.is_active AND p.merged_into IS NULL AND NOT EXISTS (SELECT 1 FROM poi_search_names n WHERE n.poi_id = p.id AND n.kind = 'display')));
  UPDATE cuba_poi_aliases SET alias = 'La Benéfica del Cerro', alias_norm = 'la benefica del cerro' WHERE alias = 'La Benéfica';
  PERFORM _t('T5k alias update re-syncs', EXISTS (SELECT 1 FROM poi_search_names WHERE norm = 'la benefica del cerro') AND NOT EXISTS (SELECT 1 FROM poi_search_names WHERE norm = 'la benefica'));
  UPDATE cuba_poi_aliases SET alias = 'La Benéfica', alias_norm = 'la benefica' WHERE alias = 'La Benéfica del Cerro';
END $$;

-- T6: admin areas (fixture polygons: Plaza de la Revolución / Centro Habana / La Habana Vieja inside La Habana)
DO $$ DECLARE v_id bigint; BEGIN
  INSERT INTO cuba_pois (name, category, location, source, municipality, province) VALUES
   ('Cafetería Prueba Vedado', 'cafe', ST_SetSRID(ST_MakePoint(-82.3866,23.1401),4326)::geography, 'overture', 'Ciudad de la Habana', 'FL') RETURNING id INTO v_id;
  PERFORM _t('T6a insert derives from polygons', (SELECT municipality = 'Plaza de la Revolución' AND province = 'La Habana' FROM cuba_pois WHERE id = v_id));
  UPDATE cuba_pois SET location = ST_SetSRID(ST_MakePoint(-82.3560,23.1370),4326)::geography WHERE id = v_id;
  PERFORM _t('T6b move re-derives', (SELECT municipality = 'La Habana Vieja' FROM cuba_pois WHERE id = v_id));
  PERFORM _t('T6c backfill fixed legacy rows', NOT EXISTS (SELECT 1 FROM cuba_pois WHERE is_active AND province NOT IN (SELECT name_es FROM cuba_admin_areas WHERE admin_level = 4)));
  PERFORM _t('T6d garbage province fixed', (SELECT province = 'La Habana' AND municipality = 'Plaza de la Revolución' FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba'));
  PERFORM _t('T6e cyrillic province fixed, municipality kept', (SELECT province = 'Mayabeque' AND municipality = 'Santa Cruz del Norte' FROM cuba_pois WHERE name = 'Playa Jibacoa'));
  PERFORM _t('T6f outside polygons untouched', (SELECT province IS NULL AND municipality IS NULL FROM cuba_pois WHERE name = 'Máximo Gómez Airport (AVI)'));
  UPDATE cuba_pois SET phone = '+53 7 000 0000' WHERE id = v_id;   -- non-location UPDATE must not touch the areas
  PERFORM _t('T6g non-location update keeps areas', (SELECT municipality = 'La Habana Vieja' FROM cuba_pois WHERE id = v_id));
END $$;

-- T7: cleanup + taxonomy
DO $$ DECLARE v_win bigint; v_lose bigint; v_imp jsonb; BEGIN
  PERFORM _t('T7a swedish landmark deactivated', NOT EXISTS (SELECT 1 FROM cuba_pois WHERE is_active AND name LIKE 'Arroyo Guayabo (vattendrag%'));
  SELECT id INTO v_win  FROM cuba_pois WHERE name = 'Coppelia' AND source = 'merged';
  SELECT id INTO v_lose FROM cuba_pois WHERE name = 'Coppelia' AND source = 'overture';
  PERFORM _t('T7b merged wins over overture', (SELECT is_active FROM cuba_pois WHERE id = v_win));
  PERFORM _t('T7c loser points at winner', (SELECT NOT is_active AND merged_into = v_win FROM cuba_pois WHERE id = v_lose));
  PERFORM _t('T7d winner inherits source_ids', (SELECT source_ids ? 'ovt' AND source_ids ? 'osm' FROM cuba_pois WHERE id = v_win));
  PERFORM _t('T7e loser left the dictionary', NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_lose));
  PERFORM _t('T7f cupet brand → gas_station', (SELECT category_override = 'gas_station' FROM cuba_pois WHERE tags->>'brand' = 'Cupet' LIMIT 1));
  PERFORM _t('T7f2 cupet by name → gas_station', (SELECT category_override = 'gas_station' FROM cuba_pois WHERE name = 'Cupet Santa Catalina'));
  PERFORM _t('T7g theatre → venue via mapper', map_category_to_tricigo('theatre', NULL) = 'venue');
  PERFORM _t('T7h landmark via mapper', map_category_to_tricigo('landmark_and_historical_building', NULL) = 'landmark');
  PERFORM _t('T7i stadium via mapper', map_category_to_tricigo('leisure', 'stadium') = 'stadium');
  PERFORM _t('T7j museum stays museum', map_category_to_tricigo('museum', NULL) = 'museum');
  -- call first, assert after: inside one expression Postgres may run the EXISTS initplan before the volatile call
  v_imp := import_search_poi('Teatro Prueba', 23.10, -82.40, NULL, 'venue', 'mb.test.1');
  PERFORM _t('T7k import allow-list accepts venue', (v_imp->>'imported')::boolean AND EXISTS (SELECT 1 FROM cuba_pois WHERE name = 'Teatro Prueba' AND tricigo_category = 'venue'));
  PERFORM _t('T7l keyword teatro → venue', EXISTS (SELECT 1 FROM cuba_search_keywords WHERE keyword = 'teatro' AND tricigo_category = 'venue'));
  PERFORM _t('T7m CHECK validated', (SELECT convalidated FROM pg_constraint WHERE conname = 'cuba_pois_tricigo_category_chk'));
  PERFORM _t('T7n fixture rows re-mapped', (SELECT tricigo_category FROM cuba_pois WHERE name = 'Teatro Karl Marx') = 'venue'
                                        AND (SELECT tricigo_category FROM cuba_pois WHERE name = 'Cine Yara') = 'venue'
                                        AND (SELECT tricigo_category FROM cuba_pois WHERE name = 'estadio latinoamericano') = 'stadium');
  PERFORM _t('T7o fsq beach stays beach', map_category_to_tricigo('Landmarks and Outdoors > Beach', NULL) = 'beach'
                                        AND map_category_to_tricigo('Landmarks and Outdoors > Bay', NULL) = 'beach');
  PERFORM _t('T7p fsq neighbourhood is other', map_category_to_tricigo('Landmarks and Outdoors > States and Municipalities > Neighborhood', NULL) = 'other');
  PERFORM _t('T7q fsq monument is landmark', map_category_to_tricigo('Landmarks and Outdoors > Monument', NULL) = 'landmark'
                                        AND map_category_to_tricigo('Landmarks and Outdoors > Historic and Protected Site', NULL) = 'landmark');
  PERFORM _t('T7r fsq park/marina', map_category_to_tricigo('Landmarks and Outdoors > Park > National Park', NULL) = 'park'
                                        AND map_category_to_tricigo('Landmarks and Outdoors > Harbor or Marina', NULL) = 'transport');
  PERFORM _t('T7s fsq arts split', map_category_to_tricigo('Arts and Entertainment > Museum > History Museum', NULL) = 'museum'
                                        AND map_category_to_tricigo('Arts and Entertainment > Performing Arts Venue > Theater', NULL) = 'venue'
                                        AND map_category_to_tricigo('Arts and Entertainment > Stadium > Baseball Stadium', NULL) = 'stadium'
                                        AND map_category_to_tricigo('Arts and Entertainment > Night Club', NULL) = 'bar'
                                        AND map_category_to_tricigo('Arts and Entertainment > Public Art', NULL) = 'landmark');
  PERFORM _t('T7t osm historic subcats', map_category_to_tricigo('historic', 'memorial') = 'landmark' AND map_category_to_tricigo('historic', 'ruins') = 'landmark'
                                        AND map_category_to_tricigo('tourism', 'viewpoint') = 'landmark' AND map_category_to_tricigo('amenity', 'cinema') = 'venue');
  PERFORM _t('T7u old mappings intact', map_category_to_tricigo('restaurant', NULL) = 'restaurant' AND map_category_to_tricigo('amenity', 'pharmacy') = 'pharmacy'
                                        AND map_category_to_tricigo('Dining and Drinking > Restaurant > Cuban Restaurant', NULL) = 'restaurant'
                                        AND map_category_to_tricigo('Dining and Drinking > Cafe, Coffee, and Tea House', NULL) = 'cafe'
                                        AND map_category_to_tricigo('nonsense', NULL) = 'other');
  -- 2026-09-05 dry-run: the 9 (source, category) pairs the hand-written mapper and categories.json
  -- disagreed on (101 active prod rows the weekly sync would have flipped back), plus the
  -- substring traps the generated mirror must not re-introduce.
  PERFORM _t('T7z8 sql = json on the flip-risk pairs', map_category_to_tricigo('art_gallery', NULL) = 'museum' AND map_category_to_tricigo('modern_art_museum', NULL) = 'museum'
                                        AND map_category_to_tricigo('leisure', 'pitch') = 'park' AND map_category_to_tricigo('leisure', 'fitness_centre') = 'park'
                                        AND map_category_to_tricigo('Retail > Shopping Plaza', NULL) = 'shop' AND map_category_to_tricigo('cave', NULL) = 'park'
                                        AND map_category_to_tricigo('amenity', 'fast_food') = 'restaurant' AND map_category_to_tricigo('shop', 'mall') = 'shop'
                                        AND map_category_to_tricigo('amenity', 'arts_centre') = 'venue' AND map_category_to_tricigo('cultural_center', NULL) = 'venue');
  PERFORM _t('T7z9 keyword order and substring traps', map_category_to_tricigo('Retail > Pharmacy', NULL) = 'pharmacy' AND map_category_to_tricigo('Dining and Drinking > Bakery', NULL) = 'cafe'
                                        AND map_category_to_tricigo('Business and Professional Services > Health and Beauty Service > Barbershop', NULL) = 'shop'
                                        AND map_category_to_tricigo('barber_shop', NULL) = 'shop' AND map_category_to_tricigo('barbecue_restaurant', NULL) = 'restaurant'
                                        AND map_category_to_tricigo('Travel and Transportation > Transport Hub', NULL) = 'transport' AND map_category_to_tricigo('Health and Medicine > Physician', NULL) = 'hospital'
                                        AND map_category_to_tricigo('Landmarks and Outdoors > States and Municipalities > City', NULL) = 'other'
                                        AND map_category_to_tricigo('office', 'company') = 'gov' AND map_category_to_tricigo('shop', 'bakery') = 'shop'
                                        AND map_category_to_tricigo(' Beach ', NULL) = 'beach' AND map_category_to_tricigo(NULL, NULL) = 'other' AND map_category_to_tricigo('', 'x') = 'other');
  PERFORM _t('T7v admin row untouched', (SELECT is_active AND tricigo_category = 'gov' FROM cuba_pois WHERE name = 'El Capitolio'));
  PERFORM _t('T7w fsq beach row re-mapped', (SELECT tricigo_category = 'beach' FROM cuba_pois WHERE name = 'Playa Prueba Foursquare'));
  PERFORM _t('T7x fsq neighbourhood row re-mapped', (SELECT tricigo_category = 'other' FROM cuba_pois WHERE name = 'Vedado'));
  PERFORM _t('T7y fsq arts leftovers', map_category_to_tricigo('Arts and Entertainment > Zoo', NULL) = 'park'
                                     AND map_category_to_tricigo('Arts and Entertainment > Internet Cafe', NULL) = 'cafe'
                                     AND map_category_to_tricigo('Arts and Entertainment > Casino', NULL) = 'other'
                                     AND map_category_to_tricigo('Arts and Entertainment', NULL) = 'other');
  PERFORM _t('T7z1 parity additions', map_category_to_tricigo('stadium_arena', NULL) = 'stadium' AND map_category_to_tricigo('music_production', NULL) = 'venue'
                                     AND map_category_to_tricigo('Landmarks and Outdoors > Plaza', NULL) = 'landmark' AND map_category_to_tricigo('zoo', NULL) = 'park'
                                     AND map_category_to_tricigo('tourism', 'zoo') = 'park' AND map_category_to_tricigo('pier', NULL) = 'transport'
                                     AND map_category_to_tricigo('castle', NULL) = 'landmark');
  PERFORM _t('T7z2 island keeps active with a clean name', (SELECT is_active AND display_name = 'Cayo Prueba' FROM cuba_pois WHERE name LIKE 'Cayo Prueba (%'));
  PERFORM _t('T7z3 mine deactivated', (SELECT NOT is_active FROM cuba_pois WHERE name = 'Charco Prueba (gruva)'));
  PERFORM _t('T7z4 non-latin and flight rows deactivated', NOT EXISTS (SELECT 1 FROM cuba_pois WHERE is_active AND (name = 'AV 959 HAV-LIM' OR name !~ '[A-Za-zÀ-ÿ]')));
  PERFORM _t('T7z5 diff-category duplicates merge', (SELECT count(*) FILTER (WHERE is_active) = 1 AND count(*) FILTER (WHERE merged_into IS NOT NULL) = 1 FROM cuba_pois WHERE name = 'Radio Prueba')
                                     AND (SELECT source = 'merged' FROM cuba_pois WHERE name = 'Radio Prueba' AND is_active));
  PERFORM _t('T7z6 bus stop is not the hotel', (SELECT count(*) FILTER (WHERE is_active) = 2 FROM cuba_pois WHERE name = 'Hotel Prueba Deauville'));
  PERFORM _t('T7z7 outside-province rule needs the full admin set', (SELECT is_active FROM cuba_pois WHERE name = 'Máximo Gómez Airport (AVI)'));
END $$;

-- T2 (cont.): cases from the prod dry-run of 2026-09-05 (190 tricky real names)
DO $$ BEGIN
  PERFORM _t('T2z14 city inside the name survives ", Cuba"', _poi_clean_name('Hotel Pinar Del Río, Cuba') = 'Hotel Pinar del Río');
  PERFORM _t('T2z15 whole-name city+country kept', _poi_clean_name('La Habana Cuba') = 'La Habana Cuba' AND _poi_clean_name('Havana Cuba') = 'Havana Cuba');
  PERFORM _t('T2z16 long city suffix', _poi_clean_name('Buena Vista, Playa, Ciudad De La Habana, Cuba') = 'Buena Vista');
  PERFORM _t('T2z17 dash separators, two passes', _poi_clean_name('Hostal Nely - Cuba - La Habana') = 'Hostal Nely' AND _poi_clean_name('Casa Tania La Habana-Cuba') = 'Casa Tania' AND _poi_clean_name('Casa Particular Studio Carlos - Centro Habana') = 'Casa Particular Studio Carlos');
  PERFORM _t('T2z18 trailing dash after strip', _poi_clean_name('Internacional Discotec Cabaret - Varadero Cuba') = 'Internacional Discotec Cabaret' AND _poi_clean_name('Casa Mobi - Guesthouse -> La Habana Cuba') = 'Casa Mobi - Guesthouse');
  PERFORM _t('T2z19 Kuba spelling', _poi_clean_name('Cárdenas, Kuba') = 'Cárdenas');
  PERFORM _t('T2z20 any "i Kuba" parenthetical', _poi_clean_name('Canalizo Norte (havskanal i Kuba)') = 'Canalizo Norte' AND _poi_clean_name('Charco Redondo (gruva)') = 'Charco Redondo');
  PERFORM _t('T2z21 (city, Cuba) parenthetical', _poi_clean_name('Boquerón (Guantánamo, Cuba)') = 'Boquerón');
  PERFORM _t('T2z22 all-caps articles', _poi_clean_name('HOTEL PARADISUS LOS CAYOS') = 'Hotel Paradisus Los Cayos' AND _poi_clean_name('IGLESIA DE LA CARIDAD') = 'Iglesia de la Caridad');
  PERFORM _t('T2z23 parenthesised acronym kept', _poi_clean_name('UNIVERSIDAD DE LAS ARTES (ISA)') = 'Universidad de las Artes (ISA)');
  PERFORM _t('T2z24 generic-word guard drops only the country', _poi_clean_name('Hotel Pinar Del Río Cuba') = 'Hotel Pinar del Río');
  PERFORM _t('T2z25 l''havana', _poi_clean_name('Playa Santa Maria Atlantico L''havana Cuba') = 'Playa Santa Maria Atlantico');
  PERFORM _t('T2z26 leading noise', _poi_clean_name('¡¡¡¡¡hostal La Dominicana "') = 'Hostal La Dominicana');
  PERFORM _t('T2z27 Varadero, Cuba → Varadero', _poi_clean_name('Varadero, Cuba') = 'Varadero' AND _poi_clean_name('Cayo Largo, Cuba') = 'Cayo Largo');
  PERFORM _t('T2z28 first letter after a paren', _poi_clean_name('OSDE GELMA (TRIGAL)') = 'Osde Gelma (Trigal)');
  PERFORM _t('T2z29 leading lowercase word', _poi_clean_name('hostal casa Mía') = 'Hostal casa Mía' AND _poi_clean_name('el bosque de la habana') = 'El Bosque de La Habana');
  PERFORM _t('T2z30 camel-case first word kept', _poi_clean_name('iPhone Store Habana') = 'iPhone Store Habana');
  -- 2026-09-06: the 19,939-row prod rehearsal (2,463 renames eyeballed by class)
  PERFORM _t('T2z31 brand + city keeps the city', _poi_clean_name('Melia Cayo Santa Maria Cuba') = 'Melia Cayo Santa Maria' AND _poi_clean_name('Skydive Varadero Cuba') = 'Skydive Varadero');
  PERFORM _t('T2z32 dangling connector keeps the city', _poi_clean_name('Languages Center University of Cienfuegos Cuba') = 'Languages Center University of Cienfuegos');
  PERFORM _t('T2z33 articles alone are a name', _poi_clean_name('Restaurante El Rancho La Finca') = 'Restaurante El Rancho La Finca' AND _poi_clean_name('Ooh La La Bar') = 'Ooh La La Bar');
  PERFORM _t('T2z34 initial abbreviation keeps its period', _poi_clean_name('Copextel S. A. Villa Clara') = 'Copextel S. A.');
  PERFORM _t('T2z35 en Cuba is a name', _poi_clean_name('Embajada de Suiza en Cuba') = 'Embajada de Suiza en Cuba' AND _poi_clean_name('Casa Medina La Habana Cuba') = 'Casa Medina');
END $$;

-- T8: search_pois_smart v2 (00583)
DO $$
DECLARE v_hotel bigint; v_stop bigint; v_pc_lm bigint; v_pc_other bigint; v_r record; v_n int;
BEGIN
  SELECT id INTO v_hotel FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category <> 'public_transport' AND is_active LIMIT 1;
  SELECT id INTO v_stop  FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category = 'public_transport' LIMIT 1;

  PERFORM _t('T8a return type ends with the 3 new columns',
    pg_get_function_result('public.search_pois_smart(text,double precision,double precision,integer,integer)'::regprocedure)
      LIKE '%matched_alias text, display_name text, is_landmark boolean)');
  SELECT * INTO v_r FROM search_pois_smart('capitolio', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8b exact bare match is first and named by display_name', v_r.name = 'El Capitolio' AND v_r.display_name = 'El Capitolio' AND v_r.match_reason = 'name_exact');

  SELECT * INTO v_r FROM search_pois_smart('la benefica', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8c alias resolves with matched_alias', v_r.name LIKE 'Hospital Miguel Enr%' AND v_r.matched_alias IS NOT NULL);

  SELECT count(*) INTO v_n FROM search_pois_smart('habana libre', 23.1357, -82.3666, 30000, 10) s WHERE s.id = v_stop;
  PERFORM _t('T8d shadow stop demoted out', v_n = 0);
  SELECT * INTO v_r FROM search_pois_smart('habana libre', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8e bare query hits the hotel first', v_r.id = v_hotel);
  SELECT count(*) INTO v_n FROM search_pois_smart('parada habana libre', 23.1357, -82.3666, 30000, 10) s WHERE s.id = v_stop;
  PERFORM _t('T8f transport intent restores the stop', v_n = 1);

  SELECT id INTO v_pc_other FROM cuba_pois WHERE name = 'Parque Central' AND municipality = 'Centro Habana' LIMIT 1;
  SELECT id INTO v_pc_lm    FROM cuba_pois WHERE name = 'Parque Central' AND id <> v_pc_other AND is_active LIMIT 1;
  UPDATE cuba_pois SET is_landmark = true WHERE id = v_pc_lm;
  SELECT * INTO v_r FROM search_pois_smart('parque central', 23.1435, -82.3590, 30000, 5) LIMIT 1;  -- origin ON the non-landmark twin
  PERFORM _t('T8g landmark outranks the closer twin', v_r.id = v_pc_lm AND v_r.is_landmark);

  UPDATE cuba_pois SET is_landmark = false WHERE id = v_pc_lm;
  UPDATE cuba_pois SET pick_count = 20 WHERE id = v_pc_other;
  SELECT * INTO v_r FROM search_pois_smart('parque central', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8h picks outrank the plain twin', v_r.id = v_pc_other);
  UPDATE cuba_pois SET pick_count = 0 WHERE id = v_pc_other;

  SELECT count(*) INTO v_n FROM search_pois_smart('coppelia', 23.1357, -82.3666, 30000, 10) s
   WHERE EXISTS (SELECT 1 FROM cuba_pois m WHERE m.id = s.id AND m.merged_into IS NOT NULL);
  PERFORM _t('T8i merged rows excluded', v_n = 0);

  -- 'cafeteria …' also triggers the category keyword, so count only the name matches
  SELECT count(*) INTO v_n FROM search_pois_smart('cafeteria la rampa', 23.1357, -82.3666, 30000, 10) s WHERE s.match_reason = 'name_exact';
  PERFORM _t('T8j same-name rows within 300 m collapse', v_n = 2);

  SELECT * INTO v_r FROM search_pois_smart('panaderia prueba', 23.1352, -82.3702, 30000, 5) LIMIT 1;  -- origin on the OLD one
  PERFORM _t('T8k stale row sinks below the fresh twin', v_r.name = 'Panadería Prueba Fresca');

  SELECT count(*) INTO v_n FROM search_pois_smart('capitolio', NULL, NULL, 30000, 5);
  PERFORM _t('T8l null proximity returns nothing', v_n = 0);

  SELECT count(*) INTO v_n FROM search_pois_smart('hospital', 23.1357, -82.3666, 30000, 10) s WHERE s.matched_category = 'hospital' AND s.tricigo_category = 'hospital';
  PERFORM _t('T8m keyword query returns category matches', v_n >= 2);
  SELECT * INTO v_r FROM search_pois_smart('hospital', 23.1357, -82.3666, 30000, 10) LIMIT 1;
  PERFORM _t('T8n generic placeholder is not first', lower(v_r.name) <> 'hospital');

  SELECT * INTO v_r FROM search_pois_smart('cupet santa catalina', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8o effective category returned', v_r.tricigo_category = 'gas_station');

  SELECT l.name INTO v_r FROM cuba_pois p, LATERAL lookup_nearest_poi_ranked(ST_Y(p.location::geometry), ST_X(p.location::geometry), 30) l
   WHERE p.name = 'La Roca, La Habana, Cuba' LIMIT 1;
  PERFORM _t('T8p reverse geocode returns display_name', v_r.name = 'La Roca');
END $$;

-- T9: learning from picks (00584)
DO $$
DECLARE v_hotel bigint; v_ben bigint; v_before int; v_ok boolean; v_uid uuid := '00000000-0000-0000-0000-00000000c001'; v_n int;
BEGIN
  SELECT id INTO v_hotel FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category <> 'public_transport' AND is_active LIMIT 1;
  SELECT id INTO v_ben   FROM cuba_pois WHERE name = 'Hospital Miguel Enríquez' AND is_active LIMIT 1;
  INSERT INTO users (id, role, full_name) VALUES (v_uid, 'customer', 'Rider Prueba') ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM _t('T9a unauthenticated pick refused', record_poi_pick(v_hotel) = false);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  SELECT pick_count INTO v_before FROM cuba_pois WHERE id = v_hotel;
  v_ok := record_poi_pick(v_hotel);
  PERFORM _t('T9b authenticated pick counts', v_ok AND (SELECT pick_count FROM cuba_pois WHERE id = v_hotel) = v_before + 1
                                              AND (SELECT last_picked_at FROM cuba_pois WHERE id = v_hotel) > now() - interval '1 minute');
  PERFORM _t('T9c pick on a merged row is a no-op',
             record_poi_pick((SELECT id FROM cuba_pois WHERE merged_into IS NOT NULL LIMIT 1)) = false);
  -- rate limit 60/h: T9b + T9c already used 2 of the window → 58 more succeed, the 61st is refused
  FOR i IN 1..58 LOOP PERFORM record_poi_pick(v_hotel); END LOOP;
  PERFORM _t('T9d 61st pick in the hour is refused', record_poi_pick(v_hotel) = false);
  DELETE FROM rate_limits WHERE key LIKE 'poi_pick:%';
  UPDATE cuba_pois SET pick_count = v_before WHERE id = v_hotel;

  PERFORM _t('T9e bump_poi_pick not executable by app roles',
             NOT has_function_privilege('authenticated', 'public.bump_poi_pick(bigint)', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public.bump_poi_pick(bigint)', 'EXECUTE'));
  PERFORM _t('T9f record_poi_pick not executable by anon', NOT has_function_privilege('anon', 'public.record_poi_pick(bigint)', 'EXECUTE')
         AND has_function_privilege('authenticated', 'public.record_poi_pick(bigint)', 'EXECUTE'));

  PERFORM _t('T9g find_nearby_poi_match by alias',
             find_nearby_poi_match('La Benéfica', ST_Y((SELECT location::geometry FROM cuba_pois WHERE id = v_ben)), ST_X((SELECT location::geometry FROM cuba_pois WHERE id = v_ben)), 60) = v_ben);
  PERFORM _t('T9h find_nearby_poi_match by display name',
             find_nearby_poi_match('La Roca', ST_Y((SELECT location::geometry FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba')), ST_X((SELECT location::geometry FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba')), 60)
             = (SELECT id FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba'));
  SELECT count(*) INTO v_n FROM cuba_pois m WHERE m.merged_into IS NOT NULL
     AND find_nearby_poi_match(m.name, ST_Y(m.location::geometry), ST_X(m.location::geometry), 60) = m.id;
  PERFORM _t('T9i merged rows never matched', v_n = 0);
END $$;

-- T9 (cont.): venue name extraction, rides trigger, drain tick (00584 part 2)
DO $$
DECLARE v_hotel bigint; v_before int; v_n int; v_req bigint;
BEGIN
  SELECT id INTO v_hotel FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category <> 'public_transport' AND is_active LIMIT 1;
  PERFORM _t('T9j venue leads', _poi_leading_venue_name('Coppelia, Calle 23 e/ L y K, Plaza de la Revolución, La Habana') = 'Coppelia'
                              AND _poi_leading_venue_name('Paladar Doña Eutimia, Callejón del Chorro 60, La Habana Vieja') = 'Paladar Doña Eutimia');
  PERFORM _t('T9k corners/streets/zones/placeholders give NULL',
             _poi_leading_venue_name('Calle 23 y Calle 12, Plaza, La Habana') IS NULL
         AND _poi_leading_venue_name('Reina e/ Campanario y Lealtad, Centro Habana') IS NULL
         AND _poi_leading_venue_name('23 y 12, Vedado') IS NULL
         AND _poi_leading_venue_name('Vedado, La Habana') IS NULL
         AND _poi_leading_venue_name('Plaza de la Revolución, La Habana') IS NULL
         AND _poi_leading_venue_name('Playa, La Habana') IS NULL
         AND _poi_leading_venue_name('Detectando dirección...') IS NULL
         AND _poi_leading_venue_name('Cerca de Capitolio') IS NULL
         AND _poi_leading_venue_name('23.12638, -82.35472') IS NULL
         AND _poi_leading_venue_name('Av 51, Marianao') IS NULL
         AND _poi_leading_venue_name('X, La Habana') IS NULL);

  SELECT pick_count INTO v_before FROM cuba_pois WHERE id = v_hotel;
  INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng)
  VALUES ('Calle 23 y Calle 12, Plaza de la Revolución, La Habana', 23.1408, -82.3830,
          'Hotel Habana Libre, Calle L e/ 23 y 25, Plaza de la Revolución, La Habana',
          ST_Y((SELECT location::geometry FROM cuba_pois WHERE id = v_hotel)), ST_X((SELECT location::geometry FROM cuba_pois WHERE id = v_hotel)));
  PERFORM _t('T9l ride dropoff credits the POI', (SELECT pick_count FROM cuba_pois WHERE id = v_hotel) = v_before + 1);
  PERFORM _t('T9m nothing queued for a known POI or a corner', (SELECT count(*) FROM poi_import_queue) = 0);

  INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng)
  VALUES ('Vedado, La Habana', 23.1408, -82.3830, 'Paladar Doña Eutimia, Callejón del Chorro 60, La Habana Vieja', 23.1412, -82.3520);
  INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng)
  VALUES ('Vedado, La Habana', 23.1408, -82.3830, 'Paladar Dona Eutimia, Callejón del Chorro, La Habana Vieja', 23.1413, -82.3521);
  SELECT count(*) INTO v_n FROM poi_import_queue WHERE status = 'pending';
  PERFORM _t('T9n unknown venue queued exactly once', v_n = 1
             AND (SELECT name || '|' || endpoint FROM poi_import_queue LIMIT 1) = 'Paladar Doña Eutimia|dropoff');

  INSERT INTO rides (pickup_address, dropoff_address) VALUES ('Coppelia, Calle 23', 'Hotel Habana Libre, Calle L');
  PERFORM _t('T9o ride inserts even without coordinates', (SELECT count(*) FROM rides) = 4);

  UPDATE poi_import_queue SET status = 'done';
  PERFORM _t('T9p tick is a no-op without pending rows', drain_poi_import_queue_tick() IS NULL AND (SELECT count(*) FROM cron_http_calls) = 0);
  UPDATE poi_import_queue SET status = 'pending';
  v_req := drain_poi_import_queue_tick();
  PERFORM _t('T9q tick posts {drain:20} with the service key via cron_http_post',
             v_req IS NOT NULL
         AND (SELECT jobname FROM cron_http_calls WHERE request_id = v_req) = 'drain-poi-import-queue'
         AND (SELECT body->>'drain' FROM net._stub_requests WHERE id = v_req) = '20'
         AND (SELECT headers->>'Authorization' FROM net._stub_requests WHERE id = v_req) = 'Bearer sb_secret_local_stub'
         AND (SELECT timeout_ms FROM net._stub_requests WHERE id = v_req) = 30000);
  PERFORM _t('T9r cron job scheduled every 15 min', (SELECT schedule FROM cron.job WHERE jobname = 'drain-poi-import-queue') = '*/15 * * * *');
  PERFORM _t('T9s tick/trigger helpers not executable by app roles',
             NOT has_function_privilege('authenticated', 'public.drain_poi_import_queue_tick()', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public._poi_leading_venue_name(text)', 'EXECUTE'));
END $$;
