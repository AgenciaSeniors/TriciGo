-- ============================================================
-- Migration 00255: Smart category-aware POI search
--
-- The current search_pois RPC does ILIKE on name only. Two user
-- complaints surfaced from real testing:
--
--   1. Searching "Bar" returned mostly streets that start with "Bar"
--      (Bartolomé, Barracones) — not bars. The current RPC has no
--      concept of category-by-keyword.
--   2. Searching "Hospital" returned zero rows even though there are
--      1,901 hospital-categorised POIs in cuba_pois — because no POI
--      name actually contains the word "hospital" by itself.
--
-- Plus a finer concern: when the user does find a venue named "Bar"
-- (no proper name, just the OSM placeholder), it should NOT outrank
-- real bars with proper names like "Bar Bohemia" or "Cervecería Antiguo
-- Convento". And searching "El Gato" should still cross categories —
-- find "Bar El Gato" + "Zapatería El Gato" + "Cafetería El Gato" by
-- name match alone, no category bias.
--
-- This migration:
--   1. Creates `cuba_search_keywords` (Spanish + Cuban-vernacular) →
--      tricigo_category mapping. Multi-word phrases supported via
--      longest-prefix match.
--   2. Replaces the search RPC with `search_pois_smart` that
--      simultaneously matches by name (cross-category) AND by detected
--      category, then ranks results so:
--        - Generic-name placeholders ("Bar" alone) sink to the bottom
--        - Exact / prefix name matches surface first
--        - Category-only matches (when keyword detected) follow
--        - Admin-curated rows tie-break before sync-managed rows
--        - Finally, distance.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

-- ────────────────────────────────────────────────────────────
-- 1. Keywords table (re-runnable: drop + repopulate)
-- ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS cuba_search_keywords CASCADE;

CREATE TABLE cuba_search_keywords (
  keyword          TEXT PRIMARY KEY,        -- normalized (lowercase, no accents)
  tricigo_category TEXT NOT NULL,
  notes            TEXT
);

CREATE INDEX idx_cuba_search_keywords_cat ON cuba_search_keywords (tricigo_category);

ALTER TABLE cuba_search_keywords ENABLE ROW LEVEL SECURITY;
CREATE POLICY cuba_search_keywords_read ON cuba_search_keywords FOR SELECT USING (true);

COMMENT ON TABLE cuba_search_keywords IS
  'Spanish + Cuban-vernacular keywords mapped to tricigo_category. Used by search_pois_smart() to detect category intent. Editable by admin.';

