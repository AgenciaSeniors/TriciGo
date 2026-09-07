# POI quality — PR-2 (search v2 + learning from picks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the POI search ranking with a dictionary-driven, alias-aware, landmark/pick/staleness-scored `search_pois_smart` v2 (spec §5.1), prove it on the real prod rows with a 60-query suite (§5.2), and start learning from what riders actually pick: a `record_poi_pick` RPC, a rides trigger that credits the POI a real ride went to or queues its name for import, and a cron-driven drain mode of the `import-mapbox-poi` Edge Function (§5.3).

**Architecture:** Two migrations. `00583` swaps `search_pois_smart` (DROP + CREATE: three columns are added to the return type, which `CREATE OR REPLACE` cannot do — 42P13) and patches `lookup_nearest_poi_ranked` in place so the reverse-geocode label uses `display_name`. `00584` adds `poi_import_queue`, `record_poi_pick`, `bump_poi_pick`, `find_nearby_poi_match` v2 (alias/display aware), the `tg_rides_learn_poi_picks` trigger and a `cron_http_post` job that only fires when the queue has work. The Edge Function gains a service-role `{ "drain": N }` mode; its state machine is a pure `_shared` module with vitest. Every SQL piece is rehearsed on the sandbox's local Postgres 16 (fixture DB via `supabase/tests/poi/run.sh`, and the 19,939-row real export in DB `poi_real`) and **executed**, not just created. Nothing is applied to prod from the sandbox (MCP guard).

**Tech Stack:** Postgres 16 / PostGIS / pg_trgm / unaccent (Supabase), plpgsql, pg_cron + pg_net via `cron_http_post`, Deno Edge Function (`import-mapbox-poi`), vitest (`packages/api` runs `supabase/functions/_shared/**/*.test.ts`), `@tricigo/utils` vitest.

