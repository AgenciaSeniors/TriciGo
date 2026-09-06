# POI quality — PR-1 (data + sync) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the server-side foundation of the POI overhaul (spec: `docs/superpowers/specs/2026-09-05-poi-quality-design.md` §4): fixed admin writers, clean display names, curation columns, popular aliases, the precomputed search dictionary, official municipality/province, garbage cleanup + duplicate merge, the 24-value taxonomy, and a working Wikidata source — all without changing any app.

**Architecture:** Three migrations (`00579` foundation, `00580` admin-area backfill, `00581` cleanup + taxonomy) plus `scripts/sync-pois` fixes and a CI taxonomy check. Curated data lives in columns/tables the sync's `ON CONFLICT` never writes; derived data is recomputed by triggers so the weekly sync cannot undo it. Every migration is rehearsed on the sandbox's local Postgres 16 (+PostGIS) with the LIVE function bodies transcribed, then executed (not just created), before the PR opens. Search v2 (spec §5) is PR-2 and does **not** ship here — `search_pois_smart` keeps working unchanged because the dictionary is additive.

**Tech Stack:** Postgres 16 / PostGIS / pg_trgm / unaccent (Supabase), plpgsql, Python 3.12 (`scripts/sync-pois`), Node ESM check script, vitest (`packages/utils`, `packages/api`).

**Branch:** `claude/poi-quality-ocsopo` (from `origin/master` `0dfdbf3`). Migration pre-flight at push time: master ends at `00577`, open PR #989 holds `00578`, #965 holds `00569` → this PR takes **00579–00581**. Re-run the pre-flight before pushing (CLAUDE.md § "Pre-flight para elegir número de migración").

**Prod facts the code below depends on (verified 2026-09-05):** `cuba_pois.name_normalized` is `GENERATED ALWAYS AS (lower(immutable_unaccent(name)))`; `bulk_upsert_pois` `ON CONFLICT … DO UPDATE SET name, category, subcategory, tricigo_category, address(COALESCE), location, source, source_ids, phone/website/socials/hours(COALESCE), confidence, synced_at, updated_at WHERE NOT is_admin` — it never writes `municipality`, `province`, `importance`, `footprint_radius_m` or any column added here; `map_category_to_tricigo` live body md5 `2ef5ae47ff6e2c349f9884b2f6735d58` (6,734 chars) equals migration 00302; `cuba_admin_areas` has 16 rows at `admin_level=4` and 168 at `admin_level=6`, `name = name_es` for all; `source_ids ? 'wd'` = 0 rows.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00579_poi_curation_foundation.sql` | fix 3 admin RPCs · `_poi_clean_name` · `_poi_bare_name` · curation columns + CHECK · `display_name` trigger · `cuba_poi_aliases` (+RLS, seeds) · `poi_search_names` dictionary (+triggers, backfill) |
| `supabase/migrations/00580_poi_admin_area_backfill.sql` | `_poi_admin_area` lookup · BEFORE trigger on location · batched backfill of municipality/province |
| `supabase/migrations/00581_poi_cleanup_and_taxonomy.sql` | taxonomy 24 values (`map_category_to_tricigo` v2, `import_search_poi` allow-list, keywords) · deactivate Swedish descriptors · merge exact duplicates · brand category fixes · validate CHECK |
| `supabase/tests/poi/scaffold.sql`, `supabase/tests/poi/tests.sql` | local rehearsal scaffold + behaviour tests (run by hand, documented in the PR body) |
| `scripts/sync-pois/download_wikidata.py` | SPARQL `IN (...)` comma fix |
| `scripts/sync-pois/merge_and_upsert.py` | `_boost_wikidata_importance` also sets `is_landmark` |
| `scripts/sync-pois/categories.json` | `landmark` / `venue` / `stadium` mappings |
| `scripts/check-poi-taxonomy.mjs` + `package.json` + `.github/workflows/ci.yml` | 4-surface taxonomy parity check |
| `packages/api/src/services/poi.service.ts` | `TriciGoCategory` + `TRICIGO_CATEGORIES` gain 3 values; `Poi` gains the new columns |
| `packages/utils/src/geo.ts`, `packages/utils/src/poiCategories.ts`, `packages/utils/src/addressSearch.ts` | emoji/group for the 3 new categories (`other` → 🏢 lands in PR-3 with the token-matching rewrite; here only the 3 additions) |
| `supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts` | map `landmark/monument/tourist_attraction/historic_site` → `landmark`, `theatre/cinema/…` → `venue`, `stadium` → `stadium` |

---

### Task 0: Local rehearsal environment (PostGIS on the sandbox's Postgres 16)

**Files:**
- Create: `supabase/tests/poi/scaffold.sql`
- Create: `supabase/tests/poi/README.md`

- [ ] **Step 1: Install PostGIS and start the `pgtest` server** (the `pgtest` user and `/home/pgtest/data` already exist from the 00578 rehearsal)

```bash
sudo apt-get install -y --no-install-recommends postgresql-16-postgis-3 postgresql-16-postgis-3-scripts
sudo -u pgtest /usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -l /home/pgtest/pg.log -o "-p 5433 -k /home/pgtest" start
sudo -u pgtest psql -p 5433 -h /home/pgtest -d postgres -c "CREATE DATABASE poi_rehearsal;"
```
Expected: `server started`, `CREATE DATABASE`.

- [ ] **Step 2: Write the scaffold** — the real DDL subset of `cuba_pois` (all 31 columns, `name_normalized` GENERATED, the two trgm indexes, the GIST index), `cuba_admin_areas`, `cuba_search_keywords`, `cuba_pois_submissions`, `users`, the `auth.uid()` / `is_admin()` shims, and the LIVE bodies of `admin_create_poi`, `admin_update_poi`, `approve_poi_submission`, `map_category_to_tricigo`, `tg_pois_default_tricigo_category`, `import_search_poi`, `find_nearby_poi_match` (fetch each with `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='…'` via the Supabase MCP and paste verbatim — remember that the text ends WITHOUT a `;`, add it).

```sql
-- supabase/tests/poi/scaffold.sql (excerpt — the file carries the full column list)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
CREATE OR REPLACE FUNCTION public.immutable_unaccent(t text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT public.unaccent('public.unaccent', t) $$;
CREATE TABLE public.users (id uuid PRIMARY KEY, role text);
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','super_admin')) $$;
CREATE TABLE public.cuba_admin_areas (
  id bigserial PRIMARY KEY, osm_id bigint, admin_level int, name text, name_es text,
  iso_code text, parent_province_iso text, geom geometry(MultiPolygon,4326), created_at timestamptz DEFAULT now());
CREATE TABLE public.cuba_search_keywords (keyword text PRIMARY KEY, tricigo_category text, notes text);
CREATE TABLE public.cuba_pois (
  id bigserial PRIMARY KEY, osm_id bigint, osm_type text DEFAULT 'node',
  name text NOT NULL,
  name_normalized text GENERATED ALWAYS AS (lower(public.immutable_unaccent(name))) STORED,
  category text, subcategory text, address text, city text, neighborhood text,
  location geography(Point,4326) NOT NULL, tags jsonb DEFAULT '{}'::jsonb,
  imported_at timestamptz DEFAULT now(), importance smallint DEFAULT 5,
  source text NOT NULL DEFAULT 'osm', source_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  tricigo_category text, phone text, website text, socials jsonb, hours text,
  confidence real DEFAULT 0.5, is_admin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true, province text, municipality text,
  synced_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  address_normalized text, footprint_radius_m smallint,
  UNIQUE (osm_id, osm_type));
CREATE INDEX idx_cuba_pois_name_trgm ON public.cuba_pois USING gin (name_normalized gin_trgm_ops);
CREATE INDEX idx_cuba_pois_location ON public.cuba_pois USING gist (location);
CREATE TABLE public.cuba_pois_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submitted_by uuid, name text, tricigo_category text,
  location geography(Point,4326), address text, notes text, status text DEFAULT 'pending',
  moderator_id uuid, moderated_at timestamptz, rejection_reason text, promoted_poi_id bigint,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), submitter_role text);