-- ────────────────────────────────────────────────────────────
-- 2. Seed (221 keywords, all lowercase + unaccented)
-- ────────────────────────────────────────────────────────────
INSERT INTO cuba_search_keywords (keyword, tricigo_category, notes) VALUES
  -- hospital
  ('hospital',                    'hospital', NULL),
  ('clinica',                     'hospital', NULL),
  ('policlinico',                 'hospital', NULL),
  ('consultorio',                 'hospital', 'CU: family doctor office'),
  ('consultorio del medico',      'hospital', 'CU: full term'),
  ('consultorio medico',          'hospital', NULL),
  ('dispensario',                 'hospital', NULL),
  ('sanatorio',                   'hospital', NULL),
  ('urgencias',                   'hospital', NULL),
  ('odontologico',                'hospital', NULL),
  ('odontologia',                 'hospital', NULL),
  ('dental',                      'hospital', NULL),
  ('dentista',                    'hospital', NULL),
  ('maternidad',                  'hospital', NULL),
  ('enfermeria',                  'hospital', NULL),
  ('optica',                      'hospital', NULL),
  ('centro medico',               'hospital', NULL),
  ('centro de salud',             'hospital', NULL),
  ('laboratorio',                 'hospital', NULL),
  -- pharmacy
  ('farmacia',                    'pharmacy', NULL),
  ('drogueria',                   'pharmacy', NULL),
  ('botica',                      'pharmacy', NULL),
  -- school
  ('escuela',                     'school', NULL),
  ('colegio',                     'school', NULL),
  ('universidad',                 'school', NULL),
  ('instituto',                   'school', NULL),
  ('academia',                    'school', NULL),
  ('biblioteca',                  'school', NULL),
  ('preescolar',                  'school', NULL),
  ('primaria',                    'school', NULL),
  ('secundaria',                  'school', NULL),
  ('basica',                      'school', NULL),
  ('preuniversitario',            'school', 'CU: pre-university'),
  ('pre universitario',           'school', NULL),
  ('ipu',                         'school', 'CU: Inst. Preuniversitario Urbano'),
  ('ipvce',                       'school', 'CU: Inst. Preuniv. Vocacional Ciencias Exactas'),
  ('esbec',                       'school', 'CU: Esc. Sec. Basica En el Campo'),
  ('espa',                        'school', 'CU: Esc. de iniciacion deportiva'),
  ('circulo infantil',            'school', 'CU: state-run kindergarten'),
  ('jardin de infancia',          'school', NULL),
  ('kindergarten',                'school', NULL),
  ('tecnico',                     'school', NULL),
  ('politecnico',                 'school', NULL),
  ('conservatorio',               'school', NULL),
  ('facultad',                    'school', NULL),
  ('sede universitaria',          'school', NULL),
  -- gov
  ('ministerio',                  'gov', NULL),
  ('gobierno',                    'gov', NULL),
  ('oficina',                     'gov', NULL),
  ('direccion provincial',        'gov', 'CU: provincial directorate'),
  ('direccion municipal',         'gov', NULL),
  ('direccion nacional',          'gov', NULL),
  ('provincial',                  'gov', 'CU: shorthand for direccion provincial'),
  ('municipal',                   'gov', NULL),
  ('nacional',                    'gov', NULL),
  ('alcaldia',                    'gov', NULL),
  ('municipio',                   'gov', NULL),
  ('ayuntamiento',                'gov', NULL),
  ('consejeria',                  'gov', NULL),
  ('consejo',                     'gov', NULL),
  ('juzgado',                     'gov', NULL),
  ('tribunal',                    'gov', NULL),
  ('fiscalia',                    'gov', NULL),
  ('correos',                     'gov', NULL),
  ('correo',                      'gov', NULL),
  ('bufete',                      'gov', 'CU: bufete colectivo'),
  ('bufete colectivo',            'gov', NULL),
  ('partido',                     'gov', 'CU: PCC offices'),
  ('comite',                      'gov', NULL),
  ('militante',                   'gov', NULL),
  ('delegacion',                  'gov', NULL),
  ('secretaria',                  'gov', NULL),
  ('notaria',                     'gov', NULL),
  ('registro civil',              'gov', NULL),
  -- hotel
  ('hotel',                       'hotel', NULL),
  ('hostal',                      'hotel', NULL),
  ('motel',                       'hotel', NULL),
  ('hospedaje',                   'hotel', NULL),
  ('posada',                      'hotel', NULL),
  ('resort',                      'hotel', NULL),
  ('apartamento',                 'hotel', NULL),
  ('casa particular',             'hotel', 'CU: licensed home rental'),
  ('casa de renta',               'hotel', NULL),
  ('bnb',                         'hotel', NULL),
  ('albergue',                    'hotel', NULL),
  ('cabana',                      'hotel', NULL),
  -- restaurant
  ('restaurante',                 'restaurant', NULL),
  ('restoran',                    'restaurant', NULL),
  ('comida',                      'restaurant', NULL),
  ('fonda',                       'restaurant', NULL),
  ('parrilla',                    'restaurant', NULL),
  ('comedor',                     'restaurant', 'CU: state-run cafeteria'),
  ('comedor obrero',              'restaurant', NULL),
  ('comedor escolar',             'restaurant', NULL),
  ('merendero',                   'restaurant', NULL),
  ('pizzeria',                    'restaurant', NULL),
  ('criollo',                     'restaurant', NULL),
  ('ranchon',                     'restaurant', 'CU: countryside restaurant'),
  -- paladar
  ('paladar',                     'paladar', 'CU: private restaurant'),
  -- cafe
  ('cafe',                        'cafe', NULL),
  ('cafeteria',                   'cafe', NULL),
  ('dulceria',                    'cafe', NULL),
  ('reposteria',                  'cafe', NULL),
  ('panaderia',                   'cafe', NULL),
  ('helado',                      'cafe', NULL),
  ('heladeria',                   'cafe', NULL),
  ('coppelia',                    'cafe', 'CU: famous ice cream chain'),
  ('brunch',                      'cafe', NULL),
  ('creperia',                    'cafe', NULL),
  ('jugueria',                    'cafe', NULL),
  -- bar
  ('bar',                         'bar', NULL),
  ('taberna',                     'bar', NULL),
  ('pub',                         'bar', NULL),
  ('cantina',                     'bar', NULL),
  ('cerveceria',                  'bar', NULL),
  ('antro',                       'bar', NULL),
  ('discoteca',                   'bar', NULL),
  ('club',                        'bar', NULL),
  ('cocteleria',                  'bar', NULL),
  -- supermarket
  ('supermercado',                'supermarket', NULL),
  ('mercado',                     'supermarket', NULL),
  ('hipermercado',                'supermarket', NULL),
  ('tienda mixta',                'supermarket', NULL),
  -- shop
  ('tienda',                      'shop', NULL),
  ('comercio',                    'shop', NULL),
  ('boutique',                    'shop', NULL),
  ('kiosco',                      'shop', NULL),
  ('bodega',                      'shop', 'CU: store/grocery'),
  ('mipyme',                      'shop', 'CU: micro/small private enterprise'),
  ('agro',                        'shop', 'CU: agromercado'),
  ('agromercado',                 'shop', NULL),
  ('candonga',                    'shop', 'CU: informal street market'),
  ('almacen',                     'shop', NULL),
  ('ferreteria',                  'shop', NULL),
  ('libreria',                    'shop', NULL),
  ('tienda cuc',                  'shop', 'CU: hard-currency store (legacy)'),
  ('tienda mlc',                  'shop', 'CU: MLC currency store'),
  ('recaudadora',                 'shop', 'CU: state hard-currency store'),
  ('etecsa',                      'shop', 'CU: telecom service point'),
  -- bank
  ('banco',                       'bank', NULL),
  ('financiera',                  'bank', NULL),
  ('cadeca',                      'bank', 'CU: currency exchange chain'),
  ('bandec',                      'bank', 'CU: Banco de Credito y Comercio'),
  ('bpa',                         'bank', 'CU: Banco Popular de Ahorro'),
  ('banco metropolitano',         'bank', NULL),
  -- atm
  ('cajero',                      'atm', NULL),
  ('atm',                         'atm', NULL),
  ('automatico',                  'atm', 'CU: cajero automatico'),
  -- gas_station
  ('gasolinera',                  'gas_station', NULL),
  ('gas',                         'gas_station', NULL),
  ('servicentro',                 'gas_station', NULL),
  ('fuel',                        'gas_station', NULL),
  ('cupet',                       'gas_station', 'CU: state gas station chain'),
  ('oro negro',                   'gas_station', 'CU: gas station chain'),
  -- museum
  ('museo',                       'museum', NULL),
  ('galeria',                     'museum', NULL),
  ('exposicion',                  'museum', NULL),
  ('exhibicion',                  'museum', NULL),
  ('centro cultural',             'museum', NULL),
  ('casa cultural',               'museum', NULL),
  ('casa de la trova',            'museum', 'CU: traditional music venue'),
  ('casa del joven creador',      'museum', NULL),
  -- park
  ('parque',                      'park', NULL),
  ('plaza',                       'park', NULL),
  ('jardin',                      'park', NULL),
  ('alameda',                     'park', NULL),
  ('paseo',                       'park', NULL),
  ('malecon',                     'park', 'CU: famous Havana seafront'),
  ('mirador',                     'park', NULL),
  -- beach
  ('playa',                       'beach', NULL),
  ('costa',                       'beach', NULL),
  ('arena',                       'beach', NULL),
  ('balneario',                   'beach', NULL),
  -- embassy
  ('embajada',                    'embassy', NULL),
  ('consulado',                   'embassy', NULL),
  -- religion
  ('iglesia',                     'religion', NULL),
  ('catedral',                    'religion', NULL),
  ('parroquia',                   'religion', NULL),
  ('capilla',                     'religion', NULL),
  ('templo',                      'religion', NULL),
  ('mezquita',                    'religion', NULL),
  ('sinagoga',                    'religion', NULL),
  ('monasterio',                  'religion', NULL),
  ('convento',                    'religion', NULL),
  -- transport
  ('parada',                      'transport', NULL),
  ('estacion',                    'transport', NULL),
  ('terminal',                    'transport', NULL),
  ('taxi',                        'transport', NULL),
  ('aeropuerto',                  'transport', NULL),
  ('puerto',                      'transport', NULL),
  ('ferrocarril',                 'transport', NULL),
  ('ferro',                       'transport', NULL),
  ('omnibus',                     'transport', NULL),
  ('guagua',                      'transport', 'CU: informal for bus'),
  ('camion',                      'transport', 'CU: shared truck transport'),
  ('bicitaxi',                    'transport', NULL),
  ('almendron',                   'transport', 'CU: classic American car taxi'),
  ('maquina',                     'transport', 'CU: informal taxi'),
  ('tren',                        'transport', NULL);