**Branch:** fresh from `origin/master` (`eb52bbf`, which contains 00579–00581): `claude/poi-search-v2-ocsopo`. Migration pre-flight (2026-09-06 11:40 UTC): master ends at `00581`; open PRs hold `00569` (#965), `00578` (#989), `00582` (#991); #840/#842/#843 carry none → this PR takes **00583 + 00584**. Re-run the pre-flight before pushing (CLAUDE.md § "Pre-flight para elegir número de migración").

**Prod facts the code depends on (verified read-only 2026-09-06):**
- Live `search_pois_smart(query text, lat double precision DEFAULT 23.1136, lng double precision DEFAULT '-82.3666'::numeric, radius_m integer DEFAULT 50000, max_results integer DEFAULT 10)` — plpgsql STABLE, 4,924 chars, md5 `72be440035deeaff062bba120a333658`, 18 output columns, ACL `{=X, postgres, service_role, anon, authenticated}`, 0 dependents. Body captured verbatim in Task 0 (scaffold) so the local DROP behaves like prod.
- Live `lookup_nearest_poi_ranked(p_lat, p_lng, p_radius_m DEFAULT 30)` — LANGUAGE sql, 2,914 chars, md5 `0cbc8cab5a14df4d5a2583c52277f47e`; its SELECT list starts with the 3-line literal `SELECT\n    p.name,\n    p.category,` which appears **once** (the ORDER BY uses `p.is_admin DESC,\n    p.confidence`).
- Live `find_nearby_poi_match(p_name, p_lat, p_lng, p_radius_m DEFAULT 50)` — plpgsql STABLE, 723 chars, md5 `1cd4989ffe20bb7842cac5d3ef411823`, ACL `{postgres, service_role, authenticated}`; matches `similarity(cp.name_normalized, v_norm) >= 0.6` only (raw name, no alias, no display_name, does not exclude merged rows).
- `check_rate_limit(p_key text, p_max_requests int, p_window_seconds int) RETURNS TABLE(allowed, current_count, reset_at)` (00105); `cron_http_post(p_jobname, url, headers, body, timeout_milliseconds)` (00506, SECURITY DEFINER, logs to `cron_http_calls`); `get_service_role_key()` ACL `{postgres, service_role}`; `_ride_address_is_placeholder(text)` IMMUTABLE (00546).
- `rides` columns used: `id uuid, pickup_address, dropoff_address, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_location, dropoff_location` (the BEFORE trigger `rides_sync_coords` fills lat/lng before AFTER triggers run). 13 non-internal triggers exist on `rides`; none named `trg_rides_learn_poi_picks`.
- After 00579: `poi_search_names(poi_id, norm, kind ∈ display|bare|alias|brand, weight)` with `idx_poi_search_names_norm_trgm` (GIN `gin_trgm_ops`) and `idx_poi_search_names_norm` (btree `text_pattern_ops`); `cuba_poi_aliases(id, poi_id, alias, alias_norm, kind, source, created_by, created_at)`; `cuba_pois` gains `display_name, name_override, category_override, is_landmark, pick_count, last_picked_at, merged_into, footprint_radius_m`; 00581 merges 806 rows (`merged_into` set, `is_active=false`).
- Real data (poi_real, 19,939 active rows): transport stops are `category='public_transport'` with `subcategory ∈ {platform: 549, stop_position: 345}`; **40** stops carry the exact display name of a non-transport POI ≤400 m away ("Clínica Central Cira García" 17 m, "Policlínico Oeste" 10 m, "Parque Santos Suarez" 21 m…). Prod `synced_at`: 1,040 non-admin rows older than 90 days (of 19,554); the 385 admin rows all say 2026-05-03 (never re-synced) → the staleness penalty must exclude `is_admin`.
- Client: `searchPoisSupabase` (`packages/utils/src/geo.ts:3970`) POSTs `{query, lat, lng, radius_m: 30000, max_results}` and maps `name/address/municipality/province/latitude/longitude/subcategory/category/matched_category/match_reason/tricigo_category`; extra columns are ignored. `lat: null` is sent when there is no proximity (and the live RPC returns no rows in that case — kept).

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/00583_search_pois_smart_v2.sql` | in-place patch of `lookup_nearest_poi_ranked` (label = display_name) · DROP + CREATE `search_pois_smart` v2 · grants · comment |
| `supabase/migrations/00584_poi_pick_learning.sql` | `poi_import_queue` (+RLS admin read) · `bump_poi_pick` · `record_poi_pick` · `find_nearby_poi_match` v2 · `_poi_leading_venue_name` · `tg_rides_learn_poi_picks` + trigger · `drain_poi_import_queue_tick` + cron |
| `supabase/tests/poi/scaffold.sql` | **append** the PR-2 shims: `rides`, `rate_limits` + live `check_rate_limit`, `cron`/`net` stubs, `cron_http_calls` + live `cron_http_post`, `get_service_role_key` stub, live `_ride_address_is_placeholder`, live `lookup_nearest_poi_ranked`, live `search_pois_smart` (v1) also as `search_pois_smart_v1`, 6 fixture rows |
| `supabase/tests/poi/tests.sql` | **append** T8 (search v2) and T9 (picks, trigger, queue, cron tick) |
| `supabase/tests/poi/search_suite.sql` | 60 real Cuban queries + 20 no-change controls, runnable against any function name (`-v fn=…`) on the real-data DB |
| `supabase/tests/poi/run.sh` | apply 00583/00584 too, run the new tests |
| `supabase/functions/_shared/poi-import-queue.ts` + `.test.ts` | pure drain state machine (`nextQueueState`) with vitest |
| `supabase/functions/import-mapbox-poi/index.ts` | service-role `{ "drain": N }` mode; `types` param on `queryMapbox`; `feature_type` on the feature type |
| `packages/utils/src/geo.ts`, `packages/utils/src/__tests__/geo.test.ts` | remove `importPoiFromSearch` (dead client path) |
| `apps/client/src/components/AddressSearchInput.tsx`, `apps/client/src/components/WebAddressInput.tsx`, `apps/web/src/components/AddressAutocomplete.tsx` | remove the fire-and-forget call |
| `CLAUDE.md` | POI section: search v2 + learning rows |

---

### Task 0: Scaffold shims for PR-2 (rides, rate limits, cron/net stubs, live bodies, fixtures)

**Files:**
- Modify: `supabase/tests/poi/scaffold.sql` (append at the end)
- Modify: `supabase/tests/poi/run.sh`

- [ ] **Step 1: Make sure the local Postgres is up**

Run:
```bash
sudo -u pgtest bash -c "setsid nohup /usr/lib/postgresql/16/bin/postgres -D /home/pgtest/data -p 5433 -k /home/pgtest > /home/pgtest/pg.log 2>&1 < /dev/null &"; sleep 3
PGHOST=/home/pgtest PGPORT=5433 PGUSER=pgtest pg_isready
```
Expected: `/home/pgtest:5433 - accepting connections`

- [ ] **Step 2: Append the shims to `scaffold.sql`**

Append (the two live bodies marked LIVE are pasted **verbatim** from `pg_get_functiondef` captured 2026-09-06; do not retype them from a migration):

```sql
-- ============================================================================
-- PR-2 shims (00583 / 00584): rides, rate limiter, cron + net stubs, the live
-- bodies 00583 patches or drops, and the fixture rows T8/T9 need.
-- ============================================================================
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  status text NOT NULL DEFAULT 'searching',
  pickup_address text, dropoff_address text,
  pickup_lat double precision, pickup_lng double precision,
  dropoff_lat double precision, dropoff_lng double precision,
  pickup_location geography(Point,4326), dropoff_location geography(Point,4326),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 00105 (live): rate limiter
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key TEXT, p_max_requests INTEGER, p_window_seconds INTEGER)
RETURNS TABLE(allowed BOOLEAN, current_count INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_window_start TIMESTAMPTZ; v_count INTEGER;
BEGIN
  v_window_start := to_timestamp(floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds);
  INSERT INTO rate_limits (key, window_start, count) VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
  RETURNING rate_limits.count INTO v_count;
  RETURN QUERY SELECT v_count <= p_max_requests, v_count, v_window_start + make_interval(secs => p_window_seconds);
END $$;

-- pg_cron / pg_net stand-ins: schedule() records, http_post() records.
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_jobname, p_schedule, p_command) RETURNING jobid $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text) RETURNS boolean LANGUAGE sql AS $$
  DELETE FROM cron.job WHERE jobname = p_jobname RETURNING true $$;
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._stub_requests (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_ms int, created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net._stub_requests (url, headers, body, timeout_ms) VALUES (url, headers, body, timeout_milliseconds) RETURNING id $$;
CREATE TABLE public.cron_http_calls (request_id bigint PRIMARY KEY, jobname text NOT NULL, called_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cron_http_expectations (jobname text PRIMARY KEY, ok_statuses int[] NOT NULL, note text);
-- 00506 (live shape): fire first, log second.
CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'net', 'pg_catalog' AS $function$
DECLARE v_url text := url; v_headers jsonb := headers; v_body jsonb := body; v_timeout integer := timeout_milliseconds; v_id bigint;
BEGIN
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body, timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname) VALUES (v_id, p_jobname);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cron_http_post: log failed for %: %', p_jobname, SQLERRM;
  END;
  RETURN v_id;
END $function$;
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $$ SELECT 'sb_secret_local_stub' $$;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;

-- 00546 (live): placeholder detector
CREATE OR REPLACE FUNCTION public._ride_address_is_placeholder(p_addr text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_catalog' AS $function$
  SELECT
    p_addr IS NULL
    OR btrim(p_addr) = ''
    OR p_addr ~ '^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$'
    OR p_addr = 'Ubicación seleccionada en el mapa'
    OR p_addr LIKE 'Cerca de %'
    OR btrim(p_addr) IN (
         'Detectando dirección...', 'Detecting address...', 'Detectando endereço...',
         'Detectando dirección…', 'Detecting address…', 'Detectando endereço…',
         'Ubicación actual', 'Current location', 'Localização atual'
       );
$function$;

-- LIVE 2026-09-06 (md5 0cbc8cab5a14df4d5a2583c52277f47e): lookup_nearest_poi_ranked
<paste pg_get_functiondef output verbatim — the 00570 body>

-- LIVE 2026-09-06 (md5 72be440035deeaff062bba120a333658): search_pois_smart v1, twice —
-- the real name (00583 drops it) and _v1 (A/B control for the suite).
<paste pg_get_functiondef output verbatim>
<paste the same body again with the name public.search_pois_smart_v1>

-- ---------------------------------------------------------- PR-2 fixtures --
-- (inserted with the same column list as the existing fixture INSERT above)
INSERT INTO public.cuba_pois (name, category, subcategory, tricigo_category, location, source, confidence, source_ids, province, municipality) VALUES
  -- a bus platform carrying the hotel's name 15 m from the hotel fixture (T8: stop demotion)
  ('Hotel Habana Libre', 'public_transport', 'platform', 'transport', ST_SetSRID(ST_MakePoint(-82.38341, 23.14005), 4326)::geography, 'osm', 0.7, '{"osm": "node/910001"}', 'La Habana', 'Plaza de la Revolución'),
  -- second "Parque Central" 600 m away, non-landmark (T8: landmark boost)
  ('Parque Central', 'leisure', 'park', 'park', ST_SetSRID(ST_MakePoint(-82.3560, 23.1400), 4326)::geography, 'osm', 0.7, '{"osm": "node/910002"}', 'La Habana', 'Centro Habana'),
  -- two "Cafetería La Rampa": 120 m apart (collapse) and one 2 km away (kept)
  ('Cafetería La Rampa', 'amenity', 'cafe', 'cafe', ST_SetSRID(ST_MakePoint(-82.3830, 23.1390), 4326)::geography, 'overture', 0.6, '{"overture": "r1"}', 'La Habana', 'Plaza de la Revolución'),
  ('Cafeteria La Rampa', 'amenity', 'cafe', 'cafe', ST_SetSRID(ST_MakePoint(-82.3841, 23.1392), 4326)::geography, 'foursquare', 0.6, '{"fsq": "r2"}', 'La Habana', 'Plaza de la Revolución'),
  ('Cafetería La Rampa', 'amenity', 'cafe', 'cafe', ST_SetSRID(ST_MakePoint(-82.4010, 23.1300), 4326)::geography, 'overture', 0.6, '{"overture": "r3"}', 'La Habana', 'Playa'),
  -- stale vs fresh twins (T8: staleness penalty)
  ('Panadería Prueba Fresca', 'shop', 'bakery', 'shop', ST_SetSRID(ST_MakePoint(-82.3700, 23.1350), 4326)::geography, 'overture', 0.6, '{"overture": "s1"}', 'La Habana', 'Plaza de la Revolución'),
  ('Panadería Prueba Vieja', 'shop', 'bakery', 'shop', ST_SetSRID(ST_MakePoint(-82.3702, 23.1352), 4326)::geography, 'overture', 0.6, '{"overture": "s2"}', 'La Habana', 'Plaza de la Revolución');
UPDATE public.cuba_pois SET synced_at = now() - interval '200 days' WHERE name = 'Panadería Prueba Vieja';
UPDATE public.cuba_pois SET synced_at = now() - interval '3 days'   WHERE name = 'Panadería Prueba Fresca';
```

Get the two LIVE bodies with the MCP (read-only) and paste them:
```sql
SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('lookup_nearest_poi_ranked','search_pois_smart');
```
Verify fidelity after pasting (must print `t` for both):
```bash
PGHOST=/home/pgtest PGPORT=5433 PGUSER=pgtest psql -d poi_rehearsal -Atc "SELECT proname, md5(prosrc) IN ('0cbc8cab5a14df4d5a2583c52277f47e','72be440035deeaff062bba120a333658') FROM pg_proc WHERE proname IN ('lookup_nearest_poi_ranked','search_pois_smart','search_pois_smart_v1');"
```
(`prosrc` is the text between `AS $function$` and `$function$` — pasting the full `CREATE OR REPLACE FUNCTION …` statement keeps it byte-identical.)

- [ ] **Step 3: Extend `run.sh`**

Change `MAX="${MAX:-00581}"` → `MAX="${MAX:-00584}"` and `for m in 00579 00580 00581; do` → `for m in 00579 00580 00581 00583 00584; do` (00582 belongs to #991's streets harness and is not part of this DB).

- [ ] **Step 4: Run the harness — the scaffold must still load and 00579–00581 must pass**

Run: `supabase/tests/poi/run.sh 2>&1 | tail -5`
Expected: `failures` = `0` (137 assertions; 00583/00584 do not exist yet and are skipped by the `continue`).

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/poi/scaffold.sql supabase/tests/poi/run.sh
git commit -m "test(poi): PR-2 scaffold — rides, rate limiter, cron/net stubs, live search bodies, fixtures"
```

---

### Task 1: 00583 — `lookup_nearest_poi_ranked` label patch + `search_pois_smart` v2

**Files:**
- Create: `supabase/migrations/00583_search_pois_smart_v2.sql`
- Test: `supabase/tests/poi/tests.sql` (T8)

- [ ] **Step 1: Write the failing tests (append to `tests.sql`)**

```sql
-- T8: search_pois_smart v2 (00583)
DO $$
DECLARE v_hotel bigint; v_stop bigint; v_pc_lm bigint; v_pc_other bigint; v_r record; v_n int;
BEGIN
  SELECT id INTO v_hotel FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category <> 'public_transport' AND is_active LIMIT 1;
  SELECT id INTO v_stop  FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category = 'public_transport' LIMIT 1;

  -- T8a: return shape has the 3 new columns and name = display_name
  PERFORM _t('T8a 21 output columns', (SELECT count(*) FROM information_schema.columns WHERE 1=0) IS NOT NULL AND
    (SELECT pg_get_function_result('public.search_pois_smart(text,double precision,double precision,integer,integer)'::regprocedure)) LIKE '%matched_alias text, display_name text, is_landmark boolean)');
  SELECT * INTO v_r FROM search_pois_smart('capitolio', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8b exact bare match is first and named by display_name', v_r.name = 'El Capitolio' AND v_r.display_name = 'El Capitolio' AND v_r.match_reason = 'name_exact');

  -- T8c: alias match ("La Benéfica" → Hospital Miguel Enríquez) with matched_alias filled
  SELECT * INTO v_r FROM search_pois_smart('la benefica', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8c alias resolves with matched_alias', v_r.name LIKE 'Hospital Miguel Enr%' AND v_r.matched_alias IS NOT NULL);

  -- T8d: the stop that shadows the hotel is not returned for "habana libre"…
  SELECT count(*) INTO v_n FROM search_pois_smart('habana libre', 23.1357, -82.3666, 30000, 10) s WHERE s.id = v_stop;
  PERFORM _t('T8d shadow stop demoted out', v_n = 0);
  SELECT * INTO v_r FROM search_pois_smart('habana libre', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8e bare query hits the hotel first', v_r.id = v_hotel);
  -- …but comes back with transport intent
  SELECT count(*) INTO v_n FROM search_pois_smart('parada habana libre', 23.1357, -82.3666, 30000, 10) s WHERE s.id = v_stop;
  PERFORM _t('T8f transport intent restores the stop', v_n = 1);

  -- T8g: landmark boost — two "Parque Central", the landmark one first even if farther
  SELECT id INTO v_pc_other FROM cuba_pois WHERE name = 'Parque Central' AND municipality = 'Centro Habana' LIMIT 1;
  SELECT id INTO v_pc_lm    FROM cuba_pois WHERE name = 'Parque Central' AND id <> v_pc_other AND is_active LIMIT 1;
  UPDATE cuba_pois SET is_landmark = true WHERE id = v_pc_lm;
  SELECT * INTO v_r FROM search_pois_smart('parque central', 23.1400, -82.3560, 30000, 5) LIMIT 1;  -- origin ON the non-landmark twin
  PERFORM _t('T8g landmark outranks the closer twin', v_r.id = v_pc_lm AND v_r.is_landmark);

  -- T8h: pick_count boost — undo landmark, give the twin 20 picks
  UPDATE cuba_pois SET is_landmark = false WHERE id = v_pc_lm;
  UPDATE cuba_pois SET pick_count = 20 WHERE id = v_pc_other;
  SELECT * INTO v_r FROM search_pois_smart('parque central', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8h picks outrank the plain twin', v_r.id = v_pc_other);
  UPDATE cuba_pois SET pick_count = 0 WHERE id = v_pc_other;

  -- T8i: merged rows never come back (00581 merged the Coppelia duplicate)
  SELECT count(*) INTO v_n FROM search_pois_smart('coppelia', 23.1357, -82.3666, 30000, 10) s
   WHERE EXISTS (SELECT 1 FROM cuba_pois m WHERE m.id = s.id AND m.merged_into IS NOT NULL);
  PERFORM _t('T8i merged rows excluded', v_n = 0);

  -- T8j: 300 m collapse keeps one of the two near "Cafetería La Rampa" and the far one
  SELECT count(*) INTO v_n FROM search_pois_smart('cafeteria la rampa', 23.1357, -82.3666, 30000, 10);
  PERFORM _t('T8j same-name rows within 300 m collapse', v_n = 2);

  -- T8k: staleness — fresh twin before the 200-day-old one
  SELECT * INTO v_r FROM search_pois_smart('panaderia prueba', 23.1352, -82.3702, 30000, 5) LIMIT 1;  -- origin on the OLD one
  PERFORM _t('T8k stale row sinks below the fresh twin', v_r.name = 'Panadería Prueba Fresca');

  -- T8l: no proximity → no rows (live behaviour kept)
  SELECT count(*) INTO v_n FROM search_pois_smart('capitolio', NULL, NULL, 30000, 5);
  PERFORM _t('T8l null proximity returns nothing', v_n = 0);

  -- T8m: category keyword → category_only rows, generic-name placeholder sinks
  SELECT count(*) INTO v_n FROM search_pois_smart('hospital', 23.1357, -82.3666, 30000, 10) s WHERE s.match_reason = 'category_only';
  PERFORM _t('T8m keyword query returns category matches', v_n >= 2);
  SELECT * INTO v_r FROM search_pois_smart('hospital', 23.1357, -82.3666, 30000, 10) LIMIT 1;
  PERFORM _t('T8n generic placeholder is not first', lower(v_r.name) <> 'hospital');

  -- T8o: tricigo_category is the EFFECTIVE category (override wins — the CUPET rows)
  SELECT * INTO v_r FROM search_pois_smart('cupet santa catalina', 23.1357, -82.3666, 30000, 5) LIMIT 1;
  PERFORM _t('T8o effective category returned', v_r.tricigo_category = 'gas_station');

  -- T8p: reverse geocode label uses display_name (fixture 'La Roca, La Habana, Cuba' → 'La Roca')
  SELECT l.name INTO v_r FROM cuba_pois p, LATERAL lookup_nearest_poi_ranked(ST_Y(p.location::geometry), ST_X(p.location::geometry), 30) l
   WHERE p.name = 'La Roca, La Habana, Cuba' LIMIT 1;
  PERFORM _t('T8p reverse geocode returns display_name', v_r.name = 'La Roca');
END $$;
```

- [ ] **Step 2: Run the harness to see T8 fail**

Run: `supabase/tests/poi/run.sh 2>&1 | grep -E "FAIL|ERROR|failures" | head`
Expected: T8a fails (`pg_get_function_result` still ends in `match_reason text)`), T8c/T8d… fail or error (`column "matched_alias" does not exist`).

- [ ] **Step 3: Write `00583_search_pois_smart_v2.sql`**

```sql
-- ============================================================================
-- 00583 — search_pois_smart v2 + reverse-geocode label from display_name
--
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §5.1
-- Plan: docs/superpowers/plans/2026-09-06-poi-quality-pr2-search.md
-- Depends on 00579 (poi_search_names, cuba_poi_aliases, display_name,
-- pick_count, is_landmark, merged_into, category_override) and 00581.
--
-- 1. lookup_nearest_poi_ranked: the label is COALESCE(display_name, name).
--    Output only — the 00570 footprint ranking stays byte-identical (in-place
--    patch of the live body; the 3-line target literal appears once).
-- 2. search_pois_smart v2: candidates come from the precomputed dictionary
--    (display / bare / alias / brand, trgm + prefix indexes) instead of a
--    per-row ILIKE/similarity scan of every POI in the radius; ranking =
--    match quality → landmark/admin bonus → stop demotion → rider picks →
--    staleness → confidence → distance → contact. Return shape = the 18 live
--    columns + matched_alias, display_name, is_landmark. Adding columns
--    changes the return type (42P13 under CREATE OR REPLACE) → DROP first;
--    both statements run in this transaction and PostgREST reloads its
--    schema cache on DDL. `name` now carries the cleaned display_name so the
--    installed apps show clean names without a rebuild; `tricigo_category`
--    is the EFFECTIVE category (category_override wins).
-- ============================================================================
SET statement_timeout = 0;

-- 1. Reverse geocode label ------------------------------------------------
DO $patch$
DECLARE v_src text; v_n int;
  c_t CONSTANT text := E'SELECT\n    p.name,\n    p.category,';
  c_r CONSTANT text := E'SELECT\n    COALESCE(p.display_name, p.name) AS name,\n    p.category,';
BEGIN
  SELECT pg_get_functiondef('public.lookup_nearest_poi_ranked(double precision,double precision,integer)'::regprocedure) INTO v_src;
  IF position('p.display_name' IN v_src) > 0 THEN
    RAISE NOTICE '00583: lookup_nearest_poi_ranked already patched'; RETURN;
  END IF;
  v_n := (length(v_src) - length(replace(v_src, c_t, ''))) / length(c_t);
  IF v_n <> 1 THEN RAISE EXCEPTION '00583: lookup_nearest_poi_ranked target literal found % times, expected 1', v_n; END IF;
  EXECUTE replace(v_src, c_t, c_r);
  RAISE NOTICE '00583: lookup_nearest_poi_ranked now returns display_name';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00583: lookup_nearest_poi_ranked absent; skipping';
END $patch$;

-- 2. search_pois_smart v2 -------------------------------------------------
DROP FUNCTION IF EXISTS public.search_pois_smart(text, double precision, double precision, integer, integer);

CREATE FUNCTION public.search_pois_smart(
  query        text,
  lat          double precision DEFAULT 23.1136,
  lng          double precision DEFAULT -82.3666,
  radius_m     integer          DEFAULT 50000,
  max_results  integer          DEFAULT 10
)
RETURNS TABLE(
  id bigint, name text, category text, subcategory text, tricigo_category text,
  address text, municipality text, province text, latitude double precision,
  longitude double precision, phone text, website text, source text,
  is_admin boolean, confidence real, distance_m double precision,
  matched_category text, match_reason text,
  matched_alias text, display_name text, is_landmark boolean
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_norm             TEXT;
  v_bare             TEXT;
  v_like             TEXT;
  v_category         TEXT;
  v_query_is_keyword BOOLEAN;
  v_tokens           TEXT[];
  v_token_count      INT;
  v_longest          TEXT;
  v_transport_intent BOOLEAN;
  v_origin           geography;
BEGIN
  v_norm := regexp_replace(lower(unaccent(trim(query))), '\s+', ' ', 'g');
  IF v_norm IS NULL OR length(v_norm) < 1 THEN RETURN; END IF;
  IF lat IS NULL OR lng IS NULL THEN RETURN; END IF;   -- live behaviour: no proximity → no rows
  v_like   := '%' || v_norm || '%';
  v_bare   := public._poi_bare_name(v_norm);
  v_origin := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;

  v_tokens := ARRAY(SELECT t FROM unnest(string_to_array(v_norm, ' ')) AS t WHERE length(t) >= 2);
  v_token_count := COALESCE(array_length(v_tokens, 1), 0);
  SELECT t INTO v_longest FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;

  SELECT k.tricigo_category INTO v_category
  FROM cuba_search_keywords k
  WHERE v_norm = k.keyword OR v_norm LIKE k.keyword || ' %'
  ORDER BY length(k.keyword) DESC
  LIMIT 1;
  SELECT EXISTS (SELECT 1 FROM cuba_search_keywords k WHERE k.keyword = v_norm) INTO v_query_is_keyword;

  -- The rider wants the stop itself ("parada", "P-12", "ruta 27", "terminal"…).
  v_transport_intent := v_norm ~ '\m(parada|terminal|guagua|omnibus|estacion|ruta|p-?\d{1,2}|a\d{2}|tren|ferry|aeropuerto|taxi|lancha)\M';

  RETURN QUERY
  WITH dict AS (
    -- Candidate gather: index-only on the precomputed dictionary (00579 §E).
    SELECT d.poi_id,
           MIN(CASE
                 WHEN d.norm = v_norm OR (d.kind = 'bare' AND d.norm = v_bare) THEN 0
                 WHEN d.norm LIKE v_norm || '%'                                THEN 1
                 WHEN d.norm LIKE v_like                                       THEN 2
                 WHEN similarity(d.norm, v_norm) > 0.3                         THEN 2.8
                 ELSE 9 END)::numeric AS drank,
           bool_or(d.kind IN ('alias', 'brand')
                   AND (d.norm = v_norm OR d.norm LIKE v_norm || '%' OR d.norm LIKE v_like)) AS via_alias
    FROM poi_search_names d
    WHERE d.norm LIKE v_norm || '%'
       OR d.norm LIKE v_like
       OR d.norm % v_norm
       OR (d.kind = 'bare' AND d.norm = v_bare)
       OR (v_token_count >= 2 AND d.norm LIKE '%' || v_longest || '%')
    GROUP BY d.poi_id
  ),
  cand AS (
    SELECT p.*, dict.drank, dict.via_alias
    FROM cuba_pois p
    JOIN dict ON dict.poi_id = p.id
    WHERE p.is_active AND p.merged_into IS NULL
      AND ST_DWithin(p.location, v_origin, radius_m)
    UNION ALL
    SELECT p.*, 9::numeric AS drank, false AS via_alias
    FROM cuba_pois p
    WHERE v_category IS NOT NULL
      AND p.is_active AND p.merged_into IS NULL
      AND COALESCE(p.category_override, p.tricigo_category) = v_category
      AND ST_DWithin(p.location, v_origin, radius_m)
      AND NOT EXISTS (SELECT 1 FROM dict WHERE dict.poi_id = p.id)
  ),
  scored AS (
    SELECT c.id, c.category, c.subcategory,
           COALESCE(c.category_override, c.tricigo_category) AS category_eff,
           COALESCE(c.display_name, c.name)                  AS disp,
           lower(unaccent(COALESCE(c.display_name, c.name))) AS disp_norm,
           COALESCE(c.address, '')                 AS address,
           COALESCE(c.municipality, c.city, '')    AS municipality,
           COALESCE(c.province, '')                AS province,
           ST_Y(c.location::geometry) AS latitude,
           ST_X(c.location::geometry) AS longitude,
           c.location,
           c.phone, c.website, c.source, c.is_admin, c.confidence,
           COALESCE(c.is_landmark, false) AS is_landmark,
           c.pick_count, c.synced_at, c.via_alias,
           ST_Distance(c.location, v_origin) AS distance_m,
           CASE
             WHEN c.drank <= 2.8 THEN c.drank
             WHEN v_token_count > 0 AND NOT EXISTS (
                    SELECT 1 FROM unnest(v_tokens) AS t
                    WHERE NOT (c.name_normalized LIKE '%' || t || '%'
                            OR lower(unaccent(COALESCE(c.display_name, ''))) LIKE '%' || t || '%'
                            OR COALESCE(c.address_normalized, '') LIKE '%' || t || '%'
                            OR lower(unaccent(COALESCE(c.municipality, ''))) LIKE '%' || t || '%'))
               THEN 2.5::numeric
             WHEN v_category IS NOT NULL AND COALESCE(c.category_override, c.tricigo_category) = v_category THEN 3::numeric
             ELSE 9::numeric
           END AS rank_quality,
           CASE WHEN v_query_is_keyword
                 AND (c.name_normalized = v_norm OR lower(unaccent(COALESCE(c.display_name, ''))) = v_norm)
                THEN 1 ELSE 0 END AS is_generic,
           (c.category = 'public_transport'
            AND COALESCE(c.subcategory, '') IN ('platform', 'stop_position', 'stop', 'bus_stop')) AS is_stop
    FROM cand c
    WHERE c.category NOT IN ('highway', 'landuse', 'waterway', 'building', 'natural', 'barrier', 'place', 'man_made', 'railway')
      AND NOT (c.category = 'amenity' AND c.subcategory IN ('telephone', 'drinking_water'))
  ),
  filtered AS (
    SELECT s.*,
      ( s.rank_quality * 1000
        + s.is_generic * 5000
        + CASE WHEN s.is_landmark THEN -120 WHEN s.is_admin THEN -60 ELSE 0 END
        + CASE WHEN s.is_stop AND NOT v_transport_intent THEN 700 ELSE 0 END
        - LEAST(s.pick_count, 20) * 15
        + CASE WHEN NOT s.is_admin AND s.synced_at IS NOT NULL
                    AND s.synced_at < now() - interval '90 days' THEN 150 ELSE 0 END
        + (1 - COALESCE(s.confidence, 0.5)) * 30
        + LEAST(s.distance_m / 1000.0, 30)
        + CASE WHEN s.phone IS NOT NULL OR s.website IS NOT NULL THEN 0 ELSE 8 END
      )::numeric AS score
    FROM scored s
    WHERE s.rank_quality < 9
      -- A stop that carries the exact name of a real place ≤400 m away is that
      -- place's shadow ("Clínica Cira García" platform 17 m from the clinic):
      -- drop it unless the rider asked for the stop.
      AND NOT (s.is_stop AND NOT v_transport_intent AND EXISTS (
            SELECT 1 FROM cuba_pois o
            WHERE o.is_active AND o.merged_into IS NULL AND o.id <> s.id
              AND COALESCE(o.category_override, o.tricigo_category) <> 'transport'
              AND lower(unaccent(COALESCE(o.display_name, o.name))) = s.disp_norm
              AND ST_DWithin(o.location, s.location, 400)))
  ),
  collapsed AS (
    -- Same display name within 300 m: keep the best-scored (ties: lower id).
    SELECT f.* FROM filtered f
    WHERE NOT EXISTS (
      SELECT 1 FROM filtered b
      WHERE b.disp_norm = f.disp_norm AND b.id <> f.id
        AND ST_DWithin(b.location, f.location, 300)
        AND (b.score < f.score OR (b.score = f.score AND b.id < f.id)))
  )
  SELECT c.id, c.disp AS name, c.category, c.subcategory, c.category_eff AS tricigo_category,
         c.address, c.municipality, c.province, c.latitude, c.longitude,
         c.phone, c.website, c.source, c.is_admin, c.confidence, c.distance_m,
         v_category AS matched_category,
         CASE c.rank_quality
           WHEN 0   THEN 'name_exact'
           WHEN 1   THEN 'name_prefix'
           WHEN 2   THEN 'name_substring'
           WHEN 2.5 THEN 'name_address_tokens'
           WHEN 2.8 THEN 'name_fuzzy'
           WHEN 3   THEN 'category_only'
           ELSE 'unknown' END AS match_reason,
         CASE WHEN c.via_alias THEN (
           SELECT a.alias FROM cuba_poi_aliases a
           WHERE a.poi_id = c.id
             AND (a.alias_norm = v_norm OR a.alias_norm LIKE v_norm || '%' OR a.alias_norm LIKE v_like)
           ORDER BY length(a.alias), a.id LIMIT 1) END AS matched_alias,
         c.disp AS display_name,
         c.is_landmark
  FROM collapsed c
  ORDER BY c.score ASC, c.id ASC
  LIMIT max_results;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) IS
  '00583 v2: candidates from poi_search_names (display/bare/alias/brand); rank = match tier, landmark/admin bonus, stop shadow demotion (unless transport intent), rider picks, staleness (>90 d, non-admin), confidence, distance, contact; same-name rows within 300 m collapse; merged rows excluded. name = display_name; tricigo_category = effective (override wins).';

RESET statement_timeout;
```

- [ ] **Step 4: Run the harness twice (idempotency) and see T8 pass**

Run: `supabase/tests/poi/run.sh 2>&1 | grep -E "FAIL|ERROR|already patched|failures|^ +[0-9]+$"`
Expected: second pass prints `00583: lookup_nearest_poi_ranked already patched`; `failures` = `0`.

If T8g fails with the landmark second: the twin sits **at** the origin (distance 0 → +0) while the landmark is ~600 m away (+0.6); the -120 bonus must win. If it doesn't, the fixture coordinates are wrong, not the weights — check with `SELECT id, name, is_landmark, distance_m FROM search_pois_smart('parque central', 23.1400, -82.3560, 30000, 5)`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00583_search_pois_smart_v2.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): search_pois_smart v2 over the search dictionary; reverse-geocode label from display_name (00583)"
```

---

### Task 2: Real-data suite — 60 queries + 20 controls + latency, v1 vs v2

**Files:**
- Create: `supabase/tests/poi/search_suite.sql`
- Uses the scratchpad real-data DB `poi_real` (`run_real.sh`, 19,939 active rows). It is NOT rebuilt by `run.sh`.

- [ ] **Step 1: Bring `poi_real` to 00583**

The DB lacks `search_pois_smart`, `lookup_nearest_poi_ranked`, `cuba_search_keywords` rows? Check and load what is missing from the scaffold (only the shim section and the two live bodies — do NOT reload fixtures into the real DB):
```bash
export PGHOST=/home/pgtest PGPORT=5433 PGUSER=pgtest
psql -d poi_real -Atc "SELECT string_agg(proname, ',') FROM pg_proc WHERE proname IN ('search_pois_smart','search_pois_smart_v1','lookup_nearest_poi_ranked','_ride_address_is_placeholder');"
psql -d poi_real -Atc "SELECT count(*) FROM cuba_search_keywords;"
```
If keywords are 0, load them from prod read-only (`SELECT keyword, tricigo_category FROM cuba_search_keywords` via MCP → INSERT). Then extract the shim block of `scaffold.sql` (from the line `-- PR-2 shims` to the line before `-- PR-2 fixtures`) into `/home/pgtest/shims_pr2.sql` and apply it, then apply 00583:
```bash
awk '/PR-2 shims/{f=1} /PR-2 fixtures/{f=0} f' supabase/tests/poi/scaffold.sql > /home/pgtest/shims_pr2.sql
psql -d poi_real -v ON_ERROR_STOP=1 -q -f /home/pgtest/shims_pr2.sql
psql -d poi_real -v ON_ERROR_STOP=1 -q -f supabase/migrations/00583_search_pois_smart_v2.sql
```
Expected: no errors; `search_pois_smart` (v2) and `search_pois_smart_v1` both exist.

- [ ] **Step 2: Write `search_suite.sql`**

```sql
-- supabase/tests/poi/search_suite.sql — 60 real Cuban queries with the expected
-- top-1 (regex on lower(unaccent(name))) + 20 no-change controls (top-1 id must
-- equal search_pois_smart_v1's). Run against the REAL-DATA database:
--   psql -d poi_real -v fn=search_pois_smart -f supabase/tests/poi/search_suite.sql
-- The same file, with -v fn=<candidate>, is the A/B pattern of CLAUDE.md
-- ("candidata con otro nombre"). Expectations are display names AFTER 00579.
\set fn :fn
\pset format aligned
WITH cases(n, q, lat, lng, expect) AS (VALUES
  -- Havana landmarks by name / bare name (origin: Capitolio 23.1357,-82.3666)
  ( 1, 'capitolio',                23.1357, -82.3666, '^(el )?capitolio'),
  ( 2, 'hotel nacional',           23.1357, -82.3666, '^hotel nacional de cuba'),
  ( 3, 'habana libre',             23.1357, -82.3666, '^hotel habana libre'),
  ( 4, 'coppelia',                 23.1357, -82.3666, '^coppelia'),
  ( 5, 'bodeguita',                23.1357, -82.3666, 'bodeguita del medio'),
  ( 6, 'floridita',                23.1357, -82.3666, '^(el )?floridita'),
  ( 7, 'fabrica de arte',          23.1357, -82.3666, 'fabrica de arte'),
  ( 8, 'fac',                      23.1357, -82.3666, 'fabrica de arte'),
  ( 9, 'ameijeiras',               23.1357, -82.3666, '^hospital hermanos ameijeiras'),
  (10, 'calixto garcia',           23.1357, -82.3666, 'calixto garcia'),
  (11, 'la benefica',              23.1357, -82.3666, 'miguel enriquez'),
  (12, 'cementerio de colon',      23.1357, -82.3666, 'cementerio de colon'),
  (13, 'ciudad deportiva',         23.1357, -82.3666, 'ciudad deportiva'),
  (14, 'karl marx',                23.1357, -82.3666, '^teatro karl marx'),
  (15, 'cuatro caminos',           23.1357, -82.3666, '4 caminos|cuatro caminos'),
  (16, 'manzana de gomez',         23.1357, -82.3666, 'kempinski|manzana'),
  (17, 'oncologico',               23.1357, -82.3666, 'oncologic'),
  (18, 'la cabaña',                23.1357, -82.3666, 'cabana'),
  (19, 'tropicana',                23.1357, -82.3666, 'tropicana'),
  (20, 'terminal de omnibus',      23.1357, -82.3666, 'terminal de omnibus'),
  (21, 'aeropuerto jose marti',    23.1357, -82.3666, 'jose marti'),
  (22, 'parque lenin',             23.1357, -82.3666, '^parque lenin'),
  (23, 'plaza de la revolucion',   23.1357, -82.3666, 'plaza de la revolucion'),
  (24, 'castillo del morro',       23.1357, -82.3666, 'morro'),
  (25, 'plaza vieja',              23.1357, -82.3666, '^plaza vieja'),
  (26, 'catedral de la habana',    23.1357, -82.3666, 'catedral'),
  (27, 'museo de la revolucion',   23.1357, -82.3666, '^museo de la revolucion'),
  (28, 'gran teatro',              23.1357, -82.3666, 'gran teatro'),
  (29, 'estadio latinoamericano',  23.1357, -82.3666, 'latinoamericano'),
  (30, 'universidad de la habana', 23.1357, -82.3666, '^universidad de la habana'),
  (31, 'hospital naval',           23.1357, -82.3666, 'naval'),
  (32, 'hospital militar',         23.1357, -82.3666, 'militar'),
  (33, 'cira garcia',              23.1357, -82.3666, 'cira garcia'),
  (34, 'la lonja',                 23.1357, -82.3666, 'lonja del comercio'),
  (35, 'maternidad de linea',      23.1357, -82.3666, 'america arias'),
  (36, 'la ceguera',               23.1357, -82.3666, 'pando ferrer'),
  (37, 'malecon',                  23.1357, -82.3666, 'malecon'),
  (38, 'plaza de armas',           23.1357, -82.3666, '^plaza de armas'),
  (39, 'callejon de hamel',        23.1357, -82.3666, 'hamel'),
  (40, 'hotel inglaterra',         23.1357, -82.3666, '^hotel inglaterra'),
  -- typos / accents / prefixes
  (41, 'copelia',                  23.1357, -82.3666, '^coppelia'),
  (42, 'capitolio nacional',       23.1357, -82.3666, 'capitolio'),
  (43, 'hosp calixto',             23.1357, -82.3666, 'calixto garcia'),
  (44, 'hotel habana lib',         23.1357, -82.3666, '^hotel habana libre'),
  (45, 'teatro karl',              23.1357, -82.3666, '^teatro karl marx'),
  -- other provinces (origin = the city centre)
  (46, 'casa granda',              20.0197, -75.8283, 'casa granda'),
  (47, 'santa ifigenia',           20.0197, -75.8283, 'santa ifigenia'),
  (48, 'cuartel moncada',          20.0197, -75.8283, 'moncada'),
  (49, 'parque cespedes',          20.0197, -75.8283, 'cespedes'),
  (50, 'mausoleo del che',         22.4069, -79.9649, 'che'),
  (51, 'teatro tomas terry',       22.1461, -80.4358, 'terry'),
  (52, 'plaza del carmen',         21.3808, -77.9169, 'carmen'),
  (53, 'loma de la cruz',          20.8872, -76.2631, 'loma de la cruz'),
  (54, 'teatro sauto',             23.0511, -81.5775, 'sauto'),
  (55, 'plaza mayor',              21.8042, -79.9840, 'plaza mayor'),
  (56, 'hotel internacional',      23.1394, -81.2861, 'internacional'),
  (57, 'aeropuerto de varadero',   23.1394, -81.2861, 'varadero|juan gualberto'),
  (58, 'hospital pediatrico',      22.4069, -79.9649, 'pediatric'),
  (59, 'universidad de oriente',   20.0197, -75.8283, 'universidad de oriente'),
  (60, 'terminal de trenes',       23.1357, -82.3666, 'ferrocarril|estacion central|terminal')
), run AS (
  SELECT c.n, c.q, c.expect, r.id, r.name AS top1, r.match_reason, r.matched_alias, round(r.distance_m) AS dist_m
  FROM cases c
  LEFT JOIN LATERAL (SELECT * FROM :fn(c.q, c.lat, c.lng, 30000, 5) LIMIT 1) r ON true
)
SELECT n, q, top1, match_reason AS reason, matched_alias AS alias, dist_m,
       (lower(unaccent(COALESCE(top1, ''))) ~ expect) AS ok
FROM run ORDER BY n;

-- Summary line
WITH cases(n, q, lat, lng, expect) AS (VALUES (0, '', 0.0, 0.0, '')) SELECT 'see rows above' AS note;

-- No-change controls: 20 plain queries whose top-1 must be the same POI in v1 and v2.
WITH ctl(q, lat, lng) AS (VALUES
  ('farmacia',        23.1357, -82.3666), ('panaderia',        23.1357, -82.3666),
  ('cadeca',          23.1357, -82.3666), ('etecsa',           23.1357, -82.3666),
  ('cupet',           23.1357, -82.3666), ('policlinico',      23.1357, -82.3666),
  ('iglesia',         23.1357, -82.3666), ('escuela',          23.1357, -82.3666),
  ('banco metropolitano', 23.1357, -82.3666), ('agromercado',   23.1357, -82.3666),
  ('cine yara',       23.1357, -82.3666), ('cine 23 y 12',     23.1357, -82.3666),
  ('hotel sevilla',   23.1357, -82.3666), ('hotel saratoga',   23.1357, -82.3666),
  ('paladar la guarida', 23.1357, -82.3666), ('museo de bellas artes', 23.1357, -82.3666),
  ('parque almendares', 23.1357, -82.3666), ('playa santa maria', 23.1357, -82.3666),
  ('hotel melia cohiba', 23.1357, -82.3666), ('estadio pedro marrero', 23.1357, -82.3666)
)
SELECT c.q, v1.name AS v1_top, v2.name AS v2_top, (v1.id = v2.id) AS same
FROM ctl c
LEFT JOIN LATERAL (SELECT id, name FROM search_pois_smart_v1(c.q, c.lat, c.lng, 30000, 1)) v1 ON true
LEFT JOIN LATERAL (SELECT id, name FROM :fn(c.q, c.lat, c.lng, 30000, 1)) v2 ON true
ORDER BY c.q;
```

- [ ] **Step 3: Run the suite against v2 and v1; classify every miss**

```bash
psql -d poi_real -v fn=search_pois_smart    -f supabase/tests/poi/search_suite.sql > /tmp/claude-0/-home-user-TriciGo/1efb647a-95c0-5d15-b108-d4eda4b855b4/scratchpad/suite_v2.out
psql -d poi_real -v fn=search_pois_smart_v1 -f supabase/tests/poi/search_suite.sql > /tmp/claude-0/-home-user-TriciGo/1efb647a-95c0-5d15-b108-d4eda4b855b4/scratchpad/suite_v1.out
grep -c "| t$" …/suite_v2.out; grep -c "| t$" …/suite_v1.out
```
For each `f` row in v2: query the real rows (`SELECT id, display_name, tricigo_category, municipality, pick_count FROM cuba_pois WHERE lower(unaccent(display_name)) ~ '<expect>' AND is_active`) and decide: **(a) data gap** (no row in the DB matches the expectation — e.g. the landmark only exists as a stop) → keep the case, note it in the PR body as a data gap; **(b) alias gap** (row exists, name unrelated to the query) → add the alias to 00579's curated seed list is NOT this PR's job; note for PR-4; **(c) ranking bug** (row exists, matches the query by name/alias, but another row wins) → fix the ranking here (adjust the tier or a weight), re-run the whole suite, never an expectation. Control set: any `same = f` needs the same triage — v2 may legitimately move a top-1 (a merged duplicate, a stop shadow, a landmark), and the PR body lists every moved control with the reason.

- [ ] **Step 4: Latency, warm, 3 runs, both versions**

```bash
for f in search_pois_smart_v1 search_pois_smart; do for i in 1 2 3; do
  psql -d poi_real -Atc "SELECT '$f', round(1000*extract(epoch FROM (clock_timestamp() - t0))) AS ms FROM (SELECT clock_timestamp() AS t0, (SELECT count(*) FROM (VALUES ('capitolio'),('habana libre'),('la benefica'),('hospital'),('cafeteria'),('parque central'),('bar'),('universidad de la habana'),('coppelia'),('hotel')) q(s), LATERAL $f(q.s, 23.1357, -82.3666, 30000, 10)) ) x;"
done; done
```
Expected: v2 ≤ v1 per 10-query batch (spec target ≤250 ms p95 per query on prod; locally compare relative). If v2 is slower than v1 by >2×, `EXPLAIN (ANALYZE, BUFFERS)` the `dict` CTE for 'bar' — the fix is a tighter gather (e.g. require `length(v_norm) >= 3` for the trgm `%` branch), not a bigger machine.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/poi/search_suite.sql
git commit -m "test(poi): 60-query real-data search suite + 20 no-change controls, v1/v2 A/B"
```

---

### Task 3: 00584 — queue, `bump_poi_pick`, `record_poi_pick`, `find_nearby_poi_match` v2

**Files:**
- Create: `supabase/migrations/00584_poi_pick_learning.sql` (part 1 — Task 4 appends the trigger and cron)
- Test: `supabase/tests/poi/tests.sql` (T9a–T9e)

- [ ] **Step 1: Write the failing tests**

```sql
-- T9: learning from picks (00584)
DO $$
DECLARE v_hotel bigint; v_ben bigint; v_before int; v_ok boolean; v_uid uuid := '00000000-0000-0000-0000-00000000c001'; v_n int;
BEGIN
  SELECT id INTO v_hotel FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category <> 'public_transport' AND is_active LIMIT 1;
  SELECT id INTO v_ben   FROM cuba_pois WHERE name = 'Hospital Miguel Enríquez' AND is_active LIMIT 1;
  INSERT INTO users (id, role, full_name) VALUES (v_uid, 'customer', 'Rider Prueba') ON CONFLICT DO NOTHING;

  -- T9a: record_poi_pick needs a session
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM _t('T9a unauthenticated pick refused', record_poi_pick(v_hotel) = false);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  SELECT pick_count INTO v_before FROM cuba_pois WHERE id = v_hotel;
  v_ok := record_poi_pick(v_hotel);
  PERFORM _t('T9b authenticated pick counts', v_ok AND (SELECT pick_count FROM cuba_pois WHERE id = v_hotel) = v_before + 1
                                              AND (SELECT last_picked_at FROM cuba_pois WHERE id = v_hotel) > now() - interval '1 minute');
  PERFORM _t('T9c pick on a merged/inactive row is a no-op',
             record_poi_pick((SELECT id FROM cuba_pois WHERE merged_into IS NOT NULL LIMIT 1)) = false);
  -- rate limit: 60/h — burn the window
  FOR i IN 1..60 LOOP PERFORM record_poi_pick(v_hotel); END LOOP;
  PERFORM _t('T9d 61st pick in the hour is refused', record_poi_pick(v_hotel) = false);
  DELETE FROM rate_limits WHERE key LIKE 'poi_pick:%';
  UPDATE cuba_pois SET pick_count = v_before WHERE id = v_hotel;

  -- T9e: bump_poi_pick is service-only
  PERFORM _t('T9e bump_poi_pick not executable by authenticated', NOT has_function_privilege('authenticated', 'public.bump_poi_pick(bigint)', 'EXECUTE')
                                                                 AND NOT has_function_privilege('anon', 'public.bump_poi_pick(bigint)', 'EXECUTE'));
  PERFORM _t('T9f record_poi_pick not executable by anon', NOT has_function_privilege('anon', 'public.record_poi_pick(bigint)', 'EXECUTE'));

  -- T9g: find_nearby_poi_match v2 matches by alias and by display name, skips merged rows
  PERFORM _t('T9g alias match', find_nearby_poi_match('La Benéfica', ST_Y((SELECT location::geometry FROM cuba_pois WHERE id = v_ben)), ST_X((SELECT location::geometry FROM cuba_pois WHERE id = v_ben)), 60) = v_ben);
  PERFORM _t('T9h display match ("La Roca" vs raw "La Roca, La Habana, Cuba")',
             find_nearby_poi_match('La Roca', ST_Y((SELECT location::geometry FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba')), ST_X((SELECT location::geometry FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba')), 60)
             = (SELECT id FROM cuba_pois WHERE name = 'La Roca, La Habana, Cuba'));
  SELECT count(*) INTO v_n FROM cuba_pois m WHERE m.merged_into IS NOT NULL
     AND find_nearby_poi_match(m.name, ST_Y(m.location::geometry), ST_X(m.location::geometry), 60) = m.id;
  PERFORM _t('T9i merged rows never matched', v_n = 0);
END $$;
```

- [ ] **Step 2: Run the harness, see T9 fail**

Run: `supabase/tests/poi/run.sh 2>&1 | grep -E "FAIL|ERROR" | head`
Expected: `function record_poi_pick(bigint) does not exist` (the DO block errors → run.sh shows ERROR).

- [ ] **Step 3: Write `00584_poi_pick_learning.sql` (part 1)**

```sql
-- ============================================================================
-- 00584 — learning from what riders pick
--
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §5.3
-- Plan: docs/superpowers/plans/2026-09-06-poi-quality-pr2-search.md
-- Depends on 00579 (pick_count, last_picked_at, merged_into, display_name,
-- cuba_poi_aliases), 00105 (check_rate_limit), 00506 (cron_http_post),
-- 00546 (_ride_address_is_placeholder).
--
-- 1. poi_import_queue — names a ride went to that no POI matched (RLS: admin read).
-- 2. bump_poi_pick(id) — service-only +1 (drain worker).
-- 3. record_poi_pick(id) — authenticated, 60/h per user (PR-3 app taps).
-- 4. find_nearby_poi_match v2 — also matches display_name and aliases, skips merged rows.
-- 5. _poi_leading_venue_name + tg_rides_learn_poi_picks — AFTER INSERT ON rides:
--    the venue part of each address either credits the POI (+1 pick) or is queued.
-- 6. drain_poi_import_queue_tick + cron every 15 min → import-mapbox-poi {drain:20}
--    through cron_http_post (CLAUDE.md rule: never raw net.http_post), only when
--    the queue has pending work.
-- ============================================================================
SET statement_timeout = 0;

-- 1. Queue ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.poi_import_queue (
  id           bigserial PRIMARY KEY,
  ride_id      uuid REFERENCES public.rides(id) ON DELETE SET NULL,
  endpoint     text NOT NULL CHECK (endpoint IN ('pickup', 'dropoff')),
  name         text NOT NULL,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  poi_id       bigint REFERENCES public.cuba_pois(id) ON DELETE SET NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_poi_import_queue_pending ON public.poi_import_queue (created_at) WHERE status = 'pending';
ALTER TABLE public.poi_import_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS poi_import_queue_admin_read ON public.poi_import_queue;
CREATE POLICY poi_import_queue_admin_read ON public.poi_import_queue FOR SELECT TO authenticated USING (public.is_admin());
COMMENT ON TABLE public.poi_import_queue IS
  '00584: venue names from real rides that matched no POI. Drained every 15 min by import-mapbox-poi {drain:N} (service role). Admin reads it (PR-4 suspects tab); nobody else.';

-- 2. Service-only bump (drain worker) ---------------------------------------
CREATE OR REPLACE FUNCTION public.bump_poi_pick(p_poi_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  UPDATE public.cuba_pois SET pick_count = pick_count + 1, last_picked_at = now()
   WHERE id = p_poi_id AND is_active AND merged_into IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.bump_poi_pick(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_poi_pick(bigint) TO service_role;

-- 3. Rider pick (PR-3 app taps) ----------------------------------------------
CREATE OR REPLACE FUNCTION public.record_poi_pick(p_poi_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_allowed boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT allowed INTO v_allowed FROM public.check_rate_limit('poi_pick:' || v_uid::text, 60, 3600);
  IF NOT COALESCE(v_allowed, false) THEN RETURN false; END IF;
  UPDATE public.cuba_pois SET pick_count = pick_count + 1, last_picked_at = now()
   WHERE id = p_poi_id AND is_active AND merged_into IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.record_poi_pick(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_poi_pick(bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public.record_poi_pick(bigint) IS '00584: +1 pick_count for a POI the rider chose in the app; 60/h per user; false when unauthenticated, rate-limited, inactive or merged.';

-- 4. find_nearby_poi_match v2 (same signature; live v1 md5 1cd4989f…) -------
CREATE OR REPLACE FUNCTION public.find_nearby_poi_match(p_name text, p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 50)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_norm TEXT;
  v_id BIGINT;
BEGIN
  IF p_name IS NULL OR length(p_name) < 2 THEN
    RETURN NULL;
  END IF;
  v_norm := lower(unaccent(p_name));
  -- 00584: best of raw name, cleaned display_name and every alias; merged rows out.
  SELECT cp.id INTO v_id
  FROM public.cuba_pois cp
  CROSS JOIN LATERAL (
    SELECT GREATEST(
      similarity(cp.name_normalized, v_norm),
      similarity(lower(unaccent(COALESCE(cp.display_name, ''))), v_norm),
      COALESCE((SELECT max(similarity(a.alias_norm, v_norm)) FROM public.cuba_poi_aliases a WHERE a.poi_id = cp.id), 0)
    ) AS sim
  ) s
  WHERE cp.is_active
    AND cp.merged_into IS NULL
    AND cp.location IS NOT NULL
    AND ST_DWithin(cp.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, p_radius_m)
    AND cp.name_normalized IS NOT NULL
    AND s.sim >= 0.6
  ORDER BY s.sim DESC,
           ST_Distance(cp.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) ASC,
           cp.id ASC
  LIMIT 1;
  RETURN v_id;
END;
$function$;
COMMENT ON FUNCTION public.find_nearby_poi_match(text, double precision, double precision, integer) IS
  '00584 v2: similarity ≥ 0.6 against raw name, display_name or any alias within p_radius_m; merged rows excluded; ties by distance then id.';
```

- [ ] **Step 4: Run the harness; T9a–T9i pass**

Run: `supabase/tests/poi/run.sh 2>&1 | grep -E "FAIL|ERROR|failures|^ +[0-9]+$"`
Expected: `failures` = `0`. If T9d fails: `check_rate_limit` counts the calls in T9b too (61 total in the window) — the loop must be 59 iterations, or the test deletes the window first; fix the **test**, the 60/h contract is the spec's.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00584_poi_pick_learning.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): poi_import_queue, record_poi_pick (60/h), bump_poi_pick, find_nearby_poi_match v2 with aliases (00584 part 1)"
```

---

### Task 4: 00584 — venue-name extractor, rides trigger, drain cron

**Files:**
- Modify: `supabase/migrations/00584_poi_pick_learning.sql` (append sections 5–6)
- Test: `supabase/tests/poi/tests.sql` (T9j–T9r)

- [ ] **Step 1: Write the failing tests**

```sql
-- T9 (cont.): venue name extraction, rides trigger, drain tick
DO $$
DECLARE v_hotel bigint; v_before int; v_n int; v_req bigint;
BEGIN
  SELECT id INTO v_hotel FROM cuba_pois WHERE name = 'Hotel Habana Libre' AND category <> 'public_transport' AND is_active LIMIT 1;
  PERFORM _t('T9j venue leads', _poi_leading_venue_name('Coppelia, Calle 23 e/ L y K, Plaza de la Revolución, La Habana') = 'Coppelia'
                              AND _poi_leading_venue_name('Paladar Doña Eutimia, Callejón del Chorro 60, La Habana Vieja') = 'Paladar Doña Eutimia');
  PERFORM _t('T9k corners/streets/zones/placeholders give NULL',
             _poi_leading_venue_name('Calle 23 y Calle 12, Plaza, La Habana') IS NULL
         AND _poi_leading_venue_name('Reina e/ Campanario y Lealtad, Centro Habana') IS NULL
         AND _poi_leading_venue_name('23 y 12, Vedado') IS NULL
         AND _poi_leading_venue_name('Vedado, La Habana') IS NULL
         AND _poi_leading_venue_name('Plaza de la Revolución, La Habana') IS NULL
         AND _poi_leading_venue_name('Playa, La Habana') IS NULL
         AND _poi_leading_venue_name('Detectando dirección...') IS NULL
         AND _poi_leading_venue_name('Cerca de Capitolio') IS NULL
         AND _poi_leading_venue_name('23.12638, -82.35472') IS NULL
         AND _poi_leading_venue_name('Av 51, Marianao') IS NULL
         AND _poi_leading_venue_name('X, La Habana') IS NULL);

  SELECT pick_count INTO v_before FROM cuba_pois WHERE id = v_hotel;
  -- T9l: a ride to the hotel credits it (dropoff), the corner pickup does nothing
  INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng)
  VALUES ('Calle 23 y Calle 12, Plaza de la Revolución, La Habana', 23.1408, -82.3830,
          'Hotel Habana Libre, Calle L e/ 23 y 25, Plaza de la Revolución, La Habana',
          ST_Y((SELECT location::geometry FROM cuba_pois WHERE id = v_hotel)), ST_X((SELECT location::geometry FROM cuba_pois WHERE id = v_hotel)));
  PERFORM _t('T9l ride dropoff credits the POI', (SELECT pick_count FROM cuba_pois WHERE id = v_hotel) = v_before + 1);
  PERFORM _t('T9m nothing queued for a known POI or a corner', (SELECT count(*) FROM poi_import_queue) = 0);

  -- T9n: an unknown venue is queued once (second ride with the same name nearby does not duplicate)
  INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng)
  VALUES ('Vedado, La Habana', 23.1408, -82.3830, 'Paladar Doña Eutimia, Callejón del Chorro 60, La Habana Vieja', 23.1412, -82.3520);
  INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng)
  VALUES ('Vedado, La Habana', 23.1408, -82.3830, 'Paladar Dona Eutimia, Callejón del Chorro, La Habana Vieja', 23.1413, -82.3521);
  SELECT count(*) INTO v_n FROM poi_import_queue WHERE status = 'pending';
  PERFORM _t('T9n unknown venue queued exactly once', v_n = 1
             AND (SELECT name || '|' || endpoint FROM poi_import_queue LIMIT 1) = 'Paladar Doña Eutimia|dropoff');

  -- T9o: the trigger can never break a ride (force an error inside: NULL coordinates + bad text)
  INSERT INTO rides (pickup_address, dropoff_address) VALUES ('Coppelia, Calle 23', 'Hotel Habana Libre, Calle L');
  PERFORM _t('T9o ride inserts even when the trigger has nothing to work with', (SELECT count(*) FROM rides) = 4);

  -- T9p/T9q: drain tick fires only with pending work, through cron_http_post
  UPDATE poi_import_queue SET status = 'done';
  PERFORM _t('T9p tick is a no-op without pending rows', drain_poi_import_queue_tick() IS NULL AND (SELECT count(*) FROM cron_http_calls) = 0);
  UPDATE poi_import_queue SET status = 'pending';
  v_req := drain_poi_import_queue_tick();
  PERFORM _t('T9q tick posts {drain:20} with the service key via cron_http_post',
             v_req IS NOT NULL
         AND (SELECT jobname FROM cron_http_calls WHERE request_id = v_req) = 'drain-poi-import-queue'
         AND (SELECT body->>'drain' FROM net._stub_requests WHERE id = v_req) = '20'
         AND (SELECT headers->>'Authorization' FROM net._stub_requests WHERE id = v_req) = 'Bearer sb_secret_local_stub'
         AND (SELECT timeout_ms FROM net._stub_requests WHERE id = v_req) = 30000);
  PERFORM _t('T9r cron job scheduled every 15 min', (SELECT schedule FROM cron.job WHERE jobname = 'drain-poi-import-queue') = '*/15 * * * *');
  PERFORM _t('T9s tick/trigger helpers not executable by app roles',
             NOT has_function_privilege('authenticated', 'public.drain_poi_import_queue_tick()', 'EXECUTE')
         AND NOT has_function_privilege('anon', 'public._poi_leading_venue_name(text)', 'EXECUTE'));
