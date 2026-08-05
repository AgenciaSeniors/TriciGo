-- ============================================================
-- Migration 00553: search_streets v9 — el prefijo genérico ("Calle", "Avenida")
--                  decidía el ranking, y las calles de una letra no existían
--
-- Dos defectos, la MISMA familia que 00544 (tildes) y 00548 (nombre oficial):
-- la calidad textual le gana a la cercanía por un tecnicismo de normalización.
--
-- ── DEFECTO 1: el prefijo genérico no distingue nada, pero mandaba ──────────
--
--   En Cuba la misma calle aparece en OSM como "Calle 23", "Avenida 23" o "23"
--   según quién la mapeó, y el pasajero teclea cualquiera de las dos formas.
--   Pero la escalera de match_rank compara los strings COMPLETOS:
--
--     tecleado "23"        → "23"       exacto        → rank 0
--                          → "Calle 23" palabra suelta → rank 2
--
--   Dentro del mismo bucket de distancia el rank manda ANTES que los metros,
--   así que una "23" a 7 km le ganaba a la "Calle 23" que el pasajero tenía a
--   250 m. Medido, tecleando desde el Vedado (23.1370, -82.3830):
--
--     tecleado     v8.1 devolvía              lo que había al lado
--     23           23 @ 6.864 m               Calle 23 (La Rampa) @ 252 m
--     calle 4      Calle 4 @ 52.292 m *       4 @ 799 m  (* desde Santiago)
--     calle 23     Calle 23 @ 26.760 m **     23 @ 4.414 m  (** desde Camagüey)
--
--   La dirección INVERSA era todavía peor: tecleando "calle 23" cuando la
--   calle está guardada pelada, el candidato ni siquiera entra bien —
--   similarity('23','calle 23') = 0.333 pasa la puerta difusa pero cae en
--   rank 4, y la regla anti-trigrama de 00544 lo hunde al fondo. Por eso
--   aparecía basura a 275 km y 499 km por encima de la calle correcta.
--
--   Lo mismo con el artículo que sigue al prefijo: "Calzada de Infanta" solo
--   llegaba a rank 2 tecleando "infanta", y ganaba la "Infanta" pelada a 850 m.
--
--   Alcance: 4.122 de 12.476 nombres (33 %) llevan prefijo genérico, y 1.521
--   de ellos tienen un gemelo pelado que hoy les gana el rank. 910 llevan
--   además artículo, 338 con gemelo.
--
-- ── DEFECTO 2: las calles de UNA letra no se podían buscar ──────────────────
--
--   La guarda `length(trim(query)) < 2` (viva desde v6) rechazaba toda consulta
--   de un carácter. Pero en Cuba las calles de una letra o un dígito son la
--   malla básica del Vedado, Miramar y decenas de repartos: 43 nombres
--   distintos, 41.969 esquinas = el 11 % de todas las intersecciones del país.
--   Tecleando "L" parado en Calle L y 27 la app no devolvía NADA.
--
-- ── QUÉ HACE ───────────────────────────────────────────────────────────────
--   1. Helper `_street_bare_name(text)`: quita el prefijo genérico y, SOLO si
--      lo hubo, el artículo que le sigue ("Calzada de Infanta" → "Infanta").
--      Nunca deja el string vacío: "Paseo" a secas NO se pela — es una calle
--      real del Vedado, igual que "Calzada" y "Línea".
--   2. Columnas `norm_bare` / `norm_bare_official` en el diccionario,
--      mantenidas por el mismo trigger de 00544. NOT NULL (verificado: 0 NULL
--      y 0 vacíos sobre las 12.476 filas).
--   3. La escalera SOLO promueve el match EXACTO pelado a rank 0. Los demás
--      rangos (prefijo/palabra/substring) no se tocan: el cambio es aditivo y
--      no puede degradar a nadie.
--   4. Consultas de 1 carácter: se admiten, pero solo con match EXACTO contra
--      las cinco formas. Nada de substring ni difuso — teclear "C" en el
--      Vedado significa la calle C, no "Concordia". Eso además acota el
--      trabajo: 10 nombres candidatos en vez de 6.421.
--
-- ── LA TRAMPA QUE COSTÓ LA ITERACIÓN (no simplificar) ───────────────────────
--   `sim` TAMBIÉN tiene que cubrir la forma pelada. Es exactamente el punto
--   (a) de 00548: con la escalera arreglada pero el `sim` sin tocar, ambas
--   quedan en rank 0 y entonces decide `sim DESC` —
--       similarity('23',       '23') = 1.000
--       similarity('calle 23', '23') = 0.333
--   → volvía a ganar la lejana y el arreglo quedaba en nada.
--
-- ── MEDIDO (602 casos, función real contra prod, semillas nuevas) ───────────
--
--   | suite                                   |  n  | v8.1 |  v9  | empeora |
--   |-----------------------------------------|-----|------|------|---------|
--   | pelado    ("23" ← Calle 23)              | 120 |  81  | 120  |    0    |
--   | inversa   ("calle 23" ← 23)              | 100 |   5  | 100  |    0    |
--   | 1 carácter ("L", "9"…)                   |  82 |   0  |  82  |    —    |
--   | control tildes                           | 100 | 100  | 100  |    0    |
--   | control alias por nombre oficial         | 100 | 100  | 100  |    0    |
--   | control sin prefijo (0 cambios)          | 100 | 100  | 100  |    0    |
--
--   En la suite "pelado" los 8 casos que caían a más de 10 km bajan a 0.
--   En la "inversa" eran 61 de 100 a más de 10 km → 0.
--   El 1 carácter acierta la esquina propia a 0 m en los 82.
--
-- ── RENDIMIENTO: sin coste (caliente, alternado, 3 corridas) ────────────────
--   ca 183→185 ms · calle 147→146 · carretera 117→116 · infanta 74→74 ·
--   protestantes 82→81. Una consulta de 1 carácter cuesta 25 ms.
--   Las columnas van precalculadas justamente para no pagar un regexp por
--   fila (medido en su día: hacerlo al vuelo cuesta 2,1 s).
--
-- ── QUÉ SE MANTIENE ────────────────────────────────────────────────────────
--   Firma y columnas idénticas; buckets 25/100/300 km; difusos al fondo;
--   escape de comodines; clamp 1..25; dedupe por norm_disp con el orden de
--   00552; desempate match_source de 00548; el `SET search_path` de siempre.
-- ============================================================