-- ────────────────────────────────────────────────────────────
-- 3. The smart RPC. Replaces search_pois usage from the cliente,
--    but kept as a separate function so the legacy search_pois RPC
--    keeps working for any other consumer.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION search_pois_smart(
  query TEXT,
  lat DOUBLE PRECISION DEFAULT 23.1136,
  lng DOUBLE PRECISION DEFAULT -82.3666,
  radius_m INTEGER DEFAULT 50000,
  max_results INTEGER DEFAULT 10
)
RETURNS TABLE(
  id BIGINT,
  name TEXT,
  category TEXT,
  subcategory TEXT,
  tricigo_category TEXT,
  address TEXT,
  municipality TEXT,
  province TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  phone TEXT,
  website TEXT,
  source TEXT,
  is_admin BOOLEAN,
  confidence REAL,
  distance_m DOUBLE PRECISION,
  matched_category TEXT,
  match_reason TEXT       -- 'name_exact' | 'name_prefix' | 'name_substring' | 'category_only'
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_norm     TEXT;
  v_like     TEXT;
  v_category TEXT;
BEGIN
  v_norm := lower(unaccent(trim(query)));
  IF v_norm IS NULL OR length(v_norm) < 1 THEN
    RETURN;
  END IF;
  v_like := '%' || v_norm || '%';

  -- Longest-prefix keyword match: lets multi-word phrases like
  -- "casa particular" or "consultorio del medico" win over "casa".
  SELECT k.tricigo_category INTO v_category
  FROM cuba_search_keywords k
  WHERE v_norm = k.keyword
     OR v_norm LIKE k.keyword || ' %'
  ORDER BY length(k.keyword) DESC
  LIMIT 1;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      p.id,
      p.name,
      p.category,
      p.subcategory,
      p.tricigo_category,
      COALESCE(p.address, '')                              AS address,
      COALESCE(p.municipality, p.city, '')                 AS municipality,
      COALESCE(p.province, '')                             AS province,
      ST_Y(p.location::geometry)                           AS latitude,
      ST_X(p.location::geometry)                           AS longitude,
      p.phone,
      p.website,
      p.source,
      p.is_admin,
      p.confidence,
      ST_Distance(
        p.location,
        ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
      )                                                    AS distance_m,
      v_category                                           AS matched_category,
      -- Why was this row included?
      CASE
        WHEN p.name_normalized = v_norm                                         THEN 'name_exact'
        WHEN p.name_normalized ILIKE v_norm || '%'                              THEN 'name_prefix'
        WHEN p.name_normalized ILIKE v_like
             OR p.name ILIKE v_like                                             THEN 'name_substring'
        WHEN v_category IS NOT NULL AND p.tricigo_category = v_category         THEN 'category_only'
        ELSE 'unknown'
      END                                                   AS match_reason,
      -- Generic placeholder detection: a venue whose entire name equals the
      -- detected category keyword is almost certainly OSM auto-fill (e.g. a
      -- node tagged amenity=bar with no name=* gets imported as just "Bar").
      -- We sink these to the bottom so real venues with proper names rank
      -- above them.
      CASE WHEN p.name_normalized = v_norm THEN 1 ELSE 0 END AS is_generic,
      -- Match-quality buckets, lowest = best
      CASE
        WHEN p.name_normalized = v_norm                                         THEN 0
        WHEN p.name_normalized ILIKE v_norm || '%'                              THEN 1
        WHEN p.name_normalized ILIKE v_like
             OR p.name ILIKE v_like                                             THEN 2
        WHEN v_category IS NOT NULL AND p.tricigo_category = v_category         THEN 3
        ELSE 9
      END                                                   AS rank_quality
    FROM cuba_pois p
    WHERE p.is_active
      AND ST_DWithin(
        p.location,
        ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
        radius_m
      )
      -- Hide the OSM noise tags we never want in search results
      AND p.category NOT IN ('highway','landuse','waterway','building','natural','barrier','place','man_made')
      -- Match either by name (cross-category) or by detected category
      AND (
        p.name_normalized ILIKE v_like
        OR p.name ILIKE v_like
        OR (v_category IS NOT NULL AND p.tricigo_category = v_category)
      )
  )
  SELECT
    r.id, r.name, r.category, r.subcategory, r.tricigo_category,
    r.address, r.municipality, r.province,
    r.latitude, r.longitude,
    r.phone, r.website, r.source, r.is_admin, r.confidence,
    r.distance_m, r.matched_category, r.match_reason
  FROM ranked r
  ORDER BY
    r.is_generic ASC,        -- placeholder names ("Bar", "Restaurante") last
    r.rank_quality ASC,      -- exact > prefix > substring > category-only
    r.is_admin DESC,         -- admin-curated tie-break
    r.confidence DESC NULLS LAST,
    r.distance_m ASC         -- closer wins on full tie
  LIMIT max_results;
END;
$$;

GRANT EXECUTE ON FUNCTION search_pois_smart(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, INTEGER)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION search_pois_smart(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, INTEGER) IS
  'Smart POI search. Detects category keywords (Spanish + Cuban vernacular) via cuba_search_keywords.keyword longest-prefix match, then mixes name-substring matches across categories with category-only matches. Generic placeholder names sink, exact name matches surface, distance breaks ties.';