END $$;
```

- [ ] **Step 2: Run the harness, see T9j… error**

Expected: `function _poi_leading_venue_name(text) does not exist`.

- [ ] **Step 3: Append sections 5–6 to `00584_poi_pick_learning.sql`** (before `RESET statement_timeout;`, which moves to the very end)

```sql
-- 5. Venue name → POI on ride creation --------------------------------------
CREATE OR REPLACE FUNCTION public._poi_leading_venue_name(p_addr text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
  -- The venue part of a ride address: "Coppelia, Calle 23 e/ L y K, Plaza, La Habana" → "Coppelia".
  -- NULL for placeholders, corner / street forms, zone names, numeric or too-short text.
  SELECT CASE
    WHEN public._ride_address_is_placeholder(p_addr) THEN NULL
    WHEN v.lead IS NULL OR length(v.lead) < 3 OR length(v.lead) > 80 THEN NULL
    WHEN v.lead !~ '[[:alpha:]].*[[:alpha:]]' THEN NULL
    WHEN v.lead ~* '(^|\s)(e/|entre|esq\.?|esquina|y)(\s|$)' THEN NULL
    WHEN v.lead ~* '^(calle|calzada|avenida|ave\.?|av\.?|avda\.?|carretera|camino|callejon|callejón|paseo|linea|línea|km|kilometro|kilómetro|autopista|circunvalacion|circunvalación|reparto|rpto\.?|edificio|edif\.?|apto\.?|apartamento|cerca de)(\s|$)' THEN NULL
    WHEN v.lead ~ '^\d' THEN NULL
    WHEN lower(unaccent(v.lead)) IN (
      'vedado', 'el vedado', 'nuevo vedado', 'miramar', 'centro habana', 'habana vieja', 'la habana vieja', 'cerro',
      'playa', 'marianao', 'la lisa', 'boyeros', 'alamar', 'cojimar', 'santos suarez', 'lawton', 'luyano',
      'la vibora', 'vibora', 'siboney', 'kohly', 'casino deportivo', 'santa fe', 'guanabo', 'regla', 'guanabacoa',
      'la habana', 'habana', 'varadero', 'centro historico', 'reparto flores', 'buenavista', 'buena vista') THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.cuba_admin_areas a
                 WHERE lower(unaccent(a.name)) = lower(unaccent(v.lead))
                    OR lower(unaccent(COALESCE(a.name_es, ''))) = lower(unaccent(v.lead))) THEN NULL
    ELSE v.lead END
  FROM (SELECT NULLIF(btrim(split_part(COALESCE(p_addr, ''), ',', 1)), '') AS lead) v;
