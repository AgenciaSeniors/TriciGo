-- ============================================================
-- Migration 00544: search_streets v7 — accent-insensitive matching + speed
--
-- WHY (two defects, both measured against prod, not inferred):
--
--   A. THE SEARCH RETURNS A DIFFERENT STREET ~1.8 km AWAY.
--      A rider reported that picking up at "Callejón de los Protestantes"
--      produced a pickup ~1.5 km away. Reproduced exactly:
--
--        search_streets('callejon de los protestantes', 23.1136, -82.3666, 8)
--          #1  Calle G (Avenida de los Presidentes)  23.1303422,-82.3827113
--          #4  Callejón de los Protestantes          23.1200064,-82.3964616
--        → 1814.9 m apart. Typing the accent made the Callejón #1.
--
--      Cause: v6 built match_rank and the candidate WHERE with RAW ILIKE and
--      no unaccent, so
--          'Callejón de los Protestantes' ILIKE '%callejon…%'  → FALSE
--          unaccent(...)                  ILIKE '%callejon…%'  → TRUE
--      On a phone keyboard 'ó' needs a long-press, so riders type "callejon".
--      The exact street then collapsed from match_rank 0 to 4 — the same
--      bucket as pure trigram noise, e.g.
--          similarity('Avenida de los Presidentes (Calle G)',
--                     'callejon de los protestantes') = 0.370
--      — and with the ranks tied, PLAIN DISTANCE decided. Calle G at 2482 m
--      beat the real street at 3140 m. That is the whole bug, and it is why
--      it was intermittent: it only bites when the name carries an accent AND
--      some trigram false positive happens to sit closer.
--
--   B. 11,359 ms PER CALL. Measured cost of ONE full pass over the
--      381,951-row table:
--        _street_display_name(main_street)  (regex)   2729 ms
--        ST_Distance(geog, geog)            spheroid  3775 ms
--        ST_Distance(geog, geog, false)     sphere     240 ms
--        similarity(main_street, q)                    750 ms (parallel)
--      v6 evaluated _street_display_name ~5x per row (WHERE, both CASE
--      ladders, DISTINCT ON, ORDER BY) and similarity 2x per row, neither of
--      which is index-accelerated, plus a spheroid distance per row. The
--      client runs this inside a Promise.all next to the Google and POI
--      searches, so the whole dropdown blocked on it — which is the other
--      half of the user's report ("a veces la app falla al buscar"). For
--      scale: get_nearest_cross_streets = 174 ms, search_pois_smart = 234 ms.
--
-- THE STRUCTURAL INSIGHT:
--   main_street has only 12,476 DISTINCT values across 381,951 rows. Every
--   accent, regex and trigram operation belongs on those 12,476 names.
--
-- WHAT THIS DOES:
--   1. public.street_search_names — one row per distinct main_street with the
--      accent-stripped and alias-extracted forms PRECOMPUTED, kept in sync by
--      a statement-level trigger. Deliberately allowed to be a SUPERSET: a
--      name whose rows were all deleted simply finds no intersections and
--      disappears in the LATERAL, so only a MISSING name would be a bug and
--      the INSERT/UPDATE trigger prevents those. Hence no DELETE trigger.
--   2. Matching is accent-insensitive BOTH WAYS — query and street name are
--      each lower(unaccent(...)) before comparison — for the substring
--      ladder, the WHERE filter and the trigram calls alike.
--   3. A covering index makes "nearest intersection for this street name" an
--      INDEX-ONLY scan. Measured on 4,419 candidate names for the query 'ca':
--      6052 ms via the plain btree (heap fetch per row) vs ~40 ms index-only.
--      This index is load-bearing, not a nicety.
--   4. Distance switches to use_spheroid => false (15.7x, +0.33% drift).
--   5. ORDER BY gains a leading tier key so a trigram-only match can never
--      outrank a real substring/exact match that is merely farther away.
--
-- NOTE ON unaccent AND INDEXES — the trap this migration walks around:
--   public.unaccent(text) AND public.unaccent(regdictionary, text) are BOTH
--   provolatile='s' (STABLE) here, so neither may appear in an index
--   expression or a GENERATED column. The usual workaround — wrapping it in
--   a function falsely marked IMMUTABLE — lies to the planner and silently
--   corrupts the index if the unaccent rules ever change. This migration
--   avoids the question entirely: the normalized text lives in ORDINARY
--   columns filled by a trigger (triggers may call STABLE functions).
--
-- WHY NO GIN TRIGRAM INDEX ON THE DICTIONARY:
--   The WHERE ORs a LIKE with similarity() > 0.30, and similarity() is not
--   index-accelerated (only the % operator, which depends on the
--   pg_trgm.similarity_threshold GUC). The OR forces a scan of the
--   dictionary either way — measured at ~140 ms for all 12,476 rows, which
--   is an acceptable share of the budget. Keeping similarity() > 0.30
--   preserves v6's exact semantics with no GUC dependency and no
--   plan-cache surprises. If phase 1 ever needs to be faster, switching to
--   % plus two GIN indexes is a self-contained follow-up.
--
-- WHAT STAYS:
--   - Signature and return columns byte-identical (name, address, latitude,
--     longitude, municipality, province, distance_m) — called via PostgREST
--     from packages/utils/src/geo.ts.
--   - _street_full_display for the address (main AND cross),
--     _street_display_name for the name, dedupe by normalized display name,
--     the 25/100/300 km proximity buckets, the length<2 guard, the wildcard
--     escape, the 1..25 clamp on max_results.
--   - NULL lat/lng stays supported (geo.ts passes null rather than
--     defaulting to Havana): distances come back NULL, everything lands in
--     bucket 3, and the list is ranked on text alone.
--   - SET search_path TO 'public','extensions','pg_catalog' — the live
--     function carries this from the search_path hardening work and
--     CREATE OR REPLACE would otherwise drop it.
--
-- NOT CONCURRENTLY: the Supabase CLI runs each migration in a transaction and
--   CREATE INDEX CONCURRENTLY cannot run inside one. The covering index takes
--   a ShareLock on street_intersections: reads and this RPC keep working,
--   only WRITES block, and the only writer is the offline
--   scripts/populate-cross-streets.mjs. Expect ~2-6 s. Every CREATE INDEX is
--   IF NOT EXISTS, so building it beforehand with CONCURRENTLY makes these
--   no-ops. Do not apply while that importer is running.
-- ============================================================