-- … then the 7 live function bodies pasted verbatim, each terminated with ';'
```

- [ ] **Step 3: Seed fixture rows** (append to the scaffold): 2 provinces + 3 municipalities as real polygons (Plaza de la Revolución, Centro Habana, La Habana Vieja — take `ST_AsText(geom)` from prod with the MCP, simplified with `ST_SimplifyPreserveTopology(geom, 0.001)` so the file stays small), 30 POIs covering every fixture class (Swedish descriptor, city suffix, ALL-CAPS acronym, lowercase, exact duplicates 20 m apart across sources, a bus stop named like a hospital, an admin row, a `wd` row, a CUPET row with `tags->>'brand'`), one admin user.

- [ ] **Step 4: Load and smoke**

```bash
sudo -u pgtest psql -p 5433 -h /home/pgtest -d poi_rehearsal -v ON_ERROR_STOP=1 -f supabase/tests/poi/scaffold.sql
sudo -u pgtest psql -p 5433 -h /home/pgtest -d poi_rehearsal -c "SELECT count(*) FROM cuba_pois; SELECT name_normalized FROM cuba_pois LIMIT 2;"
```
Expected: 30 rows; `name_normalized` populated with accents stripped.

- [ ] **Step 5: Reproduce the admin bug BEFORE any fix** (this is the red test for Task 1)

```bash
sudo -u pgtest psql -p 5433 -h /home/pgtest -d poi_rehearsal -c "
BEGIN; SELECT set_config('request.jwt.claim.sub', (SELECT id::text FROM users LIMIT 1), true);
SELECT admin_update_poi((SELECT min(id) FROM cuba_pois), 'X'); ROLLBACK;"
```
Expected: `ERROR:  428C9: column "name_normalized" can only be updated to DEFAULT`.

- [ ] **Step 6: Commit the scaffold**

```bash
git add supabase/tests/poi/scaffold.sql supabase/tests/poi/README.md
git commit -m "test(poi): local PostGIS rehearsal scaffold with the live admin RPC bodies"
```

---

### Task 1: 00579 §A — the three admin writers stop assigning `name_normalized`

**Files:**
- Create: `supabase/migrations/00579_poi_curation_foundation.sql` (section A)
- Test: `supabase/tests/poi/tests.sql` (T1)

- [ ] **Step 1: Write the failing test** (append to `tests.sql`; the harness is a `DO` block per test that prints `PASS`/`FAIL` — always `IF cond IS NOT TRUE` so NULL counts as failure, per CLAUDE.md)

```sql
-- supabase/tests/poi/tests.sql
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
```

- [ ] **Step 2: Run it against the scaffold — expect FAIL** (the DO aborts with 428C9 on T1a)

```bash
sudo -u pgtest psql -p 5433 -h /home/pgtest -d poi_rehearsal -f supabase/tests/poi/tests.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
```
Expected: `ERROR:  428C9 …`.

- [ ] **Step 3: Write section A of the migration** — in-place patches from the live bodies (pattern 00573), one `DO $patch$` per function, each guarded (target must appear exactly once; idempotent when the column is no longer mentioned)

```sql
-- ============================================================
-- Migration 00579: POI curation foundation (spec docs/superpowers/specs/2026-09-05-poi-quality-design.md §4)
-- A. admin_create_poi / admin_update_poi / approve_poi_submission stop writing the
--    GENERATED column name_normalized (428C9 since 00309; verified in prod inside
--    BEGIN…ROLLBACK on 2026-09-05: every admin edit fails).
-- ============================================================
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
```
(`v_name_norm` stays declared in `admin_create_poi` but unused — plpgsql allows it; the plan keeps the patch minimal.)

- [ ] **Step 4: Apply section A locally and re-run T1**

```bash
sudo -u pgtest psql -p 5433 -h /home/pgtest -d poi_rehearsal -v ON_ERROR_STOP=1 -f supabase/migrations/00579_poi_curation_foundation.sql
sudo -u pgtest psql -p 5433 -h /home/pgtest -d poi_rehearsal -f supabase/tests/poi/tests.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
```
Expected: `NOTICE: 00579A: … patched` ×3, then `PASS: T1a`, `PASS: T1b`, `PASS: T1c`. Run the migration a second time: three `already patched` notices, no error (idempotent).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00579_poi_curation_foundation.sql supabase/tests/poi/tests.sql
git commit -m "fix(poi): admin create/update/approve stop writing the generated name_normalized (428C9)"
```

---

### Task 2: 00579 §B — `_poi_clean_name` and `_poi_bare_name` (pure SQL helpers, fixture-tested)

**Files:**
- Modify: `supabase/migrations/00579_poi_curation_foundation.sql` (section B)
- Test: `supabase/tests/poi/tests.sql` (T2)

- [ ] **Step 1: Write the failing tests** (real prod names captured 2026-09-05)

```sql
-- T2: name cleaner
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
END $$;
```

- [ ] **Step 2: Run — expect `function _poi_clean_name(text) does not exist`.**

- [ ] **Step 3: Write section B**

