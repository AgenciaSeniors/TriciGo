# POI landmark footprint — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pin standing on a large curated landmark labels as the landmark, not its nearest sub-venue — via a per-row `footprint_radius_m` and effective-distance ranking in `lookup_nearest_poi_ranked`, with zero behavior change for the other ~20k POIs.

**Architecture:** One migration (00570): a curated `smallint` column on `cuba_pois` (NULL = today's behavior), a v3 of the ranking function that measures distance to the *footprint* instead of the point, and 7 hand-verified seeds. Verification is the address-campaign A/B method run read-only against prod: the candidate body executes as an inline SELECT (DDL is MCP-guarded), seeds simulated with a VALUES CTE that is semantically identical to the column.

**Tech Stack:** PostgreSQL 15 + PostGIS (geography), Supabase MCP (read-only `execute_sql` for the harness), plain SQL migration. No TypeScript changes — `pnpm check-types` is N/A because the RPC signature and return shape do not change.

**Spec:** [docs/superpowers/specs/2026-08-21-poi-landmark-footprint-design.md](../specs/2026-08-21-poi-landmark-footprint-design.md)

---

## Verified facts (from discovery — do not re-derive)

- Live `lookup_nearest_poi_ranked` == migration 00550 byte-for-byte; `md5(prosrc) = 8cb12ccd789fb1e0d8a9efdaceaf73de`, `length = 1218`.
- Consumers: `packages/utils/src/geo.ts:1718` (anon REST, radius 30, prepends POI only when `distance_m <= 20`) and `resolve_point_address` (00539, radius 120, uses `name` only). Legacy fallback `nearest_poi` untouched.
- Only writer of `cuba_pois` is the `import_search_poi` RPC (INSERT-only dedup, called by EF `import-mapbox-poi`). No `.from('cuba_pois')` writer in apps/packages → the new column cannot be clobbered.
- Next free migration number: **00570** (master ends at 00568; open PR #965 claims 00569).
- Seed anchors and their neighbor dumps: see spec §3. Key survivors that must keep winning at their own points: Pastelería Francesa (25.1 m from Inglaterra), Gabinete de Patrimonio Musical Esteban Salas (13.3 m from Ambos Mundos), Parque Céspedes SCU (20.8 m from Casagranda), Fonda La Paila (39.5 m from Habana Libre), Casa Jorge y Mercedes + Parque Central Airport Bus Stop (47.9/46.7 m from Kempinski), La Xana + Bodeguita del Medio Cuba (25.3/25.4 m from Iberostar Selection PC).

### Seeds

| # | name (`is_admin`, conf 1) | r (m) | point (lat, lng) |
|---|---|---|---|
| 1 | Gran Hotel Manzana Kempinski | 35 | 23.137774, -82.357952 |
| 2 | Hotel Nacional de Cuba | 40 | 23.143497, -82.380749 |
| 3 | Hotel Habana Libre | 35 | 23.139337, -82.382257 |
| 4 | Iberostar Selection Parque Central | 25 | 23.138571, -82.358660 |
| 5 | Hotel Inglaterra | 15 | 23.137491, -82.359353 |
| 6 | Hotel Casagranda | 12 | 20.021282, -75.829240 |
| 7 | Hotel Ambos Mundos | 10 | 23.139356, -82.350555 |

---

## Task 1: Pre-flight against prod (read-only)

**Files:** none (MCP queries; results recorded in this plan's Results section)

- [x] **Step 1: Drift guard + seed identity.** Run via `execute_sql`:

```sql
SELECT (md5(p.prosrc) = '8cb12ccd789fb1e0d8a9efdaceaf73de') AS fn_unchanged
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='lookup_nearest_poi_ranked';

SELECT id, name, round(ST_Y(location::geometry)::numeric,6) AS lat,
       round(ST_X(location::geometry)::numeric,6) AS lng,
       (SELECT count(*) FROM cuba_pois d WHERE d.name = c.name AND d.is_admin) AS admins_same_name
FROM cuba_pois c
WHERE is_admin AND is_active AND name IN (
  'Gran Hotel Manzana Kempinski','Hotel Nacional de Cuba','Hotel Habana Libre',
  'Iberostar Selection Parque Central','Hotel Inglaterra','Hotel Casagranda','Hotel Ambos Mundos')
ORDER BY name;
```

Expected: `fn_unchanged = true`; 7 rows, every `admins_same_name = 1`, coords match the table above. If any check fails → STOP, re-derive from live state.

- [x] **Step 2: Survivor + control coordinates.** Fetch the exact points for the survivor venues (names in Verified facts) and the 00550 control POIs (`La Esquina De Oro`, `Playa Plaza Caracol`, Trinidad's `Parque Cespedes` conf 0.982978 + `Iberostar Grand Trinidad` admin). Record them in Results for use in Tasks 2/4.

## Task 2: RED — reproduce the bug against the LIVE function

**Files:** none (harness)

- [x] **Step 1: Named pins vs live.** Three Manzana pins (computed from seed/sub-venue points): MZ-1 ≈ (23.137906, -82.357799) — 6 m N of Rooftop's point; MZ-2 = Rooftop's exact point (23.137852, -82.357799); MZ-3 = 30 m E of the seed point. Plus each survivor pin (the venue's own point) and the 3 controls (Trinidad pin = `ST_Project(park, 7, ST_Azimuth(park→hotel))`; the other two at their POI's point +4 m). For each: `SELECT * FROM lookup_nearest_poi_ranked(lat, lng, 30)`.

Expected (RED): MZ-1/MZ-2 → a sub-venue ("Rooftop Pool & Bar"), NOT the Kempinski; MZ-3 → sub-venue; survivors → themselves; controls → the 00550 winners. Record the table.

## Task 3: Write migration 00570

**Files:**
- Create: `supabase/migrations/00570_poi_landmark_footprint.sql`

- [x] **Step 1: Write the file** with this exact content (the `MEDIDO` block in the header is completed in Task 5; seed ids come from Task 1):

```sql
-- ============================================================
-- Migration 00570: huella (footprint) para landmarks curados —
--                  el pin parado SOBRE un landmark grande debe decir el
--                  landmark, no su sub-local más cercano
--
-- WHY (medido contra prod, 2026-08-21):
--   Pin en el centro de la Manzana de Gómez → "Rooftop Pool & Bar"
--   (no-admin, 11.6 m) le gana a "Gran Hotel Manzana Kempinski" (is_admin,
--   confidence 1, ~23 m). El hotel es una cuadra entera representada por UN
--   punto; sus amenities llevan puntos propios más cercanos. Con las bandas
--   de 10 m de 00550, el sub-local cae en banda 1 y el landmark en banda 2 —
--   is_admin solo desempata DENTRO de una banda.
--
--   Restricciones medidas antes (NO re-derivar):
--   * Un bonus global de distancia para admins regresiona el control de
--     00550: Parque Céspedes (7 m, no-admin) debe seguir ganándole a
--     Iberostar Grand Trinidad (25 m, admin conf 1). Una constante no puede
--     codificar "algunos landmarks son cuadras, otros edificios comunes".
--   * "Suprimir hoteles no-admin a <=60 m de un hotel admin" fue medido
--     plataforma-wide: 721 suprimidos, la muestra eran casas particulares
--     vecinas legítimas. PROHIBIDO revivirla.
--
-- WHAT THIS DOES:
--   1. cuba_pois.footprint_radius_m (smallint, NULL = sin huella = compor-
--      tamiento actual). Solo filas is_admin, tope duro 60 m (CHECK). Radio
--      válido ssi el círculo cae ÍNTEGRO en la propiedad del landmark: ahí
--      cualquier otro punto es un amenity propio o basura mal geocodificada
--      (los landmarks famosos son imanes de basura: "Estadio Latinoamericano"
--      a 9.8 m del Hotel Nacional).
--   2. lookup_nearest_poi_ranked v3: la distancia pasa a ser EFECTIVA
--      (GREATEST(0, cruda - huella)) en el gather, en las bandas, en el orden
--      y en el distance_m DEVUELTO — esto último es load-bearing: el cliente
--      solo antepone el POI si distance_m <= 20 (POI_INCLUSION_THRESHOLD_M).
--      Pin dentro de la huella => landmark en banda 0 => is_admin le gana el
--      empate a cualquier sub-local pegado al pin. Desempate final nuevo por
--      distancia CRUDA (determinista: dos admins con efectiva 0 resuelven al
--      punto más cercano, p.ej. Hotel Nacional r=40 vs su propio Cabaret Le
--      Parisien a 30 m dentro).
--   3. 7 semillas curadas y verificadas una a una contra el vecindario real
--      (ver tabla). NO sembradas, con causa: Brisas Guardalavaca (hostales a
--      19-22 m del punto = patrón de la lección-721), "Parque Central" admin
--      (punto mal ubicado: a 7.5 m del hotel Iberostar, no en el parque),
--      Iberostar Grand Trinidad (caso de control + vecindario basural).
--
-- MEDIDO (candidata inline vs viva, prod read-only, 2026-08-21):
--   __RESULTS__
--
-- WHAT STAYS: firma, columnas devueltas, radio por defecto (30 m),
--   is_active, tricigo_category IS NOT NULL, LIMIT 1, bandas de 10 m,
--   is_admin/confidence como desempate. Consumidores sin cambio:
--   packages/utils/src/geo.ts (lookupNearestPoi) y resolve_point_address
--   (00539). El único writer de cuba_pois (import_search_poi) es INSERT-only:
--   no puede pisar la columna.
-- ============================================================

ALTER TABLE public.cuba_pois ADD COLUMN IF NOT EXISTS footprint_radius_m smallint;

DO $$
BEGIN
  ALTER TABLE public.cuba_pois ADD CONSTRAINT cuba_pois_footprint_radius_chk
    CHECK (footprint_radius_m IS NULL
           OR (is_admin AND footprint_radius_m BETWEEN 1 AND 60));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE '00570: constraint ya existe; nada que hacer';
END $$;

COMMENT ON COLUMN public.cuba_pois.footprint_radius_m IS
  '00570: huella curada del landmark (m). Solo filas is_admin; NULL = sin '
  'huella. Criterio: el círculo debe caer ÍNTEGRO en la propiedad del '
  'landmark (verificar el vecindario antes de sembrar — ver migración). '
  'Tope 60 acoplado al prefiltro constante de lookup_nearest_poi_ranked.';

CREATE OR REPLACE FUNCTION public.lookup_nearest_poi_ranked(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer DEFAULT 30
)
RETURNS TABLE(name text, category text, distance_m double precision)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    p.name,
    p.category,
    -- 00570: distancia EFECTIVA a la huella del landmark, no a su punto.
    -- Filas sin huella: idéntica a la cruda. Devolverla efectiva es
    -- load-bearing: el cliente solo antepone el POI si distance_m <= 20
    -- (POI_INCLUSION_THRESHOLD_M en packages/utils/src/geo.ts).
    GREATEST(
      ST_Distance(
        p.location,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) - (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END),
      0
    ) AS distance_m
  FROM cuba_pois p
  WHERE p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p.is_active = true
    -- 00570: prefiltro CONSTANTE para que el índice GIST siga sirviendo
    -- (60 = tope del CHECK de footprint_radius_m — mantener acoplados).
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m + 60
    )
    -- 00570: un landmark califica si su HUELLA toca el círculo de búsqueda.
    -- Filas sin huella: predicado idéntico al de 00550.
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m + (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END)
    )
    -- 00550: el vocabulario normalizado (poblado al 100 %), no la lista
    -- blanca de categorías crudas estilo OSM.
    AND p.tricigo_category IS NOT NULL
  ORDER BY
    -- 00550: la distancia manda, en bandas de 10 m; is_admin y confidence
    -- desempatan dentro de la banda. 00570: la distancia que banda es la
    -- EFECTIVA — un pin dentro de la huella pone al landmark en banda 0.
    floor(GREATEST(
      ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
      - (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END), 0) / 10),
    p.is_admin DESC,
    p.confidence DESC NULLS LAST,
    GREATEST(
      ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
      - (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END), 0),
    -- 00570: desempate final DETERMINISTA por distancia cruda.
    ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.lookup_nearest_poi_ranked(double precision, double precision, integer) IS
  '00570: lugar reconocible más cercano a un punto, para anteponerlo a la '
  'dirección. v3: distancia EFECTIVA a la huella curada del landmark '
  '(footprint_radius_m, solo is_admin) — un pin parado sobre la Manzana de '
  'Gómez dice Kempinski, no Rooftop Pool & Bar. Sin huella (NULL, todas las '
  'filas salvo las curadas) el comportamiento es idéntico a 00550.';

-- Semillas: una a una, ancladas a id+name+is_admin para que una fila
-- movida en prod convierta el UPDATE en no-op contado, nunca en mis-hit.
DO $$
DECLARE
  v_n int;
  v_total int := 0;
BEGIN
  UPDATE public.cuba_pois SET footprint_radius_m = 35
    WHERE id = __ID1__ AND name = 'Gran Hotel Manzana Kempinski' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  UPDATE public.cuba_pois SET footprint_radius_m = 40
    WHERE id = __ID2__ AND name = 'Hotel Nacional de Cuba' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  UPDATE public.cuba_pois SET footprint_radius_m = 35
    WHERE id = __ID3__ AND name = 'Hotel Habana Libre' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  UPDATE public.cuba_pois SET footprint_radius_m = 25
    WHERE id = __ID4__ AND name = 'Iberostar Selection Parque Central' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  UPDATE public.cuba_pois SET footprint_radius_m = 15
    WHERE id = __ID5__ AND name = 'Hotel Inglaterra' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  UPDATE public.cuba_pois SET footprint_radius_m = 12
    WHERE id = __ID6__ AND name = 'Hotel Casagranda' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  UPDATE public.cuba_pois SET footprint_radius_m = 10
    WHERE id = __ID7__ AND name = 'Hotel Ambos Mundos' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RAISE NOTICE '00570: % de 7 semillas de huella aplicadas', v_total;
  IF v_total < 7 THEN
    RAISE WARNING '00570: % semillas NO matchearon (fila movida/renombrada en prod) — curar a mano', 7 - v_total;
  END IF;
END $$;
```

Replace `__ID1__`…`__ID7__` with the ids from Task 1 and leave `__RESULTS__` for Task 5.

## Task 4: GREEN — candidate A/B on the named pins

**Files:** none (harness)

- [x] **Step 1: Candidate inline.** Same pins as Task 2, evaluated with the candidate body where the column is simulated by a CTE (semantically identical — only these 7 admin rows would have non-NULL):

```sql
WITH seeds(id, r) AS (VALUES (__ID1__,35),(__ID2__,40),(__ID3__,35),(__ID4__,25),(__ID5__,15),(__ID6__,12),(__ID7__,10)),
pins(label, lat, lng, radius) AS (VALUES ('MZ-1', 23.137906, -82.357799, 30), /* … all named pins … */)
SELECT p.label, live.name AS live_name, cand.name AS cand_name,
       round(live.distance_m::numeric,1) AS live_d, round(cand.distance_m::numeric,1) AS cand_d
FROM pins p
LEFT JOIN LATERAL (SELECT * FROM public.lookup_nearest_poi_ranked(p.lat, p.lng, p.radius)) live ON true
LEFT JOIN LATERAL (
  SELECT cp.name, cp.category,
         GREATEST(ST_Distance(cp.location, g.pt) - CASE WHEN cp.is_admin THEN COALESCE(s.r,0) ELSE 0 END, 0) AS distance_m
  FROM (SELECT ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography AS pt) g
  CROSS JOIN cuba_pois cp
  LEFT JOIN seeds s ON s.id = cp.id
  WHERE cp.is_active AND cp.tricigo_category IS NOT NULL
    AND ST_DWithin(cp.location, g.pt, p.radius + 60)
    AND ST_DWithin(cp.location, g.pt, p.radius + CASE WHEN cp.is_admin THEN COALESCE(s.r,0) ELSE 0 END)
  ORDER BY floor(GREATEST(ST_Distance(cp.location, g.pt) - CASE WHEN cp.is_admin THEN COALESCE(s.r,0) ELSE 0 END, 0) / 10),
           cp.is_admin DESC, cp.confidence DESC NULLS LAST,
           GREATEST(ST_Distance(cp.location, g.pt) - CASE WHEN cp.is_admin THEN COALESCE(s.r,0) ELSE 0 END, 0),
           ST_Distance(cp.location, g.pt)
  LIMIT 1
) cand ON true
ORDER BY p.label;
```

Expected (GREEN): MZ-1/2/3 → `cand_name = 'Gran Hotel Manzana Kempinski'`, `cand_d = 0.0`; every survivor pin and every control pin → `cand_name = live_name`. Also re-run MZ-1 with radius 120 (the `resolve_point_address` path) → Kempinski.

## Task 5: Sweeps — blast radius, national no-change, performance

**Files:**
- Modify: `supabase/migrations/00570_poi_landmark_footprint.sql` (fill `__RESULTS__`)
- Modify: this plan (Results section)

- [x] **Step 1: Per-seed grid.** For each seed: 9×9 grid, 15 m pitch (±60 m), pins via chained `ST_Project`. Diff candidate vs live. Assert: every diff's `cand_name` == the seed's name; diffs at raw pin-to-seed distance > r+30 = 0. Eyeball the diff list — every swallowed old winner must be an own-amenity or garbage (spec §3 dumps).
- [x] **Step 2: National sweep.** Stratified: up to 40 active POIs per province (`row_number() OVER (PARTITION BY province ORDER BY md5(id::text))`), deterministic jitter ±20 m from `hashtext(id::text)`, radius 30; subset (rn ≤ 12) also at 120. Split into 2 batches (provinces A–L / M–Z). Assert: 0 diffs outside seeded footprints; diffs inside them only Kempinski-class (winner == seed).
- [x] **Step 3: Performance.** `EXPLAIN (ANALYZE, BUFFERS)` live vs candidate on a hot Habana pin, ≥3 alternated warm runs each; candidate must keep the GIST index (prefilter) and stay within ~2× of live's execution time. (Indicative only — the post-apply plan with the real column is authoritative.)
- [x] **Step 4: Record.** Fill `__RESULTS__` in the migration header (counts per suite, the Manzana before/after row, survivor confirmations, timings) and mirror the tables into this plan's Results section.

## Task 6: Verify, commit, PR

- [x] **Step 1: Re-check migration number** (sessions run in parallel):

```bash
git fetch origin master --quiet && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort | tail -3
gh pr list --state open --json number --jq '.[].number' | while read n; do gh pr view $n --json files -q '.files[].path' | grep -i migration; done
```

Expected: nothing claims 00570 besides this branch.

- [x] **Step 2: Commit** migration + plan updates:

```bash
git add supabase/migrations/00570_poi_landmark_footprint.sql docs/superpowers/plans/2026-08-21-poi-landmark-footprint.md docs/superpowers/specs/2026-08-21-poi-landmark-footprint-design.md
git commit -m "feat(geo): curated landmark footprints for POI reverse geocoding"
```

- [x] **Step 3: PR** (body via `--body-file .pr-body-temp.md`, then delete the temp file). Body must include: the measured tables, the cross-app parity answers (no UI change on any surface; RPC signature/return unchanged; client `POI_INCLUSION_THRESHOLD_M` gate now receives effective distance — that is the fix's delivery vehicle, not a change to the client), the not-seeded list with reasons, and the standard note: **"Migración NO aplicada a prod (MCP guard); el comportamiento actual queda intacto hasta el apply. Post-apply: re-correr la suite de pines nombrados vía la función real + EXPLAIN del plan con la columna."**

## Post-apply runbook (gated — requires explicit per-step authorization)

1. `mcp__apply_migration` of 00570 (AskUserQuestion pattern per CLAUDE.md).
2. Re-run Task 2's named-pin suite via the real function → Manzana pins say Kempinski with `distance_m = 0`.
3. `EXPLAIN (ANALYZE)` one call → GIST index on `cuba_pois.location` still used.
4. Confirm the seed NOTICE printed `7 de 7`.

## Results (filled during execution)

**Amendments made while executing (the spec and migration 00570 are canonical
for the final values):**
- Radii were re-derived **three times**, each tightening driven by a measured
  flip class the suites caught: (1) `r=25` on Iberostar PC flipped La Xana's
  own pin (25.3 m, band math: flips iff `dist − r < 10`); (2) `r=12` on
  Inglaterra flipped a pin 6.3 m from Pastelería Francesa's door → final rule
  `r ≤ dist(nearest genuine) − 15`, influence zone `r+10` must fit the
  landmark's physical body + own sidewalk. Final: Kempinski 30, Nacional 40,
  Habana Libre 23, Iberostar PC 8, Inglaterra 10, Casagranda 5.
- **Hotel Ambos Mundos dropped as a seed**: its only sub-venue (rooftop,
  6.8 m) always shares the landmark's band, so `is_admin` already wins today
  — no bug to fix; any useful radius endangers the Gabinete at 13.3 m.
- **`p.id` added as the ultimate ORDER BY tiebreaker**: the national sweeps
  exposed pre-existing nondeterminism — POI pairs stacked at 0.00 m with
  equal confidence ("Dunkin donuts"/"Yamato hibachi", "Temple Beth
  Shalom"/"Bucky's") resolve by plan, not by data; live even returned
  different members of the same tied pile at radius 30 vs 120.

**Suite results (candidate inline vs live, prod read-only, 2026-08-21):**

| Suite | Result |
|---|---|
| 4 Manzana pins (centre, Rooftop's point, 30 m edge, centre@120) | live: "Rooftop Pool & Bar" on all 4; candidate: "Gran Hotel Manzana Kempinski" `distance_m=0.0` on all 4 |
| 3 controls of 00550 (Parque Céspedes/Trinidad 7.0 m, La Esquina De Oro 3.9 m, Playa Plaza Caracol 0.0 m) | identical live=candidate |
| 10 survivor pins incl. door-proximity (6.3 m from Pastelería, 4.9 m from Bodeguita) | identical live=candidate |
| Per-seed 9×9 grid, 15 m pitch (486 pins) | 139 diffs — 100 % won by a seed, 0 beyond the `r+40` halo; swallowed = own amenities + mis-geocoded garbage |
| National sweep radius 30 (1,674 pins, all provinces, deterministic ±20 m jitter) | 6 diffs, ALL pre-existing exact ties (stacked 0.00 m pairs, equal confidence); 0 seed-related |
| National sweep radius 120 (676 pins) | 5 diffs, same stacked-tie class; 0 seed-related |
| EXPLAIN ANALYZE, warm, 3 alternated runs | candidate 72.4/67.5/66.9 ms vs live 67.4/102.0/117.5 ms — parity within noise; GIST index kept (constant 90 m prefilter, 29 rows gathered → 4 final) |