-- ─────────────────────────────────────────────────────────────────
-- 1. Name dictionary — 12,476 rows standing in for 381,951
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.street_search_names (
  main_street  TEXT PRIMARY KEY,
  -- _street_display_name(main_street): the Cuban popular alias when the OSM
  -- name carries one ("Padre Varela (Belascoaín)" → "Belascoaín"), else the
  -- name itself.
  display_name TEXT NOT NULL,
  -- lower(unaccent(main_street)) — the accent-insensitive match surface.
  norm_raw     TEXT NOT NULL,
  -- lower(unaccent(display_name)). NOT redundant with norm_raw for the fuzzy
  -- branch: for the typo 'belascoian',
  --   similarity('padre varela (belascoain)', 'belascoian') = 0.259  (miss)
  --   similarity('belascoain',                'belascoian') = 0.467  (hit)
  -- It is also exactly _street_normalize_key(display_name), so it doubles as
  -- the dedupe key and there is no separate norm_key column.
  norm_disp    TEXT NOT NULL
);

COMMENT ON TABLE public.street_search_names IS
  '00544 - One row per distinct street_intersections.main_street (12,476 vs 381,951 rows) with the accent-stripped and alias-extracted forms precomputed, so search_streets does all text matching over 12k rows instead of 382k. Trigger-maintained; deliberately a superset (a stale name finds no intersections and vanishes in the join), so only a MISSING name would be a bug.';

COMMENT ON COLUMN public.street_search_names.norm_raw IS
  '00544 - lower(unaccent(main_street)). An ordinary column, not GENERATED: unaccent is STABLE on this database and may not appear in an index or generated-column expression. Filled by _street_search_names_sync().';

COMMENT ON COLUMN public.street_search_names.norm_disp IS
  '00544 - lower(unaccent(display_name)). Doubles as the dedupe key: it is identical to _street_normalize_key(display_name).';

-- Read-only for clients, mirroring street_intersections_read (00088). Nothing
-- here that is not already public in street_intersections, but note this does
-- become visible through PostgREST as /rest/v1/street_search_names.
ALTER TABLE public.street_search_names ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "street_search_names_read" ON public.street_search_names;
CREATE POLICY "street_search_names_read"
  ON public.street_search_names
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON public.street_search_names TO anon, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 2. Dictionary sync
-- ─────────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER on purpose: street_intersections has only a SELECT policy
-- (00088), so anon/authenticated cannot insert into it at all. The only
-- writers are the service role and migrations, both of which bypass RLS, and
-- the trigger's INSERT inherits that.

CREATE OR REPLACE FUNCTION public._street_search_names_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.street_search_names
    (main_street, display_name, norm_raw, norm_disp)
  SELECT DISTINCT
    n.main_street,
    public._street_display_name(n.main_street),
    lower(unaccent(n.main_street)),
    lower(unaccent(public._street_display_name(n.main_street)))
  FROM new_rows n
  WHERE n.main_street IS NOT NULL
  ON CONFLICT (main_street) DO NOTHING;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public._street_search_names_sync IS
  '00544 - Statement-level trigger keeping street_search_names a superset of the distinct main_street values. Uses a transition table so a 500-row importer batch costs one INSERT, not 500.';