$$;
REVOKE ALL ON FUNCTION public._poi_leading_venue_name(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_rides_learn_poi_picks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ep   record;
  v_name text;
  v_poi  bigint;
BEGIN
  FOR v_ep IN
    SELECT * FROM (VALUES
      ('pickup',  NEW.pickup_address,
         COALESCE(NEW.pickup_lat,  ST_Y(NEW.pickup_location::geometry)),
         COALESCE(NEW.pickup_lng,  ST_X(NEW.pickup_location::geometry))),
      ('dropoff', NEW.dropoff_address,
         COALESCE(NEW.dropoff_lat, ST_Y(NEW.dropoff_location::geometry)),
         COALESCE(NEW.dropoff_lng, ST_X(NEW.dropoff_location::geometry)))
    ) AS e(endpoint, addr, lat, lng)
  LOOP
    v_name := public._poi_leading_venue_name(v_ep.addr);
    IF v_name IS NULL OR v_ep.lat IS NULL OR v_ep.lng IS NULL THEN CONTINUE; END IF;
    v_poi := public.find_nearby_poi_match(v_name, v_ep.lat, v_ep.lng, 60);
    IF v_poi IS NOT NULL THEN
      UPDATE public.cuba_pois SET pick_count = pick_count + 1, last_picked_at = now()
       WHERE id = v_poi AND is_active AND merged_into IS NULL;
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.poi_import_queue q
        WHERE q.status = 'pending'
          AND lower(unaccent(q.name)) = lower(unaccent(v_name))
          AND abs(q.lat - v_ep.lat) < 0.002 AND abs(q.lng - v_ep.lng) < 0.002) THEN
      INSERT INTO public.poi_import_queue (ride_id, endpoint, name, lat, lng)
      VALUES (NEW.id, v_ep.endpoint, v_name, v_ep.lat, v_ep.lng);
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_rides_learn_poi_picks: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rides_learn_poi_picks ON public.rides;
CREATE TRIGGER trg_rides_learn_poi_picks
  AFTER INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_learn_poi_picks();