```sql
-- B. Deterministic display-name cleaner + bare-name helper.
CREATE OR REPLACE FUNCTION public._poi_title_case(s text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public','pg_catalog' AS $function$
  -- Title Case with Spanish small words lowercased when not first; tokens of
  -- 2..5 letters that arrive ALL-CAPS are kept (ETECSA, CUJAE, CUPET, DHL, FAC).
  SELECT string_agg(
    CASE
      WHEN i > 1 AND lower(w) IN ('de','del','la','las','los','y','e','el','al','en','con','por','para') THEN lower(w)
      WHEN w = upper(w) AND w ~ '^[A-ZÁÉÍÓÚÑ&]{2,5}$' THEN w
      ELSE upper(left(w,1)) || lower(substr(w,2))
    END, ' ' ORDER BY i)
  FROM unnest(string_to_array(s, ' ')) WITH ORDINALITY AS t(w, i) WHERE w <> '';
$function$;

CREATE OR REPLACE FUNCTION public._poi_clean_name(s text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public','pg_catalog' AS $function$
DECLARE v text; v_in text;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  v_in := regexp_replace(trim(s), '\s+', ' ', 'g');
  v := replace(replace(v_in, '“', '"'), '”', '"');
  v := regexp_replace(v, '^["'']+|["'']+$', '', 'g');
  -- Wikidata (Swedish) descriptors and pure-location parentheses.
  v := regexp_replace(v, '\s*\((ö|öar|vattendrag|periodiskt|sjö|berg|by|ort|udde|bukt|flod|kulle|kommun|stad|halvö|lagun|vik|kanal|damm|grotta)\M[^)]*\)', '', 'gi');
  v := regexp_replace(v, '\s*\(\s*(la\s+)?(habana|havana|cuba)\b[^)]*\)', '', 'gi');
  -- City / country suffixes.
  v := regexp_replace(v, '(,\s*)?(en\s+)?(la\s+)?(habana|havana|l''havana|trinidad|varadero|cienfuegos|santiago de cuba|pinar del r[ií]o|holgu[ií]n|camag[uü]ey|matanzas|santa clara)?(,\s*|\s+)?cuba\s*$', '', 'i');
  v := regexp_replace(v, '(,\s*)?(la\s+)?(habana|havana)\s*$', '', 'i');
  v := regexp_replace(v, ',\s*(vedado|centro habana|habana vieja|playa|miramar|cerro)\s*$', '', 'i');
  v := regexp_replace(trim(v), '[,.\s]+$', '');
  v := regexp_replace(v, '\s+', ' ', 'g');
  IF v = '' THEN RETURN v_in; END IF;
  -- Case repair only when the whole name is shouted or whispered.
  IF v = upper(v) AND v ~ '[A-ZÁÉÍÓÚÑ]{6,}' THEN v := _poi_title_case(v);
  ELSIF v = lower(v) AND v ~ '[a-záéíóúñ]{4,}' THEN v := _poi_title_case(v);
  END IF;
  RETURN v;
END $function$;

CREATE OR REPLACE FUNCTION public._poi_bare_name(s text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public','extensions','pg_catalog' AS $function$
  -- Accent-stripped lowercase name minus ONE leading generic word (+ article),
  -- only when something remains — mirrors _street_bare_name (00553).
  SELECT COALESCE(NULLIF(trim(regexp_replace(regexp_replace(
      lower(unaccent(s)),
      '^(hotel|hostal|restaurante|restaurant|bar|cafeteria|cafe|paladar|parque|playa|hospital|policlinico|clinica|escuela|iglesia|museo|teatro|cine|farmacia|banco|tienda|mercado|agromercado|panaderia|dulceria|heladeria|pizzeria|estadio|terminal|aeropuerto|universidad|instituto|casa|villa|plaza|el|la|los|las)\s+(?=\S)', ''),
      '^(de las|de los|de la|del|de|el|la|los|las)\s+(?=\S)', '')), ''),
    lower(unaccent(s)));
$function$;
```
Note the `SET search_path` includes `extensions` for `unaccent` (installed there in prod; in the scaffold it is `public`, which the shim covers).

- [ ] **Step 4: Apply + run T2 → 17 PASS.** Iterate on the regexes until all pass; do not weaken a test to make it pass — every case is a real production name.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00579_poi_curation_foundation.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): deterministic display-name cleaner and bare-name helper"
```

---

### Task 3: 00579 §C — curation columns, CHECK, `display_name` trigger, backfill

**Files:**
- Modify: `supabase/migrations/00579_poi_curation_foundation.sql` (section C)
- Test: `supabase/tests/poi/tests.sql` (T3)

- [ ] **Step 1: Failing tests**

```sql
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
END $$;
```

- [ ] **Step 2: Run — expect `column "display_name" does not exist`.**

- [ ] **Step 3: Write section C**

```sql
-- C. Curation columns. None of these are written by bulk_upsert_pois /
--    apply_osm_delta_batch (verified against the live ON CONFLICT clause).
ALTER TABLE public.cuba_pois
  ADD COLUMN IF NOT EXISTS display_name      text,
  ADD COLUMN IF NOT EXISTS name_override     text,
  ADD COLUMN IF NOT EXISTS category_override text,
  ADD COLUMN IF NOT EXISTS is_landmark       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pick_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_picked_at    timestamptz,
  ADD COLUMN IF NOT EXISTS merged_into       bigint REFERENCES public.cuba_pois(id) ON DELETE SET NULL;

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

-- Backfill in one pass (110k rows, ~2 s measured on the rehearsal scale; RowExclusiveLock, reads unaffected).
UPDATE public.cuba_pois SET display_name = public._poi_clean_name(name) WHERE display_name IS NULL;
ALTER TABLE public.cuba_pois ALTER COLUMN display_name SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cuba_pois_merged_into ON public.cuba_pois (merged_into) WHERE merged_into IS NOT NULL;
COMMENT ON COLUMN public.cuba_pois.display_name IS '00579: what the apps show. COALESCE(name_override, _poi_clean_name(name)); recomputed by trigger, so the sync cannot dirty it.';
COMMENT ON COLUMN public.cuba_pois.name_override IS '00579: admin-set display name; survives the sync (never in its ON CONFLICT SET).';
COMMENT ON COLUMN public.cuba_pois.category_override IS '00579: admin-set category; effective category = COALESCE(category_override, tricigo_category).';
COMMENT ON COLUMN public.cuba_pois.is_landmark IS '00579: landmark tier for search ranking (Wikidata + curated). Never touched by the sync.';
COMMENT ON COLUMN public.cuba_pois.pick_count IS '00579: rider picks resolved to this POI (PR-2 trigger on rides). Never touched by the sync.';
COMMENT ON COLUMN public.cuba_pois.merged_into IS '00579: set on the deactivated loser of a duplicate merge; points at the surviving row.';
```

- [ ] **Step 4: Apply + run T3 → 5 PASS**; also `SELECT count(*) FROM cuba_pois WHERE display_name IS NULL` → 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00579_poi_curation_foundation.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): display_name trigger, curation columns and taxonomy CHECK on cuba_pois"
```

---

### Task 4: 00579 §D — `cuba_poi_aliases` (+RLS, OSM-tag seeds, curated Havana seeds)

**Files:**
- Modify: `supabase/migrations/00579_poi_curation_foundation.sql` (section D)
- Test: `supabase/tests/poi/tests.sql` (T4)

- [ ] **Step 1: Failing tests**

```sql
-- T4: aliases
DO $$ DECLARE v_id bigint; BEGIN
  SELECT id INTO v_id FROM cuba_pois WHERE name = 'Hospital Miguel Enríquez' LIMIT 1;   -- fixture row
  PERFORM _t('T4a curated seed resolved', EXISTS (SELECT 1 FROM cuba_poi_aliases WHERE poi_id = v_id AND alias = 'La Benéfica' AND kind = 'popular' AND source = 'seed'));
  PERFORM _t('T4b alias_norm', (SELECT alias_norm = 'la benefica' FROM cuba_poi_aliases WHERE poi_id = v_id AND alias = 'La Benéfica'));
  PERFORM _t('T4c osm brand seed', EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE p.tags->>'brand' = 'Cupet' AND a.alias = 'Cupet' AND a.kind = 'brand' AND a.source = 'osm'));
  PERFORM _t('T4d no alias equal to name', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases a JOIN cuba_pois p ON p.id = a.poi_id WHERE a.alias_norm = p.name_normalized));
  PERFORM _t('T4e missing seed target is skipped', NOT EXISTS (SELECT 1 FROM cuba_poi_aliases WHERE alias = 'Alias Sin Destino'));
END $$;
```

- [ ] **Step 2: Run — expect `relation "cuba_poi_aliases" does not exist`.**

- [ ] **Step 3: Write section D**

