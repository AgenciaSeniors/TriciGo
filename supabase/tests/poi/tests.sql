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
END $$;
