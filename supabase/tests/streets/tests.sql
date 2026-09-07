-- supabase/tests/streets/tests.sql — behaviour tests for 00582. Harness: _t(name, cond).
CREATE OR REPLACE FUNCTION public._t(p_name text, p_cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE WARNING 'FAIL: %', p_name; INSERT INTO _t_fail VALUES (p_name);
  ELSE RAISE NOTICE 'PASS: %', p_name; END IF;
END $$;
CREATE TEMP TABLE IF NOT EXISTS _t_fail (name text);

-- S1 bare names
DO $$ BEGIN
  PERFORM _t('S1a trailing Avenida', _street_bare_name('5ta Avenida') = '5ta' AND _street_bare_name('1ra Avenida') = '1ra');
  PERFORM _t('S1b leading generic still', _street_bare_name('Avenida 7ma') = '7ma' AND _street_bare_name('Calle 23') = '23' AND _street_bare_name('Calzada del Cerro') = 'Cerro');
  PERFORM _t('S1c bare Avenida stays', _street_bare_name('Avenida') = 'Avenida' AND _street_bare_name('Paseo') = 'Paseo');
  PERFORM _t('S1d plain names untouched', _street_bare_name('Belascoaín') = 'Belascoaín' AND _street_bare_name('Avenida de los Presidentes') = 'Presidentes');
  PERFORM _t('S1e null', _street_bare_name(NULL) IS NULL);
  PERFORM _t('S1f dictionary recomputed', (SELECT norm_bare FROM street_search_names WHERE main_street = '5ta Avenida') = '5ta'
                                        AND (SELECT norm_bare FROM street_search_names WHERE main_street = 'Avenida 5ta B') = '5ta b');
END $$;

-- S2 corners the stress run got wrong (seed = where the rider was)
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM find_intersection_point('Ayestarán', '19 de Mayo', NULL, 23.1200, -82.3900, 8000);
  PERFORM _t('S2a exact corner beats a nearer fuzzy one', r.address = 'Ayestarán y 19 de Mayo, Plaza de la Revolución, La Habana' AND abs(r.latitude - 23.125116) < 1e-5);
  SELECT * INTO r FROM find_intersection_point('19 de mayo', 'ayestaran', NULL, 23.1200, -82.3900, 8000);
  PERFORM _t('S2b reversed, unaccented', r.address = '19 de Mayo y Ayestarán, Plaza de la Revolución, La Habana');
  SELECT * INTO r FROM find_intersection_point('5ta', '42', NULL, 23.1200, -82.4200, 8000);
  PERFORM _t('S2c 5ta is not 5ta B', r.address = '5ta Avenida y Calle 42, Playa, La Habana');
  SELECT * INTO r FROM find_intersection_point('5ta Avenida', 'Calle 42', NULL, 23.1170, -82.4260, 8000);
  PERFORM _t('S2d full names', r.address = '5ta Avenida y Calle 42, Playa, La Habana');
  SELECT * INTO r FROM find_intersection_point('Calle 100', 'Avenida 51', NULL, 23.0800, -82.4300, 8000);
  PERFORM _t('S2e 100 is not 106', r.address ~ '^(Calle )?100 y Avenida 51, Marianao, La Habana$');
  PERFORM _t('S2f 100 e/ 25 y 27 does not become Calle 10 in Vedado', NOT EXISTS (SELECT 1 FROM find_intersection_point('100', '25', '27', 23.0800, -82.4300, 8000)));
  PERFORM _t('S2g no corner → no row', NOT EXISTS (SELECT 1 FROM find_intersection_point('Marta Abreu', 'Colón', NULL, 22.4069, -79.9649, 8000))
                                    AND NOT EXISTS (SELECT 1 FROM find_intersection_point('Pan', 'Canela', NULL, 23.1357, -82.3666, 8000)));
  SELECT * INTO r FROM find_intersection_point('114', '119', NULL, 23.0600, -82.4150, 8000);
  PERFORM _t('S2h numeric grid', r.address = '114 y 119, Marianao, La Habana');
  SELECT * INTO r FROM find_intersection_point('1ra Avenida', 'Calle 28', NULL, 23.1200, -82.4300, 8000);
  PERFORM _t('S2i nearest city wins among exact matches', r.address = '1ra Avenida y Calle 28, Playa, La Habana');
  SELECT * INTO r FROM find_intersection_point('1ra', '28', NULL, 23.1544, -81.2500, 8000);
  PERFORM _t('S2j Varadero 1ra y 28', r.address = '1ra Avenida y Calle 28, Cárdenas, Matanzas');
END $$;

-- S3 what v4 already did right must not change
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM find_intersection_point('L', '27', NULL, 23.1380, -82.3850, 8000);
  PERFORM _t('S3a single letter', r.address = 'Calle L y Calle 27, Plaza de la Revolución, La Habana');
  SELECT * INTO r FROM find_intersection_point('23', '10', '12', 23.1380, -82.3850, 8000);
  PERFORM _t('S3b block midpoint', r.address = 'Calle 23 e/ Calle 10 y Calle 12, Plaza de la Revolución, La Habana'
                                  AND abs(r.latitude - 23.127508) < 2e-4 AND abs(r.longitude + 82.399169) < 2e-4);
  SELECT * INTO r FROM find_intersection_point('Infanta', 'San Lazaro', NULL, 23.1400, -82.3750, 8000);
  PERFORM _t('S3c accent-free query', r.address = 'Infanta y San Lázaro, Centro Habana, La Habana');
  SELECT * INTO r FROM find_intersection_point('10 de Octubre', 'Santa Catalina', NULL, 23.0800, -82.3800, 8000);
  PERFORM _t('S3d bare match on both sides', r.address = 'Calzada del 10 de Octubre y Avenida Santa Catalina, Diez de Octubre, La Habana');
  SELECT * INTO r FROM find_intersection_point('Marta Abreu', 'Ciclon', NULL, 22.4069, -79.9649, 8000);
  PERFORM _t('S3e alias in parentheses', r.address = 'Marta Abreu (Carretera Central) y Ciclón (Francisco Ordóñez de Hara), Santa Clara, Villa Clara');
  SELECT * INTO r FROM find_intersection_point('Calle 10', 'Calle 23', NULL, 23.1380, -82.3850, 8000);
  PERFORM _t('S3f plain numbered streets', r.address = 'Calle 10 y Calle 23, Plaza de la Revolución, La Habana');
END $$;