```sql
-- D. Popular / official / brand aliases. Never written by the sync.
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
SELECT p.id, v.alias, lower(unaccent(v.alias)), v.kind, 'osm'
FROM public.cuba_pois p
CROSS JOIN LATERAL (VALUES
  (p.tags->>'alt_name',      'popular'),
  (p.tags->>'official_name', 'official'),
  (p.tags->>'short_name',    'short'),
  (p.tags->>'old_name',      'old'),
  (p.tags->>'brand',         'brand'),
  (p.tags->>'name:es',       'official')) AS v(alias, kind)
WHERE p.is_active AND v.alias IS NOT NULL AND length(trim(v.alias)) BETWEEN 2 AND 80
  AND lower(unaccent(v.alias)) <> p.name_normalized
ON CONFLICT (poi_id, alias_norm) DO NOTHING;

-- Seeds 2/2 — curated Havana popular names. Each target is resolved by an ILIKE
-- pattern on name_normalized inside a bbox around the given point (≤ 800 m),
-- preferring is_admin then merged then confidence. Missing target → NOTICE, no row.
DO $seed$
DECLARE r record; v_id bigint; v_n int := 0;
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
    SELECT id INTO v_id FROM public.cuba_pois p
    WHERE p.is_active AND p.name_normalized ILIKE r.pattern
      AND p.category IS DISTINCT FROM 'public_transport' AND p.tricigo_category IS DISTINCT FROM 'transport'
      AND ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)::geography, 800)
    ORDER BY p.is_admin DESC, (p.source = 'merged') DESC, p.confidence DESC NULLS LAST, p.id
    LIMIT 1;
    IF v_id IS NULL THEN
      RAISE NOTICE '00579D: alias "%" — target not found (pattern %), skipped', r.alias, r.pattern;
      CONTINUE;
    END IF;
    INSERT INTO public.cuba_poi_aliases (poi_id, alias, alias_norm, kind, source)
    VALUES (v_id, r.alias, lower(unaccent(r.alias)), 'popular', 'seed')
    ON CONFLICT (poi_id, alias_norm) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '00579D: % curated aliases seeded', v_n;
END $seed$;
```
The coordinates come from the 2026-09-05 prod lookup (ids 196019 Ameijeiras, 195545 Habana Libre, 195601 Nacional, 196743 El Capitolio, 21269 Bodeguita, 193175 Tropicana, 195533 Universidad, 195911 Plaza Carlos III, 194397 Plaza de la Revolución, 11241 Parque Central, 192839 La Ceguera, 198104 Naval, 193906 América Arias, 194402 Pediátrico Cerro, 194449 Oncológico, 197789 La Cabaña, 197638 Lonja, 193084 Karl Marx, 18434 Coliseo, 193760 Cementerio, 17529 Zoológico 26, 209128 Zoológico Nacional, 209058 ExpoCuba, 192387 Marina, 196627 Kempinski, 193277 FAC, 119830 Coppelia, 16084 Cine Yara, 54803 Estadio, 209130 CUJAE, 197046 Parque Lenin, 199707 Santa María). The scaffold fixture must contain a `Hospital Miguel Enríquez` row at (23.1128, −82.3340) and a CUPET row with `tags = '{"brand":"Cupet"}'` for T4.

- [ ] **Step 4: Apply + run T4 → 5 PASS.** Confirm the `Alias Sin Destino` NOTICE printed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00579_poi_curation_foundation.sql supabase/tests/poi/tests.sql supabase/tests/poi/scaffold.sql
git commit -m "feat(poi): cuba_poi_aliases with OSM-tag and curated Havana seeds"
```

---

### Task 5: 00579 §E — `poi_search_names` dictionary (+statement triggers, backfill)

**Files:**
- Modify: `supabase/migrations/00579_poi_curation_foundation.sql` (section E)
- Test: `supabase/tests/poi/tests.sql` (T5)

- [ ] **Step 1: Failing tests**

```sql
-- T5: dictionary
DO $$ DECLARE v_id bigint; BEGIN
  SELECT id INTO v_id FROM cuba_pois WHERE name = 'Hotel Habana Libre' LIMIT 1;   -- fixture row
  PERFORM _t('T5a display row',  EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='display' AND norm='hotel habana libre'));
  PERFORM _t('T5b bare row',     EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='bare' AND norm='habana libre'));
  INSERT INTO cuba_poi_aliases (poi_id, alias, alias_norm, kind, source) VALUES (v_id, 'El Libre', 'el libre', 'popular', 'admin');
  PERFORM _t('T5c alias row appears', EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='alias' AND norm='el libre'));
  DELETE FROM cuba_poi_aliases WHERE poi_id = v_id AND alias_norm = 'el libre';
  PERFORM _t('T5d alias row removed', NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='alias' AND norm='el libre'));
  UPDATE cuba_pois SET name_override = 'Habana Libre Tryp' WHERE id = v_id;
  PERFORM _t('T5e display row follows override', EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND kind='display' AND norm='habana libre tryp') AND NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id AND norm='hotel habana libre'));
  UPDATE cuba_pois SET is_active = false WHERE id = v_id;
  PERFORM _t('T5f inactive rows leave', NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_id));
  UPDATE cuba_pois SET is_active = true, name_override = NULL WHERE id = v_id;
  PERFORM _t('T5g reactivation rebuilds', (SELECT count(*) = 2 FROM poi_search_names WHERE poi_id = v_id));   -- display + bare
END $$;
```

- [ ] **Step 2: Run — expect `relation "poi_search_names" does not exist`.**

- [ ] **Step 3: Write section E** — rebuild-per-poi semantics (delete the POI's rows, reinsert) keeps the trigger logic tiny and idempotent; statement-level with transition tables so a 5,000-row sync batch is one statement.

```sql
-- E. Precomputed search dictionary (pattern: street_search_names, 00544).
CREATE TABLE IF NOT EXISTS public.poi_search_names (
  poi_id bigint NOT NULL REFERENCES public.cuba_pois(id) ON DELETE CASCADE,
  norm   text   NOT NULL,
  kind   text   NOT NULL CHECK (kind IN ('display','bare','alias','brand')),
  weight real   NOT NULL DEFAULT 1.0,
  PRIMARY KEY (poi_id, norm, kind)
);
CREATE INDEX IF NOT EXISTS idx_poi_search_names_norm_trgm ON public.poi_search_names USING gin (norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_poi_search_names_norm ON public.poi_search_names (norm);
ALTER TABLE public.poi_search_names ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "poi_search_names_read" ON public.poi_search_names;
CREATE POLICY "poi_search_names_read" ON public.poi_search_names FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.poi_search_names TO anon, authenticated;
COMMENT ON TABLE public.poi_search_names IS '00579: every searchable name of every ACTIVE, unmerged POI, accent-stripped: display (display_name), bare (minus generic prefix), alias/brand (cuba_poi_aliases). Rebuilt per POI by statement triggers; search_pois_smart v2 (PR-2) reads only this.';

CREATE OR REPLACE FUNCTION public._poi_search_names_rebuild(p_ids bigint[]) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public','extensions','pg_catalog' AS $function$
BEGIN
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

CREATE OR REPLACE FUNCTION public._poi_search_names_sync_pois() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN
  PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT id FROM new_rows));
  RETURN NULL;
END $function$;
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN
  PERFORM public._poi_search_names_rebuild(ARRAY(
    SELECT DISTINCT poi_id FROM new_rows UNION SELECT DISTINCT poi_id FROM old_rows));
  RETURN NULL;