-- ── 1. Helper: el nombre sin el prefijo genérico ───────────────────────────
CREATE OR REPLACE FUNCTION public._street_bare_name(s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    -- Sin prefijo genérico seguido de algo más, se devuelve tal cual. El `\S`
    -- final es lo que protege a "Paseo", "Calzada" y "Vía" cuando son el
    -- nombre completo de la calle y no un clasificador.
    WHEN s !~* '^(calle|avenida|avda|ave|av|calzada|carretera|autopista|paseo|callejon|callejón|pasaje|boulevard|blvd|camino|via|vía)\.?\s+\S'
      THEN s
    ELSE COALESCE(
      NULLIF(trim(regexp_replace(
        regexp_replace(
          s,
          '^(calle|avenida|avda|ave|av|calzada|carretera|autopista|paseo|callejon|callejón|pasaje|boulevard|blvd|camino|via|vía)\.?\s+',
          '', 'i'),
        -- El artículo solo se quita si venía DESPUÉS del prefijo, y solo si
        -- deja algo detrás ("Calzada de Infanta" → "Infanta", pero "Calle de"
        -- se quedaría como "de" antes que vaciarse).
        '^(de las|de los|de la|del|de)\s+(?=\S)', '', 'i')), ''),
      s)
  END;
$function$;

COMMENT ON FUNCTION public._street_bare_name(text) IS
  '00553: nombre de calle sin el clasificador genérico ni su artículo '
  '("Calle 23" → "23", "Calzada de Infanta" → "Infanta"). Nunca vacía el string: '
  '"Paseo" y "Calzada" a secas son calles reales del Vedado y se devuelven intactas.';

-- ── 2. Las dos formas peladas en el diccionario ────────────────────────────
ALTER TABLE public.street_search_names ADD COLUMN IF NOT EXISTS norm_bare TEXT;
ALTER TABLE public.street_search_names ADD COLUMN IF NOT EXISTS norm_bare_official TEXT;

UPDATE public.street_search_names
SET norm_bare          = lower(unaccent(public._street_bare_name(display_name))),
    norm_bare_official = lower(unaccent(public._street_bare_name(public._street_official_name(main_street))))
WHERE norm_bare          IS DISTINCT FROM lower(unaccent(public._street_bare_name(display_name)))
   OR norm_bare_official IS DISTINCT FROM lower(unaccent(public._street_bare_name(public._street_official_name(main_street))));

-- NOT NULL por el mismo motivo que norm_official en 00548: un NULL aquí no
-- rompería nada de forma ruidosa (`NULL = v_bare` da NULL, así que esa calle
-- degradaría en silencio al comportamiento v8). Mejor que el INSERT falle.
ALTER TABLE public.street_search_names ALTER COLUMN norm_bare          SET NOT NULL;
ALTER TABLE public.street_search_names ALTER COLUMN norm_bare_official SET NOT NULL;

COMMENT ON COLUMN public.street_search_names.norm_bare IS
  '00553: lower(unaccent(_street_bare_name(display_name))). Para las calles sin prefijo '
  'genérico es idéntica a norm_disp — por eso el arreglo no puede alterarlas.';
COMMENT ON COLUMN public.street_search_names.norm_bare_official IS
  '00553: lo mismo sobre el nombre OFICIAL, para las calles con alias entre paréntesis.';

-- ── 3. El trigger de 00544 llena también las formas peladas ────────────────
CREATE OR REPLACE FUNCTION public._street_search_names_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.street_search_names
    (main_street, display_name, norm_raw, norm_disp, norm_official, norm_bare, norm_bare_official)
  SELECT DISTINCT
    n.main_street,
    public._street_display_name(n.main_street),
    lower(unaccent(n.main_street)),
    lower(unaccent(public._street_display_name(n.main_street))),
    lower(unaccent(public._street_official_name(n.main_street))),
    lower(unaccent(public._street_bare_name(public._street_display_name(n.main_street)))),
    lower(unaccent(public._street_bare_name(public._street_official_name(n.main_street))))
  FROM new_rows n
  WHERE n.main_street IS NOT NULL
  ON CONFLICT (main_street) DO NOTHING;

  RETURN NULL;
END;
$function$;

-- ── 4. search_streets v9 ───────────────────────────────────────────────────
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
  v_bare       TEXT;
  v_esc        TEXT;
  v_like       TEXT;
  v_limit      INTEGER;
  v_fuzzy      BOOLEAN;
  v_single     BOOLEAN;
BEGIN
  -- 00553: la guarda baja de 2 a 1. Las calles de una letra son el 11 % de las
  -- esquinas del país (Vedado, Miramar y decenas de repartos).
  IF query IS NULL OR length(trim(query)) < 1 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_qnorm := lower(unaccent(trim(query)));
  -- El prefijo genérico se despoja del lado de la CONSULTA una sola vez; del
  -- lado de los nombres ya viene precalculado. Hacerlo por fila cuesta 2,1 s.
  v_bare  := lower(unaccent(public._street_bare_name(trim(query))));
  v_esc   := replace(replace(replace(v_qnorm, '\', '\\'), '%', '\%'), '_', '\_');
  v_like  := '%' || v_esc || '%';
  v_limit := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);
  v_fuzzy := length(v_qnorm) >= 4;
  v_single := length(v_qnorm) = 1;

  RETURN QUERY
  -- FASE 1 — texto sobre los 12.476 nombres precalculados.
  WITH raw_cand AS (
    SELECT
      n.main_street,
      n.display_name,
      n.norm_disp,
      -- Con 1 carácter todo candidato es exacto por construcción (ver el WHERE),
      -- así que el rank es 0 y deciden bucket + distancia.
      CASE WHEN v_single THEN 0 ELSE LEAST(
        CASE WHEN n.norm_raw = v_qnorm THEN 0 WHEN n.norm_raw LIKE v_esc||'%' THEN 1
             WHEN n.norm_raw LIKE '% '||v_esc||'%' THEN 2
             WHEN n.norm_raw LIKE v_like THEN 3 ELSE 4 END,
        CASE WHEN n.norm_disp = v_qnorm THEN 0 WHEN n.norm_disp LIKE v_esc||'%' THEN 1
             WHEN n.norm_disp LIKE '% '||v_esc||'%' THEN 2
             WHEN n.norm_disp LIKE v_like THEN 3 ELSE 4 END,
        -- 00553: "Calle"/"Avenida" no distinguen nada. SOLO se promueve el
        -- match exacto pelado; los otros rangos quedan intactos, así que el
        -- cambio es aditivo y no puede degradar a ninguna calle.
        CASE WHEN n.norm_bare = v_bare OR n.norm_bare_official = v_bare THEN 0
             ELSE 4 END
      ) END AS mr_direct,
      -- Para una calle sin alias norm_official = norm_raw; se corta en 4 para
      -- que no aporte nada y match_source quede 0.
      CASE WHEN v_single THEN 4
           WHEN n.norm_official = n.norm_raw THEN 4
           WHEN n.norm_official = v_qnorm THEN 0
           WHEN n.norm_official LIKE v_esc||'%' THEN 1
           WHEN n.norm_official LIKE '% '||v_esc||'%' THEN 2
           WHEN n.norm_official LIKE v_like THEN 3 ELSE 4 END AS mr_official,
      CASE WHEN v_single THEN 1::real ELSE GREATEST(
        similarity(n.norm_raw,  v_qnorm),
        similarity(n.norm_disp, v_qnorm),
        -- OBLIGATORIO. Es el punto (a) de 00548: sin esto ambas quedan en
        -- rank 0 y `sim DESC` revierte el arreglo, porque
        -- similarity('23','23')=1.000 vs similarity('calle 23','23')=0.333.
        CASE WHEN n.norm_bare = v_bare OR n.norm_bare_official = v_bare THEN 1::real
             ELSE 0::real END
      ) END AS sim_direct,
      CASE WHEN v_single OR n.norm_official = n.norm_raw THEN 0::real
           ELSE similarity(n.norm_official, v_qnorm) END AS sim_official
    FROM public.street_search_names n
    WHERE
      CASE WHEN v_single THEN
        -- 1 carácter: SOLO formas exactas. Teclear "C" en el Vedado significa
        -- la calle C, no "Concordia" ni "Calle 19". Además acota el candidato
        -- a ~10 nombres en vez de 6.421, que es lo que lo hace barato (25 ms).
        (n.norm_raw = v_qnorm OR n.norm_disp = v_qnorm OR n.norm_official = v_qnorm
         OR n.norm_bare = v_qnorm OR n.norm_bare_official = v_qnorm)
      ELSE
        (n.norm_raw  LIKE v_like
         OR n.norm_disp LIKE v_like
         OR (n.norm_official <> n.norm_raw AND n.norm_official LIKE v_like)
         -- Sin esto, teclear "calle 23" ni siquiera VE la calle guardada como
         -- "23": no la contiene como substring y el trigrama la manda a rank 4.
         OR n.norm_bare = v_bare OR n.norm_bare_official = v_bare
         OR (v_fuzzy AND (similarity(n.norm_raw,  v_qnorm) > 0.30
                       OR similarity(n.norm_disp, v_qnorm) > 0.30
                       OR (n.norm_official <> n.norm_raw
                           AND similarity(n.norm_official, v_qnorm) > 0.30))))
      END
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
    -- 00552: sobrevive la entrada de MEJOR match, no la más cercana.
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
      b.match_source,                                   -- (6) 00548
      b.id
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
  '00553 v9 - Como v8.1 más: (a) el prefijo genérico y su artículo dejan de decidir el ranking '
  '("23" ya encuentra la Calle 23 de al lado en vez de una a 7 km, y "calle 23" encuentra la '
  'guardada como "23"); (b) admite consultas de UN carácter con match exacto — las calles de una '
  'letra son el 11 % de las esquinas de Cuba y antes no devolvían nada.';

-- Andamios de prueba creados a mano en prod para comparar contra la viva.
DROP FUNCTION IF EXISTS public.search_streets_v9c(text, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.search_streets_v82c(text, double precision, double precision, integer);
DROP TABLE     IF EXISTS public.street_search_names_v9c;
DROP FUNCTION IF EXISTS public._street_bare_name_c(text);