DROP TRIGGER IF EXISTS trg_street_search_names_ins ON public.street_intersections;
CREATE TRIGGER trg_street_search_names_ins
  AFTER INSERT ON public.street_intersections
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public._street_search_names_sync();

DROP TRIGGER IF EXISTS trg_street_search_names_upd ON public.street_intersections;
CREATE TRIGGER trg_street_search_names_upd
  AFTER UPDATE OF main_street ON public.street_intersections
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public._street_search_names_sync();

-- Backfill. DO UPDATE rather than DO NOTHING so re-applying this migration
-- after one of the helpers changes actually refreshes the normalized forms.
INSERT INTO public.street_search_names
  (main_street, display_name, norm_raw, norm_disp)
SELECT DISTINCT
  si.main_street,
  public._street_display_name(si.main_street),
  lower(unaccent(si.main_street)),
  lower(unaccent(public._street_display_name(si.main_street)))
FROM public.street_intersections si
WHERE si.main_street IS NOT NULL
ON CONFLICT (main_street) DO UPDATE
SET display_name = EXCLUDED.display_name,
    norm_raw     = EXCLUDED.norm_raw,
    norm_disp    = EXCLUDED.norm_disp;

ANALYZE public.street_search_names;


-- ─────────────────────────────────────────────────────────────────
-- 3. Covering index — the single biggest win
-- ─────────────────────────────────────────────────────────────────
--
-- Phase 2 needs exactly main_street, id and intersection_point. With all
-- three in one index the LATERAL is an INDEX-ONLY scan and never touches the
-- 96 MB heap. Measured for the query 'ca' (4,419 candidate names, ~21 rows
-- each): 6052 ms with idx_street_intersections_main (Index Scan + heap
-- fetch) vs ~40 ms index-only.

CREATE INDEX IF NOT EXISTS idx_street_intersections_main_covering
  ON public.street_intersections (main_street, id)
  INCLUDE (intersection_point);

COMMENT ON INDEX public.idx_street_intersections_main_covering IS
  '00544 - Covering index for search_streets phase 2: makes "nearest intersection for this street name" an index-only scan. Do NOT drop it believing idx_street_intersections_main is equivalent — that one lacks intersection_point, which is exactly what forces the heap fetch (6052 ms vs 40 ms measured).';


