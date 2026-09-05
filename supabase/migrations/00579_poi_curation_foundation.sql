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
  -- Connectors are never touched in first position; Cuban acronyms stay upper.
  SELECT string_agg(
    CASE
      WHEN i > 1 AND lower(w) IN ('de','del','la','las','los','y','e','el','al','en','con','por','para') THEN lower(w)
      WHEN p_keep_case THEN w
      WHEN lower(w) IN ('etecsa','cupet','cimex','trd','cujae','uneac','icaic','focsa','minsap','mincult',
                        'bpa','bandec','bfi','cadeca','ecasa','egrem','isa','uci','fac','dhl','ups','atm') THEN upper(w)
      WHEN w ~ '&' THEN w
      ELSE upper(left(w,1)) || lower(substr(w,2))
    END, ' ' ORDER BY i)
  FROM unnest(string_to_array(s, ' ')) WITH ORDINALITY AS t(w, i) WHERE w <> '';
$function$;

CREATE OR REPLACE FUNCTION public._poi_clean_name(s text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public','pg_catalog' AS $function$
DECLARE v text; v_in text; v_conn int;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  v_in := regexp_replace(trim(s), '\s+', ' ', 'g');
  v := replace(replace(replace(replace(v_in, '“', '"'), '”', '"'), '‘', ''''), '’', '''');
  -- A name wrapped entirely in quotes loses them; inner quotes are part of the name.
  v := regexp_replace(v, '^"([^"]+)"$', '\1');
  v := regexp_replace(v, '^''([^'']+)''$', '\1');
  -- Wikidata Swedish descriptors imported by Overture: "(ö i Kuba)", "(periodiskt
  -- vattendrag i Kuba, Provincia de …)". Anchored on the "<term> … i Kuba" shape so
  -- "(by Sheraton)" survives.
  v := regexp_replace(v, '\s*\(((ö|öar|vattendrag|periodiskt|sjö|berg|by|ort|udde|bukt|flod|kulle|kommun|stad|halvö|lagun|vik|kanal|damm|grotta)\s+)+i\s+kuba\y[^)]*\)', '', 'gi');
  -- "(habana -Cuba )", "(La Habana)", "(Cuba)".
  v := regexp_replace(v, '\s*\(\s*(la\s+)?(habana|havana|cuba)\y[^)]*\)', '', 'gi');
  -- City / country suffixes. A comma OR a city word is required before "Cuba":
  -- "Banco Central de Cuba" and "Hotel Nacional de Cuba" keep their name.
  v := regexp_replace(v,
    '(,\s*(la\s+)?(habana|havana|l''havana|trinidad|varadero|cienfuegos|santiago de cuba|pinar del r[ií]o|holgu[ií]n|camag[uü]ey|matanzas|santa clara)?(,\s*|\s+)?cuba'
    || '|\s+(la\s+)?(habana|havana|trinidad|varadero|cienfuegos|santiago de cuba|pinar del r[ií]o|holgu[ií]n|camag[uü]ey|matanzas|santa clara)\s*,?\s*cuba)\s*$', '', 'i');
  -- ", La Habana" / ", Vedado" trailing — comma required ("Universidad de La Habana" stays).
  v := regexp_replace(v, ',\s*(la\s+)?(habana|havana)\s*$', '', 'i');
  v := regexp_replace(v, ',\s*(vedado|centro habana|habana vieja|playa|miramar|cerro)\s*$', '', 'i');
  v := regexp_replace(trim(v), '[,.\s]+$', '');
  v := regexp_replace(v, '\s+', ' ', 'g');
  IF v = '' THEN RETURN v_in; END IF;
  -- Case repair.
  IF v = upper(v) AND v ~ '[A-ZÁÉÍÓÚÑ]{2,}' THEN
    -- A single all-caps token of ≤ 6 letters is an acronym (ETECSA, CUJAE, FOCSA).
    IF v !~ '^[A-ZÁÉÍÓÚÑ&]{2,6}$' THEN v := _poi_title_case(v, false); END IF;
  ELSIF v = lower(v) AND v ~ '[a-záéíóúñ]{4,}' THEN
    v := _poi_title_case(v, false);
  ELSE
    -- Mixed case but every word capitalised with ≥ 2 capitalised connectors after the
    -- first word = a title-caser ran over it ("Museo Nacional De La Lucha Contra Los
    -- Bandidos"). One capitalised article stays ("Restaurante Los Nardos").
    SELECT count(*) INTO v_conn FROM regexp_matches(v, '\s(De|Del|La|Las|Los|Y|E|El|Al|En|Con|Por|Para)\y', 'g');
    IF v_conn >= 2 AND v !~ '(^|\s)[a-záéíóúñ]' THEN v := _poi_title_case(v, true); END IF;
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
