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