COMMENT ON FUNCTION public.tg_rides_learn_poi_picks() IS
  '00584: after a ride is created, the venue part of each address credits the matching POI (pick_count) or is queued in poi_import_queue. Defensive: never blocks the insert.';

-- 6. Drain cron (every 15 min, only when there is work) ----------------------
CREATE OR REPLACE FUNCTION public.drain_poi_import_queue_tick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.poi_import_queue WHERE status = 'pending') THEN
    RETURN NULL;
  END IF;
  RETURN public.cron_http_post('drain-poi-import-queue',
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/import-mapbox-poi',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || public.get_service_role_key(),
                 'apikey', public.get_service_role_key()),
    body    := '{"drain": 20}'::jsonb,
    timeout_milliseconds := 30000);
END $$;
REVOKE ALL ON FUNCTION public.drain_poi_import_queue_tick() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-poi-import-queue') THEN
      PERFORM cron.unschedule('drain-poi-import-queue');
    END IF;
    PERFORM cron.schedule('drain-poi-import-queue', '*/15 * * * *', $c$ SELECT public.drain_poi_import_queue_tick(); $c$);
    RAISE NOTICE '00584: cron drain-poi-import-queue scheduled (*/15)';
  ELSE
    RAISE NOTICE '00584: pg_cron absent; drain job not scheduled';
  END IF;
