-- ============================================================================
-- Migration 00579: POI curation foundation
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §4
-- Plan: docs/superpowers/plans/2026-09-05-poi-quality-pr1-data.md (Tasks 1–5)
-- Rehearsed on a local PostGIS copy (supabase/tests/poi/) — every section is
-- idempotent and the file can be applied twice.
--
-- A. admin_create_poi / admin_update_poi / approve_poi_submission stop writing
--    the GENERATED column name_normalized (428C9 since 00309; verified in prod
--    inside BEGIN…ROLLBACK on 2026-09-05: every admin edit fails today).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. In-place patches over the LIVE bodies (pattern 00573): each target
--    literal must appear exactly once; a body that no longer mentions the
--    column is treated as already patched.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE v_src text; v_n int;
  c_t1 CONSTANT text := 'name_normalized = CASE WHEN p_name IS NOT NULL AND length(trim(p_name)) > 0
                           THEN lower(unaccent(trim(p_name))) ELSE name_normalized END,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_update_poi';
  IF v_src IS NULL THEN RAISE NOTICE '00579A: admin_update_poi absent; skip'; RETURN; END IF;
  IF position('name_normalized' IN v_src) = 0 THEN RAISE NOTICE '00579A: admin_update_poi already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_t1, ''))) / length(c_t1);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: admin_update_poi target found % times (expected 1)', v_n; END IF;
  EXECUTE replace(v_src, c_t1, '');
  RAISE NOTICE '00579A: admin_update_poi patched';
END $patch$;

DO $patch$
DECLARE v_src text; v_n int;
  c_cols CONSTANT text := 'name, name_normalized, category, subcategory, tricigo_category,';
  c_vals CONSTANT text := 'trim(p_name), v_name_norm, ''admin'', p_tricigo_category, p_tricigo_category,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_create_poi';
  IF v_src IS NULL THEN RAISE NOTICE '00579A: admin_create_poi absent; skip'; RETURN; END IF;
  IF position('name_normalized' IN v_src) = 0 THEN RAISE NOTICE '00579A: admin_create_poi already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_cols, ''))) / length(c_cols);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: admin_create_poi column target found % times', v_n; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_vals, ''))) / length(c_vals);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: admin_create_poi value target found % times', v_n; END IF;
  v_src := replace(v_src, c_cols, 'name, category, subcategory, tricigo_category,');
  v_src := replace(v_src, c_vals, 'trim(p_name), ''admin'', p_tricigo_category, p_tricigo_category,');
  EXECUTE v_src;
  RAISE NOTICE '00579A: admin_create_poi patched';
END $patch$;

DO $patch$
DECLARE v_src text; v_n int;
  c_cols CONSTANT text := 'name, name_normalized, tricigo_category, category, location,';
  c_vals CONSTANT text := 'v_submission.name,
    lower(unaccent(v_submission.name)),';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_poi_submission';
  IF v_src IS NULL THEN RAISE NOTICE '00579A: approve_poi_submission absent; skip'; RETURN; END IF;
  IF position('name_normalized' IN v_src) = 0 THEN RAISE NOTICE '00579A: approve_poi_submission already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_cols, ''))) / length(c_cols);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: approve column target found % times', v_n; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_vals, ''))) / length(c_vals);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: approve value target found % times', v_n; END IF;
  v_src := replace(v_src, c_cols, 'name, tricigo_category, category, location,');
  v_src := replace(v_src, c_vals, 'v_submission.name,');
  EXECUTE v_src;
  RAISE NOTICE '00579A: approve_poi_submission patched';
END $patch$;

