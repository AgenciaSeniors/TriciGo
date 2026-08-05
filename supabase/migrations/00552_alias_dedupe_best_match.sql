-- ============================================================
-- Migration 00552: el dedupe por alias se comía a la calle de mejor match
--
-- WHY (encontrado por la verificación E2E con semillas frescas — el set de
-- desarrollo de 00548 no contenía ningún caso de alias compartido):
--
--   Dos calles OFICIALES distintas pueden compartir el alias:
--     "Avenida Martí (La Alameda)"        (Camagüey)
--     "Avenida Paseo Martí (La Alameda)"  (Camagüey, la misma zona)
--   Ambas colapsan en la clave de dedupe `norm_disp = 'la alameda'`, y el
--   DISTINCT ON conservaba la de esquina MÁS CERCANA — aunque fuera un match
--   difuso. Tecleando "avenida marti" desde La Alameda:
--
--     - "Avenida Paseo Martí (La Alameda)" está a 0 m pero NO contiene el
--       substring "avenida marti" → match_rank 4 (solo difuso) → degradada
--       al fondo por la regla anti-trigrama de 00544.
--     - "Avenida Martí (La Alameda)" era rank 0 vía nombre oficial… pero el
--       dedupe la descartó por estar su esquina un poco más lejos.
--     → el 1er resultado era "Avenida Martí" de HOLGUÍN, a 172 km.
--
--   Mismo mecanismo en Centro Habana con la familia San Martín / José de San
--   Martín / San José (históricamente la misma calle renombrada).
--
-- WHAT THIS DOES:
--   Una línea: el ORDER BY del dedupe pasa de (dist) a
--   (match_rank, sim DESC, dist). La entrada que mejor matchea lo tecleado
--   sobrevive; la cercanía desempata igual que siempre.
--
-- MEDIDO, v8 vs v8.1 (función real, semillas frescas):
--   | suite                                   | v8  | v8.1 |
--   |-----------------------------------------|-----|------|
--   | alias por nombre oficial ≤100 m (150)   | 146 | 148  |
--   | …de esos, >10 km                        | 1   | 0    |
--   | tildes (120)                            | 120 | 120  |
--   | sin alias (120)                         | 118 | 118  |
--   | regresiones                             | —   | 0    |
--   Los 2 restantes del alias son consultas de UN carácter ("9", "1"),
--   rechazadas por la guarda length<2 desde v6 — por diseño.
--   "avenida marti" desde La Alameda: 172 km → 0 m.
--   "san martin" desde Centro Habana: 1.355 m → 0 m.
--
-- WHAT STAYS: todo lo demás de 00548 v8, byte a byte (la función se reemite
--   entera porque CREATE OR REPLACE no permite parches parciales, pero el
--   diff real es el ORDER BY del CTE `best`).
-- ============================================================

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
    -- 00552: dos calles OFICIALES distintas pueden compartir un alias
    -- ("Avenida Martí (La Alameda)" y "Avenida Paseo Martí (La Alameda)").
    -- El dedupe conserva la entrada de MEJOR match primero y desempata por
    -- cercanía — antes conservaba la más cercana aunque fuera un match
    -- difuso (rank 4, degradado al fondo), y la entrada rank-0 se perdía.
    ORDER BY nr.norm_disp, nr.match_rank, nr.sim DESC, nr.dist NULLS LAST, nr.id
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
  '00552 v8.1 - Como v8 (tildes, oficial de alias, difusos al fondo) pero el dedupe por alias '
  'conserva la entrada de MEJOR match y no la más cercana: dos calles oficiales que comparten '
  'alias ya no se comen a la rank-0 ("avenida marti" desde La Alameda: 172 km → 0 m).';

-- Andamio de pruebas creado a mano en prod para comparar contra la viva.
DROP FUNCTION IF EXISTS public.search_streets_v81c(text, double precision, double precision, integer);