END $$;

RESET statement_timeout;
```

- [ ] **Step 4: Run the harness twice; T9j–T9s pass; second pass idempotent**

Run: `supabase/tests/poi/run.sh 2>&1 | grep -E "FAIL|ERROR|failures|^ +[0-9]+$|NOTICE:  00584"`
Expected: `failures` = `0`; second pass shows the cron re-scheduled without error (unschedule + schedule).

If T9l fails: `find_nearby_poi_match('Hotel Habana Libre', …, 60)` must return the hotel and not the platform fixture 15 m away — both have `similarity = 1`; the tie breaks by distance, and the ride coordinates are the hotel's own → hotel wins. If the platform wins, the fixture in Task 0 is not 15 m away from the hotel; fix the fixture coordinates.

- [ ] **Step 5: Real-data rehearsal of 00584 on `poi_real`**

```bash
psql -d poi_real -v ON_ERROR_STOP=1 -q -f supabase/migrations/00584_poi_pick_learning.sql
psql -d poi_real -Atc "
BEGIN;
INSERT INTO rides (pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng) VALUES
 ('Hotel Nacional de Cuba, Calle 21 y O, Vedado, La Habana', 23.1439, -82.3811, 'Coppelia, Calle 23 y L, Vedado, La Habana', 23.1385, -82.3826),
 ('La Benéfica, Diez de Octubre, La Habana', 23.0973, -82.3411, 'Calle 100 y Avenida 51, Marianao', 23.0850, -82.4300),
 ('Vedado, La Habana', 23.14, -82.38, 'Paladar Inexistente Prueba, Calle 8 e/ 5 y 7, Playa', 23.1200, -82.4200);