-- ---------------------------------------------------------------------------
-- B. Deterministic display-name cleaner + bare-name helper (spec §4.2).
--    Both IMMUTABLE and pure so the display_name trigger (§C) and the search
--    dictionary (§E) can call them on 110k rows and stay reproducible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._poi_title_case(s text, p_keep_case boolean DEFAULT false)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_catalog' AS $function$
  -- p_keep_case = false : Title Case every token (input was all-caps or all-lower).
  -- p_keep_case = true  : tokens keep their case; only the Spanish connectors are
  --                       lowercased (input was over-capitalised: "De La ... Los").
  -- Connectors are never touched in first position; "La Habana" keeps its capital;
  -- Cuban acronyms and "S.A."-style abbreviations stay upper.
  SELECT string_agg(
    CASE
      WHEN i > 1 AND lower(w) = 'la' AND lower(nw) = 'habana' THEN 'La'
      WHEN i > 1 AND lower(w) IN ('de','del','la','las','los','y','e','el','al','en','con','por','para') THEN lower(w)
      WHEN p_keep_case THEN w
      WHEN lower(w) IN ('etecsa','cupet','cimex','trd','cujae','uneac','icaic','focsa','minsap','mincult','ueb',
                        'bpa','bandec','bfi','cadeca','ecasa','egrem','isa','uci','fac','dhl','ups','atm') THEN upper(w)
      WHEN w ~ '&' OR w ~ '^([A-Z]\.)+$' THEN w
      ELSE upper(left(w,1)) || lower(substr(w,2))
    END, ' ' ORDER BY i)
  FROM (SELECT w, i, lead(w) OVER (ORDER BY i) AS nw
          FROM unnest(string_to_array(s, ' ')) WITH ORDINALITY AS t(w, i) WHERE w <> '') x;
$function$;