END $function$;

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
```
The alias triggers need a transition table each way; write three small wrappers instead of one:

```sql
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases_ins() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT poi_id FROM new_rows)); RETURN NULL; END $function$;
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases_del() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT poi_id FROM old_rows)); RETURN NULL; END $function$;
CREATE OR REPLACE FUNCTION public._poi_search_names_sync_aliases_upd() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_catalog' AS $function$
BEGIN PERFORM public._poi_search_names_rebuild(ARRAY(SELECT DISTINCT poi_id FROM new_rows UNION SELECT DISTINCT poi_id FROM old_rows)); RETURN NULL; END $function$;
DROP TRIGGER IF EXISTS trg_poi_search_names_alias_del ON public.cuba_poi_aliases;
CREATE TRIGGER trg_poi_search_names_alias_del AFTER DELETE ON public.cuba_poi_aliases
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_aliases_del();
DROP TRIGGER IF EXISTS trg_poi_search_names_alias_upd ON public.cuba_poi_aliases;
CREATE TRIGGER trg_poi_search_names_alias_upd AFTER UPDATE ON public.cuba_poi_aliases
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._poi_search_names_sync_aliases_upd();

-- Backfill: every active row (≈20k), in one statement.
SELECT public._poi_search_names_rebuild(ARRAY(SELECT id FROM public.cuba_pois WHERE is_active));
ANALYZE public.poi_search_names;
```
(Drop the single generic `_poi_search_names_sync_aliases` function from the first block — keep only the three wrappers; the plan shows both so the reader sees why.)

- [ ] **Step 4: Apply + run T5 → 7 PASS.** Then measure on the rehearsal: `EXPLAIN ANALYZE SELECT poi_id FROM poi_search_names WHERE norm LIKE 'habana%'` → Index Scan on `idx_poi_search_names_norm`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00579_poi_curation_foundation.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): poi_search_names dictionary maintained by statement triggers"
```

---

### Task 6: 00580 — official municipality / province (trigger + batched backfill)

**Files:**
- Create: `supabase/migrations/00580_poi_admin_area_backfill.sql`
- Test: `supabase/tests/poi/tests.sql` (T6)

- [ ] **Step 1: Failing tests** (fixture polygons: Plaza de la Revolución / Centro Habana / La Habana Vieja inside province La Habana)

```sql
-- T6: admin areas
DO $$ DECLARE v_id bigint; BEGIN
  INSERT INTO cuba_pois (name, category, location, source, municipality, province) VALUES
   ('Cafetería Prueba Vedado', 'cafe', ST_SetSRID(ST_MakePoint(-82.3866,23.1401),4326)::geography, 'overture', 'Ciudad de la Habana', 'FL') RETURNING id INTO v_id;
  PERFORM _t('T6a insert derives from polygons', (SELECT municipality = 'Plaza de la Revolución' AND province = 'La Habana' FROM cuba_pois WHERE id = v_id));
  UPDATE cuba_pois SET location = ST_SetSRID(ST_MakePoint(-82.3560,23.1370),4326)::geography WHERE id = v_id;
  PERFORM _t('T6b move re-derives', (SELECT municipality = 'La Habana Vieja' FROM cuba_pois WHERE id = v_id));
  PERFORM _t('T6c backfill fixed legacy rows', NOT EXISTS (SELECT 1 FROM cuba_pois WHERE is_active AND province NOT IN (SELECT name_es FROM cuba_admin_areas WHERE admin_level = 4)));
END $$;
```

- [ ] **Step 2: Run — expect T6a FAIL (municipality stays "Ciudad de la Habana").**

- [ ] **Step 3: Write 00580**

```sql
-- ============================================================
-- Migration 00580: official municipality/province on cuba_pois (spec §4.6).
-- 759 distinct municipality strings and 200+ province strings ("FL", "TX",
-- "Матанзас", "City of Havana") among 19,939 active rows — the sources copy
-- whatever free text they carry. 00545 fixed street_intersections the same way.
-- ============================================================
CREATE OR REPLACE FUNCTION public._poi_admin_area(p_point geography, OUT municipality text, OUT province text)
LANGUAGE sql STABLE SET search_path TO 'public','extensions','pg_catalog' AS $function$
  SELECT
    (SELECT a.name_es FROM public.cuba_admin_areas a WHERE a.admin_level = 6 AND ST_Contains(a.geom, p_point::geometry) LIMIT 1),
    (SELECT a.name_es FROM public.cuba_admin_areas a WHERE a.admin_level = 4 AND ST_Contains(a.geom, p_point::geometry) LIMIT 1);
$function$;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_admin_area() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','extensions','pg_catalog' AS $function$
DECLARE v_mun text; v_prov text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.location::text = OLD.location::text THEN RETURN NEW; END IF;
  SELECT municipality, province INTO v_mun, v_prov FROM public._poi_admin_area(NEW.location);
  NEW.municipality := COALESCE(v_mun, NEW.municipality);
  NEW.province     := COALESCE(v_prov, NEW.province);
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS trg_cuba_pois_admin_area ON public.cuba_pois;
CREATE TRIGGER trg_cuba_pois_admin_area BEFORE INSERT OR UPDATE OF location ON public.cuba_pois
  FOR EACH ROW EXECUTE FUNCTION public.tg_cuba_pois_admin_area();

-- Backfill, batched by id (20k rows per chunk) — exceeds the 2-min session timeout otherwise.
SET statement_timeout = 0;
DO $backfill$
DECLARE c_chunk CONSTANT bigint := 20000; v_max bigint; v_from bigint := 0; v_changed bigint; v_total bigint := 0;
BEGIN
  SELECT COALESCE(max(id), 0) INTO v_max FROM public.cuba_pois;
  WHILE v_from <= v_max LOOP
    WITH target AS (
      SELECT p.id, (public._poi_admin_area(p.location)).*
      FROM public.cuba_pois p WHERE p.is_active AND p.id >= v_from AND p.id < v_from + c_chunk)
    UPDATE public.cuba_pois s
       SET municipality = COALESCE(t.municipality, s.municipality),
           province     = COALESCE(t.province, s.province)
      FROM target t WHERE s.id = t.id
       AND (s.municipality IS DISTINCT FROM COALESCE(t.municipality, s.municipality)
         OR s.province     IS DISTINCT FROM COALESCE(t.province, s.province));
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed; v_from := v_from + c_chunk;
  END LOOP;
  RAISE NOTICE '00580: % active POIs got their official municipality/province', v_total;
END $backfill$;
ANALYZE public.cuba_pois;
RESET statement_timeout;
```
The backfill `UPDATE` fires `trg_cuba_pois_admin_area`? No — it changes municipality/province, not `location`, and the trigger is `UPDATE OF location`; it does fire the dictionary trigger (harmless rebuild of the chunk's dictionary rows — that is the cost, ~20k rows × 2, acceptable once).

- [ ] **Step 4: Apply + run T6 → 3 PASS.**

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00580_poi_admin_area_backfill.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): official municipality/province from cuba_admin_areas (trigger + backfill)"
```

---

### Task 7: 00581 — taxonomy v2, garbage cleanup, duplicate merge, brand fixes

**Files:**
- Create: `supabase/migrations/00581_poi_cleanup_and_taxonomy.sql`
- Test: `supabase/tests/poi/tests.sql` (T7)

- [ ] **Step 1: Failing tests** (fixture: two "Coppelia" cafés 20 m apart — `merged` conf 0.77 and `overture` conf 0.9; a Swedish "Arroyo Guayabo (vattendrag i Kuba…)" landmark; a CUPET row with `tags->>'brand'='Cupet'` and `tricigo_category='other'`; a "Teatro Karl Marx" row with `category='theatre'`)

```sql
-- T7: cleanup + taxonomy
DO $$ DECLARE v_win bigint; v_lose bigint; BEGIN
  PERFORM _t('T7a swedish landmark deactivated', NOT EXISTS (SELECT 1 FROM cuba_pois WHERE is_active AND name LIKE 'Arroyo Guayabo (vattendrag%'));
  SELECT id INTO v_win  FROM cuba_pois WHERE name = 'Coppelia' AND source = 'merged';
  SELECT id INTO v_lose FROM cuba_pois WHERE name = 'Coppelia' AND source = 'overture';
  PERFORM _t('T7b merged wins over overture', (SELECT is_active FROM cuba_pois WHERE id = v_win));
  PERFORM _t('T7c loser points at winner', (SELECT NOT is_active AND merged_into = v_win FROM cuba_pois WHERE id = v_lose));
  PERFORM _t('T7d winner inherits source_ids', (SELECT source_ids ? 'ovt' FROM cuba_pois WHERE id = v_win));
  PERFORM _t('T7e loser left the dictionary', NOT EXISTS (SELECT 1 FROM poi_search_names WHERE poi_id = v_lose));
  PERFORM _t('T7f cupet brand → gas_station', (SELECT category_override = 'gas_station' FROM cuba_pois WHERE tags->>'brand' = 'Cupet' LIMIT 1));
  PERFORM _t('T7g theatre → venue via mapper', map_category_to_tricigo('theatre', NULL) = 'venue');
  PERFORM _t('T7h landmark via mapper', map_category_to_tricigo('landmark_and_historical_building', NULL) = 'landmark');
  PERFORM _t('T7i stadium via mapper', map_category_to_tricigo('leisure', 'stadium') = 'stadium');
  PERFORM _t('T7j museum stays museum', map_category_to_tricigo('museum', NULL) = 'museum');
  PERFORM _t('T7k import allow-list accepts venue', (import_search_poi('Teatro Prueba', 23.10, -82.40, NULL, 'venue', 'mb.test.1')->>'imported')::boolean AND EXISTS (SELECT 1 FROM cuba_pois WHERE name = 'Teatro Prueba' AND tricigo_category = 'venue'));
  PERFORM _t('T7l keyword teatro → venue', EXISTS (SELECT 1 FROM cuba_search_keywords WHERE keyword = 'teatro' AND tricigo_category = 'venue'));
  PERFORM _t('T7m CHECK validated', (SELECT convalidated FROM pg_constraint WHERE conname = 'cuba_pois_tricigo_category_chk'));
