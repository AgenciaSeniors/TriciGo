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