SELECT name, display_name, pick_count FROM cuba_pois WHERE pick_count > 0 ORDER BY id;
SELECT endpoint, name, status FROM poi_import_queue;
ROLLBACK;"
```
Expected: Hotel Nacional, Coppelia and the Benéfica hospital at `pick_count = 1`; the queue holds exactly `dropoff | Paladar Inexistente Prueba | pending`; nothing for the corner or the zone.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00584_poi_pick_learning.sql supabase/tests/poi/tests.sql
git commit -m "feat(poi): learn from rides — venue-name extractor, pick trigger, 15-min drain cron via cron_http_post (00584)"
```

---

### Task 5: Drain state machine (pure, vitest)

**Files:**
- Create: `supabase/functions/_shared/poi-import-queue.ts`
- Test: `supabase/functions/_shared/poi-import-queue.test.ts` (run by `packages/api` vitest)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { nextQueueState, MAX_DRAIN_ATTEMPTS, clampDrainSize } from './poi-import-queue';

describe('nextQueueState', () => {
  it('a fresh import is done and bumps the new POI', () => {
    expect(nextQueueState(0, { kind: 'imported', poiId: 42, reason: 'inserted' })).toEqual({
      status: 'done', attempts: 1, poi_id: 42, reason: 'inserted', bump: true,
    });
  });
  it('a dedupe hit is done and bumps the existing POI', () => {
    expect(nextQueueState(1, { kind: 'matched', poiId: 7, reason: 'duplicate_within_50m' })).toEqual({
      status: 'done', attempts: 2, poi_id: 7, reason: 'duplicate_within_50m', bump: true,
    });
  });
  it('an admin match is done without a bump (curated rows are not learned into)', () => {
    expect(nextQueueState(0, { kind: 'matched', poiId: 9, reason: 'admin_match', bump: false })).toMatchObject({ status: 'done', poi_id: 9, bump: false });
  });
  it('no match stays pending until the last attempt, then fails', () => {
    expect(nextQueueState(0, { kind: 'no_match', reason: 'no_mapbox_results' })).toEqual({
      status: 'pending', attempts: 1, poi_id: null, reason: 'no_mapbox_results', bump: false,
    });
    expect(nextQueueState(MAX_DRAIN_ATTEMPTS - 1, { kind: 'no_match', reason: 'no_good_match' })).toEqual({
      status: 'failed', attempts: MAX_DRAIN_ATTEMPTS, poi_id: null, reason: 'no_good_match', bump: false,
    });
  });
  it('an error counts as an attempt and keeps the reason', () => {
    expect(nextQueueState(0, { kind: 'error', reason: 'rpc_error: boom' })).toMatchObject({ status: 'pending', attempts: 1, reason: 'rpc_error: boom' });
  });
  it('a rejected import (out_of_cuba, name_too_short) fails immediately — retrying cannot help', () => {
    expect(nextQueueState(0, { kind: 'rejected', reason: 'out_of_cuba' })).toEqual({
      status: 'failed', attempts: 1, poi_id: null, reason: 'out_of_cuba', bump: false,
    });
  });
});

