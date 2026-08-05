-- ============================================================
-- Migration 00548: search_streets v8 — buscar por el NOMBRE OFICIAL de una
--                  calle con alias devolvía una calle lejana
--
-- WHY (medido contra prod con la función real, no simulada):
--
--   El 10,5 % de las calles cubanas (1.315 de 12.476) usa la forma
--   "Oficial (Alias)" — "Avenida 58 (Santa Cruz)", "Rafael Morales (San Juan)",
--   "Leoncio Vidal (Gloria)". Si el pasajero teclea el NOMBRE OFICIAL, v7 le
--   devolvía una calle de nombre pelado en otra parte de la ciudad:
--
--     tecleado           v7 devolvía                       distancia real
--     leoncio vidal      Leoncio Vidal                     18.983 m
--     avenida 58         Avenida 58                         2.172 m
--     rafael morales     Rafael Morales                       714 m
--
--   …cuando la calle que el pasajero tenía a 58 m, 36 m y 13 m era
--   "Leoncio Vidal (Gloria)", "Avenida 58 (Santa Cruz)" y
--   "Rafael Morales (San Juan)" respectivamente.
--
--   Causa raíz: la escalera de match_rank compara el string completo
--   (`norm_raw` = "avenida 58 (santa cruz)") y el alias (`norm_disp` =
--   "santa cruz"), pero NUNCA el nombre oficial solo ("avenida 58"). La calle
--   con alias solo llegaba a *prefix match* (rank 1) mientras la de nombre
--   pelado hacía match EXACTO (rank 0) — y el rank manda antes que la
--   distancia. Es la misma familia que el bug de tildes de 00544: calidad de
--   texto ganándole a la cercanía por un tecnicismo de normalización.
--
--   Distribución medida sobre 150 calles con alias (tecleando su nombre
--   oficial desde una esquina propia):
--
--     dónde caía el 1er resultado        v7        v8
--     ≤ 100 m                            86       145
--     100 m – 1 km                       27         4
--     1 – 10 km                          20         1
--     > 10 km                            13         0
--     peor error                     24.345 m   1.272 m
--
-- WHAT THIS DOES:
--   1. Helper `_street_official_name(text)` — la parte ANTES del paréntesis
--      ("Avenida 58 (Santa Cruz)" → "Avenida 58"). Es el espejo de
--      `_street_display_name`, que extrae el alias.
--   2. Columna `street_search_names.norm_official` = lower(unaccent(oficial)),
--      NOT NULL, mantenida por el mismo trigger de 00544.
--   3. `search_streets` considera las TRES formas (crudo, alias, oficial) en
--      la escalera de match_rank, en el `sim` y en el WHERE.
--   4. Desempate `match_source` — ver abajo, es lo que evita una regresión real.
--
-- LOS DOS DETALLES QUE COSTARON UNA ITERACIÓN CADA UNO (no simplificar):
--
--   a) `sim` TAMBIÉN debe cubrir las tres formas. Con la escalera arreglada
--      pero el `sim` solo sobre crudo+alias, "Avenida 58" seguía ganando:
--      ambas empataban en rank 0, y entonces `sim DESC` decidía —
--        similarity('avenida 58',              'avenida 58') = 1.000
--        similarity('avenida 58 (santa cruz)', 'avenida 58') = 0.500
--      → volvía a ganar la lejana. Medido, no deducido.
--
--   b) `match_source` (0 = matcheó por el nombre crudo/alias, 1 = SOLO por el
--      oficial) va DESPUÉS de la distancia. Sin él aparecía una regresión:
--      tecleando "carretera batabano - melena del sur" el ganador pasaba a ser
--      la fila cuyo display_name es "13" — el MISMO punto (0 m), pero una
--      etiqueta mucho peor. Con el desempate, cuando dos filas están a la
--      misma distancia gana la de nombre más directo. Ponerlo ANTES de la
--      distancia anularía todo el arreglo (la lejana volvería a ganar).
--
-- RENDIMIENTO: sin regresión. Peor caso ('ca', 4.419 candidatos, caché
--   caliente): v7 286 ms vs v8 260 ms. La rama del nombre oficial se gatea con
--   `norm_official <> norm_raw`, así que para el 89,5 % de las calles (sin
--   alias) no hay trabajo extra, y cada escalera se evalúa UNA sola vez.
--   OJO al medir: una sola corrida de EXPLAIN ANALYZE en esta tabla es ruidosa
--   (la misma consulta dio 2.327 ms en frío y 260 ms en caliente). Comparar
--   siempre en caliente y una al lado de la otra.
--
-- REGRESIONES: cero, medidas contra la función real.
--   - 310 calles SIN alias (3 muestras): 0 regresiones, 0 cambios de resultado.
--     Es estructural: sin alias, norm_official = norm_raw, así que el LEAST()
--     y el GREATEST() dan exactamente lo mismo que v7.
--   - 250 calles CON tilde: 100 % de acierto, igual que v7 (el arreglo de
--     00544 queda intacto).
--   - 0 de 150 casos con alias empeoran más de 50 m.
--
-- WHAT STAYS: firma y columnas idénticas; buckets 25/100/300 km; guarda de
--   length<2; escape de comodines; clamp 1..25; dedupe por norm_disp; soporte
--   de lat/lng NULL; el `SET search_path` de siempre.
-- ============================================================