CREATE OR REPLACE FUNCTION public._poi_clean_name(s text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public','pg_catalog' AS $function$
DECLARE v text; v_in text; v_conn int;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  v_in := regexp_replace(trim(s), '\s+', ' ', 'g');
  -- Typographic quotes → ASCII (U+201C/U+201D/U+2018/U+2019).
  v := replace(replace(replace(replace(v_in, chr(8220), '"'), chr(8221), '"'), chr(8216), ''''), chr(8217), '''');
  -- A name wrapped entirely in quotes loses them; inner quotes are part of the name.
  -- An unbalanced quote is a typo ("Teatro Mariana Grajales"") and goes away.
  v := regexp_replace(v, '^"(.+)"$', '\1');
  v := regexp_replace(v, '^''([^'']+)''$', '\1');
  IF (length(v) - length(replace(v, '"', ''))) % 2 = 1 THEN v := replace(v, '"', ''); END IF;
  v := regexp_replace(v, '\s+,', ',', 'g');
  v := regexp_replace(trim(v), '[,\s]+$', '');
  -- Wikidata Swedish descriptors imported by Overture: "(ö i Kuba)", "(periodiskt
  -- vattendrag i Kuba, Provincia de …)". Anchored on the "<term> … i Kuba" shape so
  -- "(by Sheraton)" survives.
  v := regexp_replace(v, '\s*\(((ö|öar|vattendrag|periodiskt|sjö|berg|by|ort|udde|bukt|flod|kulle|kommun|stad|halvö|lagun|vik|kanal|damm|grotta)\s+)+i\s+kuba\y[^)]*\)', '', 'gi');
  -- …and the 13 prod rows whose parenthetical is ONLY Swedish nouns: "(periodiskt vattendrag)", "(halvö)".
  v := regexp_replace(v, '\s*\(((periodiskt|vattendrag|ö|öar|sjö|udde|bukt|flod|kulle|halvö|lagun|vik|kanal|damm|grotta)\s*)+\)', '', 'gi');
  -- "(habana -Cuba )", "(La Habana)", "(Cuba)", "(Cuba cell)".
  v := regexp_replace(v, '\s*\(\s*(la\s+)?(habana|havana|cuba)\y[^)]*\)', '', 'gi');
  -- Trailing period unless the last token is an abbreviation ("S.A.").
  IF v ~ '\.$' AND v !~ '\S*\.\S+\.$' THEN v := left(v, -1); END IF;
  -- City / country suffixes. A comma, a period OR a city word is required before
  -- "Cuba": "Banco Central de Cuba" and "Hotel Nacional de Cuba" keep their name.
  v := regexp_replace(v,
    '([,.]\s*(la\s+)?(habana|havana|l''havana|trinidad|varadero|cienfuegos|santiago de cuba|pinar del r[ií]o|holgu[ií]n|camag[uü]ey|matanzas|santa clara)?([,.]\s*|\s+)?cuba'
    || '|\s+(la\s+)?(habana|havana|trinidad|varadero|cienfuegos|santiago de cuba|pinar del r[ií]o|holgu[ií]n|camag[uü]ey|matanzas|santa clara)\s*[,.]?\s*cuba'
    || '|\.cuba)\s*$', '', 'i');
  -- ", La Habana" / ". Camagüey" / ", Vedado" trailing — a separator is required
  -- ("Universidad de La Habana" stays).
  v := regexp_replace(v, '[,.]\s*(la\s+)?(habana|havana|trinidad|varadero|cienfuegos|santiago de cuba|pinar del r[ií]o|holgu[ií]n|camag[uü]ey|matanzas|santa clara|vedado|centro habana|habana vieja|playa|miramar|cerro)\s*$', '', 'i');
  v := regexp_replace(trim(v), '[,\s]+$', '');
  IF v ~ '\.$' AND v !~ '\S*\.\S+\.$' THEN v := left(v, -1); END IF;
  v := regexp_replace(v, '\s+', ' ', 'g');
  IF v = '' THEN RETURN v_in; END IF;
  -- Case repair.
  IF v = upper(v) AND v ~ '[A-ZÁÉÍÓÚÑ]{2,}' THEN
    -- A single all-caps token of ≤ 6 letters is an acronym (ETECSA, CUJAE, FOCSA).
    IF v !~ '^[A-ZÁÉÍÓÚÑ&]{2,6}$' THEN v := _poi_title_case(v, false); END IF;
  ELSIF v = lower(v) AND v ~ '[a-záéíóúñ]{4,}' THEN
    v := _poi_title_case(v, false);
  ELSIF v !~ '(^|\s)[a-záéíóúñ]' THEN
    -- Mixed case, every word capitalised. "De/Del/Y" mid-name are never part of a
    -- proper name → always lowercased ("Palacio De Convenciones"). Articles
    -- ("La/Los/El") only when ≥ 2 capitalised connectors betray a title-caser
    -- ("Museo Nacional De La Lucha Contra Los Bandidos"); one capitalised article
    -- stays ("Restaurante Los Nardos").
    SELECT count(*) INTO v_conn FROM regexp_matches(v, '\s(De|Del|La|Las|Los|Y|E|El|Al|En|Con|Por|Para)\y', 'g');
    IF v_conn >= 2 THEN
      v := _poi_title_case(v, true);
    ELSE
      SELECT string_agg(CASE WHEN i > 1 AND w IN ('De','Del','Y','Al','En','Con','Por','Para') THEN lower(w) ELSE w END, ' ' ORDER BY i)
        INTO v FROM unnest(string_to_array(v, ' ')) WITH ORDINALITY AS t(w, i);
    END IF;
  END IF;
  RETURN v;
END $function$;

CREATE OR REPLACE FUNCTION public._poi_bare_name(s text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public','extensions','pg_catalog' AS $function$
  -- Accent-stripped lowercase name minus ONE leading generic word (with its "de la"
  -- link) OR one leading article — only when something remains. Mirrors
  -- _street_bare_name (00553): "Hotel Habana Libre" → "habana libre",
  -- "El Capitolio" → "capitolio", "Casa de la Música" → "musica", "Hotel" → "hotel".
  SELECT CASE WHEN s IS NULL THEN NULL ELSE COALESCE(NULLIF(trim(regexp_replace(
      lower(unaccent(s)),
      '^((hotel|hostal|restaurante|restaurant|bar|cafeteria|cafe|paladar|parque|playa|hospital|policlinico|clinica|escuela|iglesia|museo|teatro|cine|farmacia|banco|tienda|mercado|agromercado|panaderia|dulceria|heladeria|pizzeria|estadio|terminal|aeropuerto|universidad|instituto|casa|villa|plaza)(\s+(de las|de los|de la|del|de))?|el|la|los|las)\s+(?=\S)', '')), ''),
    lower(unaccent(s))) END;
$function$;

-- ---------------------------------------------------------------------------
-- C. Curation columns (spec §4.1). None of these is written by
--    bulk_upsert_pois / apply_osm_delta_batch (verified against the live
--    ON CONFLICT clause on 2026-09-05), so the weekly sync cannot undo them.
-- ---------------------------------------------------------------------------
ALTER TABLE public.cuba_pois
  ADD COLUMN IF NOT EXISTS display_name      text,
  ADD COLUMN IF NOT EXISTS name_override     text,
  ADD COLUMN IF NOT EXISTS category_override text,
  ADD COLUMN IF NOT EXISTS is_landmark       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pick_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_picked_at    timestamptz,
  ADD COLUMN IF NOT EXISTS merged_into       bigint REFERENCES public.cuba_pois(id) ON DELETE SET NULL;

-- The 24-value taxonomy. scripts/check-poi-taxonomy.mjs (CI) keeps the TS
-- side (@tricigo/utils TricigoCategory) byte-equal to this list.
CREATE OR REPLACE FUNCTION public.poi_taxonomy() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['hospital','pharmacy','school','gov','hotel','restaurant','paladar','cafe','bar',
               'supermarket','shop','bank','atm','gas_station','museum','park','beach','embassy',
               'religion','transport','other','landmark','venue','stadium'] $$;

DO $$ BEGIN
  ALTER TABLE public.cuba_pois ADD CONSTRAINT cuba_pois_category_override_chk
    CHECK (category_override IS NULL OR category_override = ANY (public.poi_taxonomy()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- tricigo_category gets the same CHECK as NOT VALID here; 00581 validates it after the data fixes.
DO $$ BEGIN
  ALTER TABLE public.cuba_pois ADD CONSTRAINT cuba_pois_tricigo_category_chk
    CHECK (tricigo_category IS NULL OR tricigo_category = ANY (public.poi_taxonomy())) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_display_name() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN
  NEW.display_name := COALESCE(NULLIF(trim(NEW.name_override), ''), public._poi_clean_name(NEW.name), NEW.name);
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS trg_cuba_pois_display_name ON public.cuba_pois;
CREATE TRIGGER trg_cuba_pois_display_name
  BEFORE INSERT OR UPDATE OF name, name_override ON public.cuba_pois
  FOR EACH ROW EXECUTE FUNCTION public.tg_cuba_pois_display_name();

-- Backfill in one pass (110k rows; RowExclusiveLock only, reads unaffected).
UPDATE public.cuba_pois SET display_name = public._poi_clean_name(name) WHERE display_name IS NULL;
ALTER TABLE public.cuba_pois ALTER COLUMN display_name SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cuba_pois_merged_into ON public.cuba_pois (merged_into) WHERE merged_into IS NOT NULL;

COMMENT ON COLUMN public.cuba_pois.display_name      IS '00579: what the apps show. COALESCE(name_override, _poi_clean_name(name)); recomputed by trigger, so the sync cannot dirty it.';
COMMENT ON COLUMN public.cuba_pois.name_override     IS '00579: admin-set display name; survives the sync (never in its ON CONFLICT SET).';
COMMENT ON COLUMN public.cuba_pois.category_override IS '00579: admin-set category; effective category = COALESCE(category_override, tricigo_category).';
COMMENT ON COLUMN public.cuba_pois.is_landmark       IS '00579: landmark tier for search ranking (Wikidata + curated). Never touched by the sync.';
COMMENT ON COLUMN public.cuba_pois.pick_count        IS '00579: rider picks resolved to this POI (PR-2 trigger on rides). Never touched by the sync.';
COMMENT ON COLUMN public.cuba_pois.last_picked_at    IS '00579: last rider pick resolved to this POI (PR-2).';
COMMENT ON COLUMN public.cuba_pois.merged_into       IS '00579: set on the deactivated loser of a duplicate merge; points at the surviving row.';

-- ---------------------------------------------------------------------------
-- D. Popular / official / brand aliases (spec §4.3). Never written by the sync.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cuba_poi_aliases (
  id          bigserial PRIMARY KEY,
  poi_id      bigint NOT NULL REFERENCES public.cuba_pois(id) ON DELETE CASCADE,
  alias       text   NOT NULL,
  alias_norm  text   NOT NULL,
  kind        text   NOT NULL CHECK (kind IN ('popular','official','brand','short','old')),
  source      text   NOT NULL CHECK (source IN ('admin','osm','seed','import')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (poi_id, alias_norm)
);
CREATE INDEX IF NOT EXISTS idx_cuba_poi_aliases_norm ON public.cuba_poi_aliases (alias_norm);
COMMENT ON TABLE public.cuba_poi_aliases IS '00579: names riders actually use ("La Benéfica" → Hospital Miguel Enríquez). One row per searchable variant; feeds poi_search_names. Admin CRUD via RPCs (PR-4); the sync never touches it.';

ALTER TABLE public.cuba_poi_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cuba_poi_aliases_read" ON public.cuba_poi_aliases;
CREATE POLICY "cuba_poi_aliases_read" ON public.cuba_poi_aliases FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.cuba_poi_aliases TO anon, authenticated;
-- No INSERT/UPDATE/DELETE policy: only service_role / SECURITY DEFINER admin RPCs write.

-- Seeds 1/2 — OSM tags already stored on active rows.
INSERT INTO public.cuba_poi_aliases (poi_id, alias, alias_norm, kind, source)
SELECT p.id, trim(v.alias), lower(unaccent(trim(v.alias))), v.kind, 'osm'
FROM public.cuba_pois p
CROSS JOIN LATERAL (VALUES
  (p.tags->>'alt_name',      'popular'),
  (p.tags->>'official_name', 'official'),
  (p.tags->>'short_name',    'short'),
  (p.tags->>'old_name',      'old'),
  (p.tags->>'brand',         'brand'),
  (p.tags->>'name:es',       'official')) AS v(alias, kind)
WHERE p.is_active AND v.alias IS NOT NULL AND length(trim(v.alias)) BETWEEN 2 AND 80
  AND lower(unaccent(trim(v.alias))) <> p.name_normalized
ON CONFLICT (poi_id, alias_norm) DO NOTHING;

-- Seeds 2/2 — curated Havana popular names. Each target is resolved by an ILIKE
-- pattern on name_normalized inside 800 m of the given point, never a transport
-- row (bus stops carry landmark names), preferring is_admin, then merged, then
-- confidence. Missing target → NOTICE, no row. Alias equal to the target's own
-- name → skipped (the bare/display dictionary rows already cover it).
DO $seed$
DECLARE r record; v_id bigint; v_norm text; v_n int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('La Ceguera',            '%oftalmolog%',              23.0946, -82.4177),
    ('La Benéfica',           '%miguel enriquez%',         23.1128, -82.3340),
    ('El Naval',              '%hospital naval%',          23.1548, -82.3068),
    ('Maternidad de Línea',   '%america arias%',           23.1409, -82.3870),
    ('Pediátrico del Cerro',  '%pediatrico%cerro%',        23.1102, -82.3782),
    ('Oncológico',            '%oncolog%',                 23.1268, -82.3815),
    ('La Coubre',             '%coubre%',                  23.1259, -82.3486),
    ('Cuatro Caminos',        'mercado 4 caminos',         23.1275, -82.3651),
    ('FAC',                   '%fabrica de arte cubano%',  23.1298, -82.4066),
    ('Fábrica de Arte',       '%fabrica de arte cubano%',  23.1298, -82.4066),
    ('El Cañonazo',           '%san carlos de la cabana%', 23.1508, -82.3486),
    ('La Cabaña',             '%san carlos de la cabana%', 23.1508, -82.3486),
    ('La Lonja',              'lonja del comercio%',       23.1382, -82.3467),
    ('Karl Marx',             'teatro karl marx%',         23.1220, -82.4109),
    ('Ciudad Deportiva',      'coliseo de la ciudad deportiva', 23.1055, -82.3792),
    ('Cementerio de Colón',   '%cementerio de colon%',     23.1257, -82.3968),
    ('Zoológico de 26',       'jardin zoologico de la habana', 23.1206, -82.3946),
    ('Zoológico Nacional',    'parque zoologico nacional', 23.0170, -82.4040),
    ('ExpoCuba',              'expocuba',                  23.0018, -82.3840),
    ('Marina Hemingway',      'marina hemingway',          23.0906, -82.5010),
    ('Manzana de Gómez',      'gran hotel manzana kempinski', 23.1379, -82.3583),
    ('Habana Libre',          'hotel habana libre',        23.1401, -82.3866),
    ('Hotel Nacional',        'hotel nacional de cuba',    23.1441, -82.3813),
    ('Capitolio',             'el capitolio',              23.1353, -82.3592),
    ('Bodeguita',             'la bodeguita del medio',    23.1408, -82.3519),
    ('Floridita',             'el floridita%',             23.1375, -82.3562),
    ('Tropicana',             'cabaret tropicana',         23.1049, -82.4302),
    ('Terminal de Ómnibus',   'terminal de omnibus nacionales%', 23.1268, -82.3922),
    ('Terminal 3',            'terminal 3%',               22.9975, -82.4056),
    ('Ameijeiras',            'hospital hermanos ameijeiras', 23.1430, -82.3696),
    ('Calixto García',        'hospital universitario general calixto garcia', 23.1403, -82.3893),
    ('Coppelia',              'coppelia',                  23.1397, -82.3849),
    ('Cine Yara',             'cine yara',                 23.1396, -82.3851),
    ('Estadio Latinoamericano','estadio latinoamericano',  23.1213, -82.3782),
    ('Plaza Carlos III',      'plaza carlos iii',          23.1311, -82.3820),
    ('Universidad de La Habana','universidad de la habana', 23.1373, -82.3826),
    ('CUJAE',                 'cujae',                     23.0298, -82.4362),
    ('Plaza de la Revolución','plaza de la revolucion',    23.1233, -82.3871),
    ('Parque Central',        'parque central',            23.1381, -82.3590),
    ('Parque Lenin',          'parque lenin',              23.0033, -82.3707),
    ('Playa Santa María',     'santa maria del mar',       23.1810, -82.2360),
    ('Alias Sin Destino',     'zzz-no-such-place-zzz',     23.1, -82.4)          -- proves the guard
  ) AS s(alias, pattern, lat, lng)
  LOOP
    v_id := NULL;
    SELECT p.id, p.name_normalized INTO v_id, v_norm FROM public.cuba_pois p
    WHERE p.is_active AND p.name_normalized ILIKE r.pattern
      AND p.category IS DISTINCT FROM 'public_transport' AND p.tricigo_category IS DISTINCT FROM 'transport'
      AND ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)::geography, 800)
    ORDER BY p.is_admin DESC, (p.source = 'merged') DESC, p.confidence DESC NULLS LAST, p.id
    LIMIT 1;
    IF v_id IS NULL THEN
      RAISE NOTICE '00579D: alias "%" — target not found (pattern %), skipped', r.alias, r.pattern;
      CONTINUE;
    END IF;
    IF lower(unaccent(r.alias)) = v_norm THEN CONTINUE; END IF;
    INSERT INTO public.cuba_poi_aliases (poi_id, alias, alias_norm, kind, source)
    VALUES (v_id, r.alias, lower(unaccent(r.alias)), 'popular', 'seed')
    ON CONFLICT (poi_id, alias_norm) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '00579D: % curated aliases seeded', v_n;
END $seed$;

-- ---------------------------------------------------------------------------
-- E. Precomputed search dictionary (spec §4.4; pattern: street_search_names,
--    00544). Every searchable name of every ACTIVE, unmerged POI, accent-
--    stripped. Rebuilt per POI (delete + reinsert) by statement-level triggers
--    with transition tables, so a 5,000-row sync batch costs one statement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.poi_search_names (
  poi_id bigint NOT NULL REFERENCES public.cuba_pois(id) ON DELETE CASCADE,
  norm   text   NOT NULL,
  kind   text   NOT NULL CHECK (kind IN ('display','bare','alias','brand')),
  weight real   NOT NULL DEFAULT 1.0,
  PRIMARY KEY (poi_id, norm, kind)
);
CREATE INDEX IF NOT EXISTS idx_poi_search_names_norm_trgm ON public.poi_search_names USING gin (norm gin_trgm_ops);
-- text_pattern_ops: the database collation is en_US.UTF-8, so a plain btree cannot
-- serve the prefix scans (norm LIKE 'habana%') search v2 relies on.
CREATE INDEX IF NOT EXISTS idx_poi_search_names_norm ON public.poi_search_names (norm text_pattern_ops);
ALTER TABLE public.poi_search_names ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "poi_search_names_read" ON public.poi_search_names;
CREATE POLICY "poi_search_names_read" ON public.poi_search_names FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.poi_search_names TO anon, authenticated;
COMMENT ON TABLE public.poi_search_names IS '00579: every searchable name of every ACTIVE, unmerged POI, accent-stripped: display (display_name), bare (minus generic prefix), alias/brand (cuba_poi_aliases). Rebuilt per POI by statement triggers; search_pois_smart v2 (PR-2) reads only this.';

CREATE OR REPLACE FUNCTION public._poi_search_names_rebuild(p_ids bigint[]) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public','extensions','pg_catalog' AS $function$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN; END IF;
  DELETE FROM public.poi_search_names WHERE poi_id = ANY (p_ids);
  INSERT INTO public.poi_search_names (poi_id, norm, kind, weight)
  SELECT p.id, lower(unaccent(p.display_name)), 'display', 1.0
    FROM public.cuba_pois p WHERE p.id = ANY (p_ids) AND p.is_active AND p.merged_into IS NULL
  UNION
  SELECT p.id, public._poi_bare_name(p.display_name), 'bare', 0.9
    FROM public.cuba_pois p WHERE p.id = ANY (p_ids) AND p.is_active AND p.merged_into IS NULL
     AND public._poi_bare_name(p.display_name) <> lower(unaccent(p.display_name))
  UNION
  SELECT a.poi_id, a.alias_norm, CASE WHEN a.kind = 'brand' THEN 'brand' ELSE 'alias' END, 1.0
    FROM public.cuba_poi_aliases a JOIN public.cuba_pois p ON p.id = a.poi_id
   WHERE a.poi_id = ANY (p_ids) AND p.is_active AND p.merged_into IS NULL
  ON CONFLICT (poi_id, norm, kind) DO NOTHING;
END $function$;

-- Trigger wrappers: transition tables are per-event, hence one function per event.
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_pois() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN
  PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT id FROM new_rows));
  RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases_ins() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT poi_id FROM new_rows)); RETURN NULL; END $function$;
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases_del() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT poi_id FROM old_rows)); RETURN NULL; END $function$;
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases_upd() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT poi_id FROM new_rows UNION SELECT DISTINCT poi_id FROM old_rows)); RETURN NULL; END $function$;