describe('clampDrainSize', () => {
  it('bounds the batch to 1..50 and defaults bad input to 20', () => {
    expect(clampDrainSize(20)).toBe(20);
    expect(clampDrainSize(0)).toBe(1);
    expect(clampDrainSize(500)).toBe(50);
    expect(clampDrainSize(Number.NaN)).toBe(20);
    expect(clampDrainSize(undefined)).toBe(20);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/poi-import-queue.test.ts 2>&1 | tail -5`
Expected: FAIL — `Cannot find module './poi-import-queue'`.

- [ ] **Step 3: Implement `poi-import-queue.ts`**

```ts
// supabase/functions/_shared/poi-import-queue.ts
// Pure state machine for the import-mapbox-poi {drain:N} worker (00584).
// No Deno / remote imports so packages/api's vitest can run it.

export const MAX_DRAIN_ATTEMPTS = 2;

export type DrainOutcome =
  | { kind: 'imported'; poiId: number; reason: string }
  | { kind: 'matched'; poiId: number; reason: string; bump?: boolean }
  | { kind: 'no_match'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'error'; reason: string };

export interface QueueUpdate {
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  poi_id: number | null;
  reason: string;
  /** true → call bump_poi_pick(poi_id): the rider really went there. */
  bump: boolean;
}

export function nextQueueState(attempts: number, outcome: DrainOutcome): QueueUpdate {
  const next = attempts + 1;
  switch (outcome.kind) {
    case 'imported':
      return { status: 'done', attempts: next, poi_id: outcome.poiId, reason: outcome.reason, bump: true };
    case 'matched':
      return { status: 'done', attempts: next, poi_id: outcome.poiId, reason: outcome.reason, bump: outcome.bump ?? true };
    case 'rejected':
      return { status: 'failed', attempts: next, poi_id: null, reason: outcome.reason, bump: false };
    case 'no_match':
    case 'error':
      return {
        status: next >= MAX_DRAIN_ATTEMPTS ? 'failed' : 'pending',
        attempts: next,
        poi_id: null,
        reason: outcome.reason,
        bump: false,
      };
  }
}

export function clampDrainSize(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, Math.floor(n)));
}
```

- [ ] **Step 4: Run the test; it passes**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/poi-import-queue.test.ts 2>&1 | tail -4`
Expected: `Tests  7 passed (7)`.

- [ ] **Step 5: Type-check the module the way CLAUDE.md prescribes for `_shared` helpers**

Run: `npx tsc --noEmit --strict --target es2020 --moduleResolution node supabase/functions/_shared/poi-import-queue.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/poi-import-queue.ts supabase/functions/_shared/poi-import-queue.test.ts
git commit -m "feat(ef): pure drain state machine for the POI import queue (vitest)"
```

---

### Task 6: `import-mapbox-poi` — service-role drain mode

**Files:**
- Modify: `supabase/functions/import-mapbox-poi/index.ts`

- [ ] **Step 1: Add `feature_type` and a `types` parameter to the Mapbox helper**

In `interface MapboxFeature.properties` add `feature_type?: string;`. Change the signature to `async function queryMapbox(query: string, proximity: ProximityPoint | undefined, token: string, types = 'poi,address')` and use `types` in the `URLSearchParams` (`types,`). The user path keeps the default.

- [ ] **Step 2: Extend the request type and branch before the user auth**

```ts
interface RequestBody {
  query?: string;
  proximity?: ProximityPoint;
  google_result?: GoogleHint;
  /** 00584: service-role batch mode — process up to N pending poi_import_queue rows. */
  drain?: number;
}
```
Right after `body` is parsed (before `const query = (body.query ?? '').trim();`):
```ts
  if (body.drain !== undefined) {
    return await handleDrain(body.drain, authHeader);
  }
```
and add the import at the top: `import { nextQueueState, clampDrainSize, type DrainOutcome } from '../_shared/poi-import-queue.ts';`

- [ ] **Step 3: Implement `handleDrain`** (after `pickBestMatch`)

```ts
// ── 00584: drain mode (cron → cron_http_post → here, service role) ──
interface QueueRow { id: number; name: string; lat: number; lng: number; attempts: number }

async function handleDrain(requested: unknown, authHeader: string): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mapboxToken = Deno.env.get('MAPBOX_ACCESS_TOKEN');
  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'service_misconfigured' }, 503);
  }
  // Exact service-role match, same gate as send-sms: a user JWT never drains.
  if (authHeader !== `Bearer ${serviceRole}`) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'unauthenticated' }, 401);
  }
  if (!mapboxToken) {
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'mapbox_not_configured' }, 200);
  }
  const size = clampDrainSize(requested);
  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  const { data: rows, error: selErr } = await supabase
    .from('poi_import_queue')
    .select('id,name,lat,lng,attempts')
    .eq('status', 'pending')
    .lt('attempts', 2)
    .order('created_at', { ascending: true })
    .limit(size);
  if (selErr) {
    console.error('[import-mapbox-poi] drain select error:', selErr);
    return jsonResponse({ imported: false, mapbox_found: false, reason: 'queue_read_error' }, 500);
  }
  const summary = { drained: 0, done: 0, failed: 0, pending: 0, bumped: 0 };
  for (const row of (rows ?? []) as QueueRow[]) {
    summary.drained += 1;
    const outcome = await resolveQueueRow(row, mapboxToken, supabase);
    const next = nextQueueState(row.attempts, outcome);
    const { error: updErr } = await supabase
      .from('poi_import_queue')
      .update({ status: next.status, attempts: next.attempts, poi_id: next.poi_id, reason: next.reason, processed_at: new Date().toISOString() })
      .eq('id', row.id);
    if (updErr) console.error('[import-mapbox-poi] drain update error:', row.id, updErr);
    if (next.bump && next.poi_id !== null) {
      const { data: bumped } = await supabase.rpc('bump_poi_pick', { p_poi_id: next.poi_id });
      if (bumped) summary.bumped += 1;
    }
    summary[next.status] += 1;
  }
  console.log(`[import-mapbox-poi] drain summary drained=${summary.drained} done=${summary.done} failed=${summary.failed} pending=${summary.pending} bumped=${summary.bumped}`);
  return jsonResponse({ imported: summary.done > 0, mapbox_found: summary.drained > 0, reason: 'drain', ...summary }, 200);
}

async function resolveQueueRow(
  row: QueueRow,
  mapboxToken: string,
  supabase: ReturnType<typeof createClient>,
): Promise<DrainOutcome> {
  const features = (await queryMapbox(row.name, { lat: row.lat, lng: row.lng }, mapboxToken, 'poi'))
    .filter((f) => (f.properties?.feature_type ?? 'poi') === 'poi');
  if (features.length === 0) return { kind: 'no_match', reason: 'no_mapbox_results' };
  const match = pickBestMatch(features, row.name, { place_name: row.name, address: '', latitude: row.lat, longitude: row.lng });
  if (!match) return { kind: 'no_match', reason: 'no_good_match' };
  const feat = match.feature;
  const coords = feat.geometry?.coordinates ?? [0, 0];
  const name = feat.properties?.name ?? '';
  if (!name || !coords[0] || !coords[1]) return { kind: 'no_match', reason: 'incomplete_feature' };
  try {
    const { data, error } = await supabase.rpc('import_search_poi', {
      p_name: name,
      p_lat: coords[1],
      p_lng: coords[0],
      p_address: feat.properties?.full_address ?? feat.properties?.place_formatted ?? null,
      p_tricigo_category: mapboxCategoryToTricigo(feat.properties?.poi_category ?? feat.properties?.poi_category_ids),
      p_mapbox_id: feat.properties?.mapbox_id ?? null,
      p_phone: feat.properties?.metadata?.phone ?? null,
      p_website: feat.properties?.metadata?.website ?? null,
    });
    if (error) return { kind: 'error', reason: `rpc_error: ${error.message ?? 'unknown'}` };
    const r = data as { imported: boolean; poi_id: number | null; reason: string };
    if (r.imported && r.poi_id !== null) return { kind: 'imported', poiId: r.poi_id, reason: r.reason };
    if (r.poi_id !== null) return { kind: 'matched', poiId: r.poi_id, reason: r.reason, bump: r.reason !== 'admin_match' };
    if (r.reason === 'out_of_cuba' || r.reason === 'name_too_short' || r.reason === 'missing_coords') return { kind: 'rejected', reason: r.reason };
    return { kind: 'error', reason: r.reason };
  } catch (err) {
    return { kind: 'error', reason: `rpc_threw: ${String(err).slice(0, 120)}` };
  }
}
```
Also change the header comment block: add a paragraph "Drain mode (00584): `{ "drain": N }` with the service-role key as Bearer processes up to N pending `poi_import_queue` rows (names from real rides that matched no POI); each row → Mapbox forward (`types=poi`) → `import_search_poi` → `bump_poi_pick`; failures retry once, then `failed`."

- [ ] **Step 4: Static checks the sandbox can run**

`deno check` cannot fetch `esm.sh` here (CLAUDE.md). Instead: `node --check` is useless for TS; run `npx tsc --noEmit --strict --target es2020 --moduleResolution node --allowImportingTsExtensions --noResolve supabase/functions/import-mapbox-poi/index.ts 2>&1 | grep -v "Cannot find module\|Cannot find name 'Deno'" | head` — only the two expected remote/Deno complaints must remain. Then confirm the bundle list: `grep -c "poi-import-queue" supabase/functions/import-mapbox-poi/index.ts` = 1 and the file path `../_shared/poi-import-queue.ts` exists (the "an EF that uploads one file less" trap).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/import-mapbox-poi/index.ts
git commit -m "feat(ef): import-mapbox-poi drain mode — service-role batch over poi_import_queue with bump_poi_pick"
```

---

### Task 7: Remove the client-side fire-and-forget import (replaced by the server)

**Files:**
- Modify: `packages/utils/src/geo.ts` (delete `importPoiFromSearch`, lines ≈3540–3620, and its JSDoc), `packages/utils/src/__tests__/geo.test.ts` (delete the `describe('importPoiFromSearch (PR 4b)'…)` block, lines ≈391–475, and the import on line 15)
- Modify: `apps/client/src/components/AddressSearchInput.tsx:546`, `apps/client/src/components/WebAddressInput.tsx:472`, `apps/web/src/components/AddressAutocomplete.tsx:591` (delete the `void importPoiFromSearch(...)` line, drop the import; in `AddressAutocomplete.tsx` also drop the `_src` comment on line 27 if it only served this call)

- [ ] **Step 1: Delete and re-grep**

Run: `grep -rn "importPoiFromSearch" packages apps --include=*.ts --include=*.tsx`
Expected: no output. `mapLogger.poiSubmit` stays if any other caller uses it (`grep -rn "poiSubmit" packages apps` — if only geo.ts used it, delete the method from the logger too, plus its test).

- [ ] **Step 2: Verify**

```bash
pnpm --filter @tricigo/utils test 2>&1 | tail -4      # expected: all green (712 − the deleted cases)
pnpm check-types 2>&1 | tail -3                        # expected: 10/10
pnpm --filter client lint 2>&1 | tail -3               # expected: 0 errors (≤66 warnings baseline)
```

- [ ] **Step 3: Commit**

```bash
git add -A packages/utils apps/client/src/components apps/web/src/components
git commit -m "refactor(search): drop client-side importPoiFromSearch — rides trigger + drain worker replace it"
```

---

### Task 8: Full rehearsal, docs, push, draft PR

- [ ] **Step 1: Everything green**

```bash
supabase/tests/poi/run.sh 2>&1 | tail -3                          # failures = 0 (137 + T8 16 + T9 19 = 172)
psql -d poi_real -v fn=search_pois_smart -f supabase/tests/poi/search_suite.sql | grep -c "| t$"   # record the number
pnpm --filter @tricigo/utils test 2>&1 | tail -3
pnpm --filter @tricigo/api test 2>&1 | tail -3                    # includes the _shared drain test
pnpm check-types 2>&1 | tail -2
pnpm check:poi-taxonomy
pnpm check:i18n
git checkout HEAD -- pnpm-lock.yaml 2>/dev/null || true
```

- [ ] **Step 2: Prod pre-flight (read-only, right before the push)**

```sql
-- the 00583 patch target is still unique and the live bodies unchanged
SELECT proname, md5(prosrc) FROM pg_proc WHERE proname IN ('lookup_nearest_poi_ranked','search_pois_smart','find_nearby_poi_match');
-- expected: 0cbc8cab…, 72be4400…, 1cd4989f…
SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_rides_learn_poi_picks';   -- 0
SELECT count(*) FROM cron.job WHERE jobname = 'drain-poi-import-queue';        -- 0
```
Migration numbers: `git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3` and the files of every open PR (`pull_request_read get_files`) — 00583/00584 must still be free.

- [ ] **Step 3: CLAUDE.md** — in § "POIs — capa de curación", add two rows to the table (`search_pois_smart` v2 / `poi_import_queue` + trigger + cron) and a short "Búsqueda v2 + aprendizaje" paragraph: the DROP+CREATE reason (42P13), `name = display_name`, stop shadow rule with the 40 measured cases, the 60-query suite command, the drain gate (`Bearer <service role>` exact), and that `record_poi_pick` is wired by PR-3.

- [ ] **Step 4: Push and open the draft PR**

```bash
git push -u origin claude/poi-search-v2-ocsopo
```
PR title: `feat(poi): search v2 over the dictionary + learning from rides (00583–00584)`. Body sections: Qué es · Lo que estaba mal (medido) · Qué cambia · Evidencia (harness 172 aserciones; suite 60 + 20 controles con la tabla de fallos clasificados; latencia v1/v2; ensayo real de 00584) · Notas para aplicar (orden 00579→00584; el cron nace inactivo hasta que haya cola; deploy de la EF con `npx supabase functions deploy import-mapbox-poi --project-ref lqaufszburqvlslpcuac` — multi-file, CLI) · Paridad · footer. Then `subscribe_pr_activity`.

---

## Self-review against spec §5

- §5.1 tiers exact/prefix/substring/all-tokens/fuzzy/category → `dict.drank` + `scored.rank_quality` (Task 1). Score terms: rank×1000, generic×5000, landmark −120 / admin −60, stop +700 unless transport intent, −15×min(picks,20), +150 stale (>90 d, non-admin — measured: admin rows never re-sync), (1−conf)×30, dist ≤30, contact +8 → `filtered.score`. Stop drop when a same-name non-transport POI is ≤400 m → `filtered` WHERE. 300 m same-display collapse → `collapsed`. `p.id` tie → final ORDER BY. New columns `matched_alias, display_name, is_landmark` → return type. Performance guard → Task 2 Step 4.
- §5.2 suite of 60 + no-change controls, run before (local real data — prod cannot host the candidate until 00579 applies) and after apply (same file via MCP) → Task 2.
- §5.3 `record_poi_pick` (SECURITY DEFINER, authenticated, 60/h) → Task 3; rides trigger with `find_nearby_poi_match(…, 60)`, placeholder/corner/zone guard, queue insert → Task 4; drain mode `{drain:20}` + `cron_http_post` job every 15 min → Tasks 4/6; `import_search_poi` dedupe + geofence untouched; new rows `pick_count=1` via `bump_poi_pick` after import → Task 6; client `importPoiFromSearch` removed → Task 7.
- Deviation, deliberate: `name` returns the cleaned `display_name` (spec listed `display_name` only as an extra column) so the installed apps benefit without a rebuild; `tricigo_category` returns the effective category for the same reason. Both stated in the migration header and the PR body.
- Not in this PR (spec §6/§7): app rendering of `matched_alias`, the `record_poi_pick` call site, admin suspects tab over `poi_import_queue`.