END $$;
```

- [ ] **Step 2: Run — expect T7a/T7c/T7f/T7g/T7h/T7i/T7l FAIL.**

- [ ] **Step 3: Write 00581** — the mapper is a full `CREATE OR REPLACE` copied from 00302 (live md5 `2ef5ae47…` equals the file — assert it in a `DO` before replacing, abort with a clear message otherwise) with these edits: the `theatre/cinema/monument/attraction/artwork/topic_concert_venue/music_production` group returns `venue` for `theatre|cinema|topic_concert_venue|music_production|cabaret|nightclub_venue` and `landmark` for `monument|attraction|artwork|landmark|landmark_and_historical_building|historic|memorial|fort|fortress|castle|lighthouse|public_plaza`; add `stadium|sports_stadium|sports_complex|arena` → `stadium` in both the subcategory and category branches; add `IF p_category ILIKE 'landmarks and outdoors > %' THEN RETURN 'landmark'` before the generic `arts and entertainment` rule. Then:

```sql
-- keywords
INSERT INTO public.cuba_search_keywords (keyword, tricigo_category) VALUES
  ('teatro','venue'), ('cine','venue'), ('cabaret','venue'), ('sala de conciertos','venue'),
  ('estadio','stadium'), ('coliseo','stadium'), ('monumento','landmark'), ('memorial','landmark'),
  ('fortaleza','landmark'), ('castillo','landmark'), ('faro','landmark'), ('malecon','landmark')
ON CONFLICT (keyword) DO UPDATE SET tricigo_category = EXCLUDED.tricigo_category;

-- import_search_poi allow-list: patch in place (the literal appears once in the live body)
DO $patch$
DECLARE v_src text; v_n int;
  c_t CONSTANT text := '''supermarket'',''restaurant'',''paladar'',''cafe'',''bar'',''shop'',''atm''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'import_search_poi';
  IF v_src IS NULL OR position('''landmark''' IN v_src) > 0 THEN RAISE NOTICE '00581: import_search_poi absent or already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_t, ''))) / length(c_t);
  IF v_n <> 1 THEN RAISE EXCEPTION '00581: import_search_poi allow-list found % times', v_n; END IF;
  EXECUTE replace(v_src, c_t, c_t || ',''landmark'',''venue'',''stadium''');
END $patch$;

-- Re-map rows whose stored category now resolves to a new value (only where nothing was curated).
UPDATE public.cuba_pois p SET tricigo_category = public.map_category_to_tricigo(p.category, p.subcategory)
 WHERE p.is_active AND NOT p.is_admin AND p.category_override IS NULL
   AND public.map_category_to_tricigo(p.category, p.subcategory) IN ('landmark','venue','stadium')
   AND p.tricigo_category IS DISTINCT FROM public.map_category_to_tricigo(p.category, p.subcategory);

-- Swedish Wikidata descriptors imported by Overture as "landmarks": streams, islands, hills.
UPDATE public.cuba_pois SET is_active = false, updated_at = now()
 WHERE is_active AND NOT is_admin
   AND name ~ '\((ö|öar|vattendrag|periodiskt|sjö|berg|by|ort|udde|bukt|flod|kulle|kommun|stad|halvö|lagun|vik|kanal|damm|grotta)\M';

-- Brand → category (curated override so the weekly sync cannot undo it).
UPDATE public.cuba_pois SET category_override = 'gas_station'
 WHERE is_active AND category_override IS NULL
   AND (lower(coalesce(tags->>'brand','')) = 'cupet' OR lower(coalesce(tags->>'operator','')) LIKE 'cupet%' OR name_normalized ~ '^cupet\M')
   AND coalesce(tricigo_category,'') <> 'gas_station';

-- Exact duplicates: same normalized name, same effective category, ≤150 m. One winner per cluster.
DO $merge$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    WITH act AS (
      SELECT id, name_normalized, coalesce(category_override, tricigo_category) AS cat, location, source, is_admin, confidence, source_ids
      FROM public.cuba_pois WHERE is_active AND merged_into IS NULL),
    pairs AS (
      SELECT a.id AS a_id, b.id AS b_id,
        CASE WHEN a.is_admin THEN 4 WHEN a.source='merged' THEN 3 WHEN a.source='overture' THEN 2 WHEN a.source='foursquare' THEN 1 ELSE 0 END AS a_rank,
        CASE WHEN b.is_admin THEN 4 WHEN b.source='merged' THEN 3 WHEN b.source='overture' THEN 2 WHEN b.source='foursquare' THEN 1 ELSE 0 END AS b_rank,
        a.confidence AS a_conf, b.confidence AS b_conf
      FROM act a JOIN act b ON a.id < b.id AND a.name_normalized = b.name_normalized AND a.cat IS NOT DISTINCT FROM b.cat
       AND ST_DWithin(a.location, b.location, 150))
    SELECT CASE WHEN (a_rank, coalesce(a_conf,0), -a_id) >= (b_rank, coalesce(b_conf,0), -b_id) THEN a_id ELSE b_id END AS winner,
           CASE WHEN (a_rank, coalesce(a_conf,0), -a_id) >= (b_rank, coalesce(b_conf,0), -b_id) THEN b_id ELSE a_id END AS loser
    FROM pairs
  LOOP
    -- A row already merged in an earlier iteration is skipped (cluster of 3+).
    IF EXISTS (SELECT 1 FROM public.cuba_pois WHERE id IN (r.winner, r.loser) AND (merged_into IS NOT NULL OR NOT is_active)) THEN CONTINUE; END IF;
    UPDATE public.cuba_pois w SET source_ids = w.source_ids || l.source_ids, updated_at = now()
      FROM public.cuba_pois l WHERE w.id = r.winner AND l.id = r.loser;
    UPDATE public.cuba_pois SET is_active = false, merged_into = r.winner, updated_at = now() WHERE id = r.loser AND NOT is_admin;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '00581: % duplicate rows merged', v_n;