-- ── 1. Helper: la parte oficial, espejo de _street_display_name ─────────────
CREATE OR REPLACE FUNCTION public._street_official_name(s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN trim(regexp_replace(s, '^(.+)\s+\([^)]+\)\s*$', '\1'))
    ELSE s
  END;
$function$;

COMMENT ON FUNCTION public._street_official_name(text) IS
  '00548: nombre OFICIAL de una calle cubana, sin el alias entre paréntesis '
  '("Avenida 58 (Santa Cruz)" → "Avenida 58"). Espejo de _street_display_name(), que extrae el alias.';

-- ── 2. norm_official en el diccionario ─────────────────────────────────────
ALTER TABLE public.street_search_names ADD COLUMN IF NOT EXISTS norm_official TEXT;

UPDATE public.street_search_names
SET norm_official = lower(unaccent(public._street_official_name(main_street)))
WHERE norm_official IS DISTINCT FROM lower(unaccent(public._street_official_name(main_street)));

-- NOT NULL a propósito: un NULL aquí no rompería nada de forma ruidosa —
-- `NULL LIKE ...` y `NULL = norm_raw` dan NULL, así que esa calle degradaría
-- en silencio al comportamiento v7. Mejor que el INSERT falle.
ALTER TABLE public.street_search_names ALTER COLUMN norm_official SET NOT NULL;

COMMENT ON COLUMN public.street_search_names.norm_official IS
  '00548: lower(unaccent(_street_official_name(main_street))). Para las calles SIN alias '
  'es idéntica a norm_raw — por eso el arreglo no puede alterarlas.';

-- ── 3. El trigger de 00544 ahora también llena norm_official ────────────────
CREATE OR REPLACE FUNCTION public._street_search_names_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.street_search_names
    (main_street, display_name, norm_raw, norm_disp, norm_official)
  SELECT DISTINCT
    n.main_street,
    public._street_display_name(n.main_street),
    lower(unaccent(n.main_street)),
    lower(unaccent(public._street_display_name(n.main_street))),
    lower(unaccent(public._street_official_name(n.main_street)))
  FROM new_rows n
  WHERE n.main_street IS NOT NULL
  ON CONFLICT (main_street) DO NOTHING;

  RETURN NULL;
END;
$function$;

-- ── 4. search_streets v8 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_streets(
  query        TEXT,
  lat          DOUBLE PRECISION DEFAULT 23.1136,
  lng          DOUBLE PRECISION DEFAULT -82.3666,
  max_results  INTEGER          DEFAULT 10
)
RETURNS TABLE(
  name          TEXT,
  address       TEXT,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  municipality  TEXT,
  province      TEXT,
  distance_m    DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_user_point GEOGRAPHY(POINT, 4326);
  v_qnorm      TEXT;
  v_esc        TEXT;
  v_like       TEXT;
  v_limit      INTEGER;
  v_fuzzy      BOOLEAN;
BEGIN
  IF query IS NULL OR length(trim(query)) < 2 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_qnorm := lower(unaccent(trim(query)));
  v_esc   := replace(replace(replace(v_qnorm, '\', '\\'), '%', '\%'), '_', '\_');
  v_like  := '%' || v_esc || '%';
  v_limit := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);
  v_fuzzy := length(v_qnorm) >= 4;

  RETURN QUERY
  -- FASE 1 — texto sobre los 12.476 nombres precalculados.
  -- Las escaleras se evalúan UNA vez aquí y se combinan en `cand`; calcularlas
  -- dos veces (una para match_rank y otra para match_source) costaba ~3x.
  WITH raw_cand AS (
    SELECT
      n.main_street,
      n.display_name,
      n.norm_disp,
      LEAST(
        CASE WHEN n.norm_raw = v_qnorm THEN 0 WHEN n.norm_raw LIKE v_esc||'%' THEN 1
             WHEN n.norm_raw LIKE '% '||v_esc||'%' THEN 2
             WHEN n.norm_raw LIKE v_like THEN 3 ELSE 4 END,
        CASE WHEN n.norm_disp = v_qnorm THEN 0 WHEN n.norm_disp LIKE v_esc||'%' THEN 1
             WHEN n.norm_disp LIKE '% '||v_esc||'%' THEN 2
             WHEN n.norm_disp LIKE v_like THEN 3 ELSE 4 END
      ) AS mr_direct,
      -- Para una calle sin alias norm_official = norm_raw; se corta en 4 para
      -- que no aporte nada y match_source quede 0.
      CASE WHEN n.norm_official = n.norm_raw THEN 4
           WHEN n.norm_official = v_qnorm THEN 0
           WHEN n.norm_official LIKE v_esc||'%' THEN 1
           WHEN n.norm_official LIKE '% '||v_esc||'%' THEN 2
           WHEN n.norm_official LIKE v_like THEN 3 ELSE 4 END AS mr_official,
      GREATEST(similarity(n.norm_raw, v_qnorm), similarity(n.norm_disp, v_qnorm)) AS sim_direct,
      CASE WHEN n.norm_official = n.norm_raw THEN 0
           ELSE similarity(n.norm_official, v_qnorm) END AS sim_official
    FROM public.street_search_names n
    WHERE n.norm_raw  LIKE v_like
       OR n.norm_disp LIKE v_like
       OR (n.norm_official <> n.norm_raw AND n.norm_official LIKE v_like)
       OR (v_fuzzy AND (similarity(n.norm_raw,  v_qnorm) > 0.30
                     OR similarity(n.norm_disp, v_qnorm) > 0.30
                     OR (n.norm_official <> n.norm_raw
                         AND similarity(n.norm_official, v_qnorm) > 0.30)))
  ),
  cand AS (
    SELECT main_street, display_name, norm_disp,
           LEAST(mr_direct, mr_official)      AS match_rank,
           GREATEST(sim_direct, sim_official) AS sim,
           CASE WHEN mr_direct <= mr_official THEN 0 ELSE 1 END AS match_source
    FROM raw_cand
  ),
  -- FASE 2 — intersección más cercana por nombre, index-only sobre
  -- idx_street_intersections_main_covering. NO agregar columnas aquí.
  nearest AS (
    SELECT c.display_name, c.norm_disp, c.match_rank, c.sim, c.match_source, x.id, x.dist
    FROM cand c
    CROSS JOIN LATERAL (
      SELECT si.id, ST_Distance(si.intersection_point, v_user_point, false) AS dist
      FROM public.street_intersections si
      WHERE si.main_street = c.main_street
      ORDER BY ST_Distance(si.intersection_point, v_user_point, false) NULLS LAST, si.id
      LIMIT 1
    ) x
  ),
  best AS (
    SELECT DISTINCT ON (nr.norm_disp)
      nr.display_name, nr.match_rank, nr.sim, nr.match_source, nr.id, nr.dist
    FROM nearest nr
    ORDER BY nr.norm_disp, nr.dist NULLS LAST, nr.id
  ),
  ranked AS (
    SELECT b.display_name, b.match_rank, b.sim, b.match_source, b.id, b.dist
    FROM best b
    ORDER BY
      CASE WHEN b.match_rank >= 4 THEN 1 ELSE 0 END,   -- (1) solo-difuso al fondo (00544)
      CASE WHEN b.dist <= 25000  THEN 0
           WHEN b.dist <= 100000 THEN 1
           WHEN b.dist <= 300000 THEN 2 ELSE 3 END,    -- (2) buckets (00330)
      b.match_rank,                                     -- (3) calidad de texto
      b.sim DESC,                                       -- (4) desempate textual
      b.dist NULLS LAST,                                -- (5) cercanía
      b.match_source,                                   -- (6) 00548: a igual distancia,
      b.id                                              --     el nombre más directo
    LIMIT v_limit
  )
  SELECT
    r.display_name AS name,
    public._street_full_display(si.main_street)
      || COALESCE(' e/ ' || NULLIF(public._street_full_display(si.cross_street_1), ''), '')
      AS address,
    ST_Y(si.intersection_point::geometry) AS latitude,
    ST_X(si.intersection_point::geometry) AS longitude,
    COALESCE(si.municipality, '') AS municipality,
    COALESCE(si.province, '')     AS province,
    r.dist AS distance_m
  FROM ranked r
  JOIN public.street_intersections si ON si.id = r.id
  ORDER BY
    CASE WHEN r.match_rank >= 4 THEN 1 ELSE 0 END,
    CASE WHEN r.dist <= 25000  THEN 0
         WHEN r.dist <= 100000 THEN 1
         WHEN r.dist <= 300000 THEN 2 ELSE 3 END,
    r.match_rank, r.sim DESC, r.dist NULLS LAST, r.match_source, r.id;
END;
$function$;

COMMENT ON FUNCTION public.search_streets IS
  '00548 v8 - Además de v7 (insensible a tildes, difusos al fondo, ~200 ms), la escalera y el '
  'sim consideran el NOMBRE OFICIAL de las calles con alias, así que teclear "Avenida 58" '
  'devuelve "Avenida 58 (Santa Cruz)" a 36 m y no una "Avenida 58" a 2 km. Mismas columnas.';

-- Andamio de pruebas: la versión candidata se creó a mano en prod para poder
-- compararla contra la viva sin tocar a ningún usuario. Ya no hace falta.
DROP FUNCTION IF EXISTS public.search_streets_v8_candidate(text, double precision, double precision, integer);