-- ─────────────────────────────────────────────────────────────────
-- 4. search_streets v7
-- ─────────────────────────────────────────────────────────────────

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

  -- NULL lat/lng is a supported call (geo.ts passes null rather than
  -- defaulting to Havana): ST_MakePoint returns NULL, every distance is NULL,
  -- every row lands in bucket 3, and the list is ranked on text alone.
  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;

  -- Normalize FIRST, escape SECOND. Both sides of every comparison below are
  -- lower(unaccent(...)), which is what makes matching symmetric: 'callejon'
  -- finds 'Callejón' and 'Callejón' finds 'callejon'. This is defect A.
  v_qnorm := lower(unaccent(trim(query)));
  v_esc   := replace(replace(replace(v_qnorm, '\', '\\'), '%', '\%'), '_', '\_');
  v_like  := '%' || v_esc || '%';
  v_limit := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);

  -- Trigram tolerance is meaningless below 4 characters (any short string
  -- shares trigrams with hundreds of names) and costs two similarity() calls
  -- on every dictionary row. Gating it keeps the shortest queries a pure
  -- double-LIKE. Trade-off: 2-3 character queries lose fuzzy-only hits
  -- (measured: 'ca' loses 3 names). Revert by setting v_fuzzy := true.
  v_fuzzy := length(v_qnorm) >= 4;

  RETURN QUERY
  -- PHASE 1 — text matching over 12,476 precomputed names. No regex, no
  -- unaccent, no distance. ~140 ms for the full dictionary scan.
  WITH cand AS (
    SELECT
      n.main_street,
      n.display_name,
      n.norm_disp,
      -- Same four-step ladder as v6, now on normalized text. v6's rank-0 test
      -- was "ILIKE <fully escaped literal>", i.e. equality; on normalized
      -- text plain = is the same thing and cheaper.
      LEAST(
        CASE
          WHEN n.norm_raw = v_qnorm                  THEN 0
          WHEN n.norm_raw LIKE v_esc || '%'          THEN 1
          WHEN n.norm_raw LIKE '% ' || v_esc || '%'  THEN 2
          WHEN n.norm_raw LIKE v_like                THEN 3
          ELSE 4
        END,
        CASE
          WHEN n.norm_disp = v_qnorm                 THEN 0
          WHEN n.norm_disp LIKE v_esc || '%'         THEN 1
          WHEN n.norm_disp LIKE '% ' || v_esc || '%' THEN 2
          WHEN n.norm_disp LIKE v_like               THEN 3
          ELSE 4
        END
      ) AS match_rank,
      -- Evaluated only for rows that survive the WHERE (projection runs after
      -- filtering), so this costs candidates x 2, not 12,476 x 2.
      GREATEST(
        similarity(n.norm_raw,  v_qnorm),
        similarity(n.norm_disp, v_qnorm)
      ) AS sim
    FROM public.street_search_names n
    WHERE n.norm_raw  LIKE v_like
       OR n.norm_disp LIKE v_like
       OR (v_fuzzy AND (similarity(n.norm_raw,  v_qnorm) > 0.30
                     OR similarity(n.norm_disp, v_qnorm) > 0.30))
  ),

  -- PHASE 2 — nearest intersection per candidate name. Selecting exactly id +
  -- intersection_point keeps this an index-only scan on
  -- idx_street_intersections_main_covering. Adding ANY other column here
  -- (cross_street_1, municipality, ...) forces a heap fetch per row and costs
  -- two orders of magnitude; those are fetched in phase 3 for the <=25 rows
  -- that actually get returned.
  nearest AS (
    SELECT
      c.display_name,
      c.norm_disp,
      c.match_rank,
      c.sim,
      x.id,
      x.dist
    FROM cand c
    CROSS JOIN LATERAL (
      SELECT
        si.id,
        ST_Distance(si.intersection_point, v_user_point, false) AS dist
      FROM public.street_intersections si
      WHERE si.main_street = c.main_street
      ORDER BY ST_Distance(si.intersection_point, v_user_point, false) NULLS LAST,
               si.id
      LIMIT 1
    ) x
  ),

  -- Dedupe by normalized display name, as v6 did. Equivalent to v6's
  -- DISTINCT ON over every intersection row: the minimum over names of the
  -- minimum over rows is the minimum over rows. si.id breaks ties so a
  -- NULL-proximity search is reproducible instead of arbitrary.
  best AS (
    SELECT DISTINCT ON (nr.norm_disp)
      nr.display_name, nr.match_rank, nr.sim, nr.id, nr.dist
    FROM nearest nr
    ORDER BY nr.norm_disp, nr.dist NULLS LAST, nr.id
  ),

  ranked AS (
    SELECT b.display_name, b.match_rank, b.sim, b.id, b.dist
    FROM best b
    ORDER BY
      -- (1) NEW. Fuzzy-only hits form a strictly lower tier, so a trigram
      -- coincidence can never outrank a real substring/exact match that is
      -- merely farther away. This is the ordering half of defect A:
      -- 'Callejón de los Protestantes' (rank 0, 3140 m) now beats 'Calle G'
      -- (rank 4, sim 0.370, 2482 m) instead of losing to it.
      CASE WHEN b.match_rank >= 4 THEN 1 ELSE 0 END,
      -- (2) Proximity buckets, unchanged from 00330 — still what pushes
      -- far-province results down, now applied within each tier.
      CASE
        WHEN b.dist <= 25000  THEN 0
        WHEN b.dist <= 100000 THEN 1
        WHEN b.dist <= 300000 THEN 2
        ELSE 3
      END,
      -- (3) Match quality, unchanged.
      b.match_rank,
      -- (4) NEW. Among equal ranks — especially the fuzzy tier, where v6 had
      -- nothing but distance — the better textual match wins first.
      b.sim DESC,
      -- (5) Distance, then id for a deterministic tail.
      b.dist NULLS LAST,
      b.id
    LIMIT v_limit
  )

  -- PHASE 3 — heap, at most v_limit (<=25) primary-key lookups.
  SELECT
    r.display_name AS name,
    public._street_full_display(si.main_street)
      -- NULLIF because _street_full_display returns '' (not NULL) for a
      -- missing cross street, which would otherwise leave a dangling " e/ ".
      -- Unreachable on today's data but v6 would have produced it.
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
    CASE
      WHEN r.dist <= 25000  THEN 0
      WHEN r.dist <= 100000 THEN 1
      WHEN r.dist <= 300000 THEN 2
      ELSE 3
    END,
    r.match_rank,
    r.sim DESC,
    r.dist NULLS LAST,
    r.id;
END;
$function$;

COMMENT ON FUNCTION public.search_streets IS
  '00544 v7 - Accent-insensitive both ways (query and street name are each lower(unaccent(...)) before comparison), fuzzy-only matches demoted below every substring/exact match, and 11,359 ms -> ~200 ms by matching over the 12,476-row street_search_names dictionary, taking the nearest intersection from an index-only covering scan, and using sphere instead of spheroid distance. Same signature and columns as v6.';