END $merge$;

-- Now every stored category is inside the taxonomy → validate the NOT VALID CHECK from 00579.
UPDATE public.cuba_pois SET tricigo_category = 'other' WHERE tricigo_category IS NOT NULL AND NOT (tricigo_category = ANY (public.poi_taxonomy()));
ALTER TABLE public.cuba_pois VALIDATE CONSTRAINT cuba_pois_tricigo_category_chk;
```
Admin losers are never deactivated (`AND NOT is_admin` — an admin duplicate of an admin row is a curation decision, listed by the admin "Sospechosos" tab in PR-4). The merge loop runs in the migration transaction; on the rehearsal it processes the fixture pair; in prod the 1,020 pairs take seconds (two indexed updates each).

- [ ] **Step 4: Apply + run T7 → 13 PASS.** Also run the whole `tests.sql` again — T1–T6 must still pass after 00581 (`SELECT count(*) FROM _t_fail` → 0).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00581_poi_cleanup_and_taxonomy.sql supabase/tests/poi/tests.sql supabase/tests/poi/scaffold.sql
git commit -m "feat(poi): 24-value taxonomy, Swedish-descriptor cleanup, exact-duplicate merge, CUPET brand fix"
```

---

### Task 8: Taxonomy in code — TS types, emoji, groups, Mapbox map, `categories.json`, CI parity check

**Files:**
- Modify: `packages/api/src/services/poi.service.ts:9-36` (+ `Poi` fields `display_name`, `name_override`, `category_override`, `is_landmark`, `pick_count`, `merged_into`; `PoiSource` += `'wikidata' | 'crowdsource' | 'mapbox'`)
- Modify: `packages/utils/src/geo.ts:3047-3051` (`TricigoCategory` union) and `:3228-3252` (`tricigoCategoryEmoji`: `landmark` 🏛️, `venue` 🎭, `stadium` 🏟️)
- Modify: `packages/utils/src/poiCategories.ts:53-75` (`landmark: 'culture'`, `venue: 'culture'`, `stadium: 'culture'`)
- Modify: `supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts` (`monument/landmark/tourist_attraction/historic_site` → `landmark`; add `theatre: 'venue', cinema: 'venue', movie_theater: 'venue', concert_hall: 'venue', cabaret: 'venue', stadium: 'stadium', arena: 'stadium'`)
- Modify: `scripts/sync-pois/categories.json` (osm: `amenity=theatre`→venue, `amenity=cinema`→venue, `leisure=stadium`→stadium, `historic=*`→landmark, `tourism=attraction`→landmark; overture exact: `landmark_and_historical_building`→landmark, `theatre`/`cinema`/`movie_theater`→venue, `stadium_arena`→stadium; foursquare label_keywords: `theater`→venue, `stadium`→stadium, `monument`/`landmark`→landmark; wikidata q_ids: `Q570116`→landmark, `Q4989906`→landmark, `Q9259`→landmark, `Q12518`→landmark, `Q839954`→landmark, `Q5727902`→landmark)
- Create: `scripts/check-poi-taxonomy.mjs`; Modify: `package.json` (`"check:poi-taxonomy": "node scripts/check-poi-taxonomy.mjs"`), `.github/workflows/ci.yml` (step after `check:i18n`)
- Test: `packages/utils/src/__tests__/geo.test.ts` (emoji block) and `packages/utils/src/__tests__/poiCategories.test.ts` (new)

- [ ] **Step 1: Failing tests**

```ts
// packages/utils/src/__tests__/geo.test.ts — inside describe('end-to-end with tricigoCategoryEmoji')
it('new taxonomy values have their own emoji', () => {
  expect(tricigoCategoryEmoji('landmark')).toBe('🏛️');
  expect(tricigoCategoryEmoji('venue')).toBe('🎭');
  expect(tricigoCategoryEmoji('stadium')).toBe('🏟️');
});
```
```ts
// packages/utils/src/__tests__/poiCategories.test.ts
import { describe, it, expect } from 'vitest';
import { poiVisualGroup, POI_VISUAL_GROUPS } from '../poiCategories';
import { TRICIGO_CATEGORIES } from '@tricigo/api';   // if the package boundary makes this awkward, copy the 24 literals here

describe('poiVisualGroup', () => {
  it('maps every taxonomy value to a real group (never other by accident)', () => {
    for (const c of TRICIGO_CATEGORIES) {
      if (c === 'other') continue;
      expect(poiVisualGroup(c).key, c).not.toBe('other');
    }
  });
  it('new values land in culture', () => {
    expect(poiVisualGroup('landmark').key).toBe('culture');
    expect(poiVisualGroup('venue').key).toBe('culture');
    expect(poiVisualGroup('stadium').key).toBe('culture');
  });
  it('groups are unique by key', () => {
    expect(new Set(POI_VISUAL_GROUPS.map((g) => g.key)).size).toBe(POI_VISUAL_GROUPS.length);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm --filter @tricigo/utils test -- poiCategories geo`): emoji returns 📍 and `landmark` maps to `other`.

- [ ] **Step 3: Implement** the five source edits listed under **Files** (each is an added literal / map entry; keep alphabetical order where the file is alphabetical). Then the CI script:

```js
#!/usr/bin/env node
// scripts/check-poi-taxonomy.mjs — the tricigo_category vocabulary is declared in FOUR places
// (TS union, sync categories.json, Mapbox importer map, SQL poi_taxonomy()). A value that exists
// in one and not the others silently hides rows (00579 CHECK) or drops imports. Fails the build
// when the sets differ. Usage: node scripts/check-poi-taxonomy.mjs
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const ts = [...read('packages/api/src/services/poi.service.ts')
  .match(/export const TRICIGO_CATEGORIES[^\]]*\]/)[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const sql = [...read('supabase/migrations/00579_poi_curation_foundation.sql')
  .match(/poi_taxonomy\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const cats = JSON.parse(read('scripts/sync-pois/categories.json'));
const json = new Set([
  ...Object.entries(cats.osm).filter(([k]) => !k.startsWith('_')).map(([, v]) => v),
  ...Object.values(cats.overture.exact), ...Object.values(cats.overture.substring),
  ...Object.values(cats.foursquare.label_keywords), ...Object.values(cats.wikidata.q_ids),
]);
const mapbox = new Set([...read('supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts')
  .matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]));

const canon = new Set(ts);
let bad = 0;
const check = (label, set) => {
  const extra = [...set].filter((v) => !canon.has(v));
  if (extra.length) { console.error(`✗ ${label} uses values outside TRICIGO_CATEGORIES: ${extra.join(', ')}`); bad++; }
};
check('SQL poi_taxonomy()', new Set(sql));
if (sql.length !== ts.length) { console.error(`✗ SQL poi_taxonomy() has ${sql.length} values, TS has ${ts.length}`); bad++; }
check('scripts/sync-pois/categories.json', json);
check('import-mapbox-poi mapbox-categories.ts', mapbox);
if (bad) process.exit(1);
console.log(`✓ POI taxonomy consistent across 4 surfaces (${ts.length} values)`);
```
CI step (after the i18n step in `.github/workflows/ci.yml`):
```yaml
      # Guardrail: the POI category vocabulary lives in 4 places (00579 §4.8).
      - name: Check POI taxonomy parity
        run: pnpm check:poi-taxonomy
```