-- Plain AFTER INSERT / AFTER UPDATE (no column list: transition tables forbid one, 0A000).
DROP TRIGGER IF EXISTS trg_poi_search_names_pois_ins ON public.cuba_pois;
CREATE TRIGGER trg_poi_search_names_pois_ins AFTER INSERT ON public.cuba_pois
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_pois();
DROP TRIGGER IF EXISTS trg_poi_search_names_pois_upd ON public.cuba_pois;
CREATE TRIGGER trg_poi_search_names_pois_upd AFTER UPDATE ON public.cuba_pois
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_pois();
DROP TRIGGER IF EXISTS trg_poi_search_names_alias_ins ON public.cuba_poi_aliases;
CREATE TRIGGER trg_poi_search_names_alias_ins AFTER INSERT ON public.cuba_poi_aliases
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_aliases_ins();
DROP TRIGGER IF EXISTS trg_poi_search_names_alias_del ON public.cuba_poi_aliases;
CREATE TRIGGER trg_poi_search_names_alias_del AFTER DELETE ON public.cuba_poi_aliases
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_aliases_del();
DROP TRIGGER IF EXISTS trg_poi_search_names_alias_upd ON public.cuba_poi_aliases;
CREATE TRIGGER trg_poi_search_names_alias_upd AFTER UPDATE ON public.cuba_poi_aliases
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_aliases_upd();

-- Backfill: every active row (≈20k in prod), one statement.
SELECT public._poi_search_names_rebuild(ARRAY(SELECT id FROM public.cuba_pois WHERE is_active));
ANALYZE public.poi_search_names;