- [ ] **Step 4: Run** `pnpm --filter @tricigo/utils test`, `pnpm --filter @tricigo/api test`, `pnpm check-types`, `node scripts/check-poi-taxonomy.mjs` → all green; the script prints `✓ … (24 values)`. Temporarily add `'bogus'` to `categories.json` and confirm the script exits 1, then revert.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/poi.service.ts packages/utils/src/geo.ts packages/utils/src/poiCategories.ts packages/utils/src/__tests__ supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts scripts/sync-pois/categories.json scripts/check-poi-taxonomy.mjs package.json .github/workflows/ci.yml
git commit -m "feat(poi): landmark/venue/stadium across the 4 taxonomy surfaces + CI parity check"
```

---

### Task 9: Wikidata source actually loads (SPARQL fix + `is_landmark`)

**Files:**
- Modify: `scripts/sync-pois/download_wikidata.py:60-72` (`build_sparql_query`)
- Modify: `scripts/sync-pois/merge_and_upsert.py:435-472` (`_boost_wikidata_importance`)
- Test: `scripts/sync-pois/test_wikidata_query.py` (new, `python -m pytest` is not installed — use `python3 -c`/`unittest`)

- [ ] **Step 1: Failing test**

```python
# scripts/sync-pois/test_wikidata_query.py
import re, unittest
from download_wikidata import build_sparql_query, POI_TYPE_QIDS

class QueryShape(unittest.TestCase):
    def test_in_list_is_comma_separated(self):
        q = build_sparql_query()
        inside = re.search(r"IN \(([^)]*)\)", q).group(1)
        self.assertEqual(inside.count(","), len(POI_TYPE_QIDS) - 1)
        self.assertNotRegex(inside, r"wd:Q\d+ wd:Q")   # the bug: space-separated → HTTP 400

if __name__ == "__main__":
    unittest.main()
```
Run: `cd scripts/sync-pois && python3 test_wikidata_query.py` → FAIL (`count(",") == 0`).

- [ ] **Step 2: Fix** — in `build_sparql_query`: `qids_filter = ", ".join(f"wd:{q}" for q in POI_TYPE_QIDS)`. Re-run → OK. Then a live probe (read-only, no DB): `python3 download_wikidata.py --out /tmp/wd.geojson && python3 -c "import json;print(len(json.load(open('/tmp/wd.geojson'))['features']))"` → a few hundred features (the sandbox proxy allows query.wikidata.org; if it does not, record that and rely on the workflow_dispatch after merge).

- [ ] **Step 3: `is_landmark` from the boost** — replace the `.update({"importance": 1})` call with `.update({"importance": 1, "is_landmark": True})` and drop the `.gt("importance", 1)` filter (a row can already be importance 1 and still need the flag); keep `.filter("source_ids->>wd", "neq", None).eq("is_admin", False)`. Add a second, tolerant call path: if the update fails with a message containing `is_landmark` (column missing because 00579 is not applied yet), retry with `{"importance": 1}` only and log `[wikidata-boost] is_landmark column missing (00579 not applied) — importance only`.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-pois/download_wikidata.py scripts/sync-pois/merge_and_upsert.py scripts/sync-pois/test_wikidata_query.py
git commit -m "fix(sync-pois): Wikidata SPARQL IN-list was space-separated (HTTP 400 on every run); flag landmarks"
```

---

### Task 10: Full rehearsal, repo checks, push, draft PR

- [ ] **Step 1: Fresh rehearsal from zero** — drop and recreate `poi_rehearsal`, load the scaffold, apply 00579 → 00580 → 00581 in order with `-v ON_ERROR_STOP=1`, run `tests.sql`; then apply the three migrations a **second time** (idempotence) and run `tests.sql` again. Expected: `SELECT count(*) FROM _t_fail` = 0 both times; the second apply prints only "already patched / skip" notices.

- [ ] **Step 2: Prod read-only dry checks with the MCP** (no DDL): confirm the three patch targets still appear exactly once in the live bodies (`position(c_t IN pg_get_functiondef(...))`), that `map_category_to_tricigo` md5 is still `2ef5ae47ff6e2c349f9884b2f6735d58`, and count the rows each cleanup statement would touch (Swedish descriptors, CUPET, duplicate pairs) — paste the counts into the PR body.

- [ ] **Step 3: Repo checks** — `pnpm check-types` (10/10), `pnpm --filter @tricigo/utils test`, `pnpm --filter @tricigo/api test`, `pnpm check:poi-taxonomy`, `pnpm check:i18n`, `pnpm lint` (client 66 warnings/0 errors baseline). `git checkout HEAD -- pnpm-lock.yaml` if `pnpm install` touched it.

- [ ] **Step 4: Migration numbering pre-flight** (again, right before pushing): `git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3` must still end at `00577`, and the open PRs (GitHub MCP `list_pull_requests` + `pull_request_read get_files`) must not carry 00579–00581. If they do, `git mv` to the next free numbers and update the file references inside `scripts/check-poi-taxonomy.mjs` and the comments.

- [ ] **Step 5: Push + draft PR** on `claude/poi-quality-ocsopo` (`git push -u origin claude/poi-quality-ocsopo`, retry with backoff on network errors). PR body: the spec link, the prod evidence table, the rehearsal log (test counts, second-apply notices), the read-only prod counts from Step 2, and the standing line **"Migraciones 00579–00581 NO aplicadas a prod (MCP guard); nada en las apps depende de ellas todavía — search_pois_smart sigue intacta; aplicar en orden 00579 → 00580 → 00581 con autorización explícita."** Then subscribe to PR activity and end the turn.

---

## Self-review against the spec (§4 only — §5–§7 are PR-2/3/4)

| Spec item | Task |
|---|---|
| 4.1 fix admin writers | 1 |
| 4.2 columns + CHECK | 3 (+ validation in 7) |
| 4.3 cleaner | 2 |
| 4.4 aliases + seeds | 4 |
| 4.5 dictionary | 5 |
| 4.6 municipality/province | 6 |
| 4.7 cleanup + merge + brand | 7 |
| 4.8 taxonomy 24 + CI check | 7 (SQL/keywords/import) + 8 (code) |
| 4.9 Wikidata | 9 |
| 4.10 freshness | no DDL needed — `synced_at` already exists; the 90-day rule is ranking (PR-2) + admin (PR-4) |

Type/name consistency: `poi_taxonomy()`, `_poi_clean_name`, `_poi_bare_name`, `_poi_title_case`, `_poi_admin_area`, `_poi_search_names_rebuild`, `tg_cuba_pois_display_name`, `tg_cuba_pois_admin_area`, `cuba_poi_aliases(kind, source)`, `poi_search_names(kind ∈ display|bare|alias|brand)` are used with the same names in every task above.
