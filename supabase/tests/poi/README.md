# POI migrations — local rehearsal

Throwaway Postgres 16 + PostGIS database that reproduces the slice of prod the
POI migrations (`00579`, `00580`, `00581`) touch, so the SQL is exercised —
not just parsed — before anyone applies it to production (CLAUDE.md §
"Cómo probar migraciones SQL de verdad sin tocar prod").

## What is in here

| File | Purpose |
|---|---|
| `scaffold.sql` | Real DDL subset of `cuba_pois` (31 columns, GENERATED `name_normalized`, indexes, the 5 row triggers), `cuba_admin_areas` with prod polygons (La Habana, Mayabeque, 3 municipalities), `cuba_search_keywords`, `cuba_pois_submissions`, `cuba_landmask` as one bbox, `auth.uid()`/`is_admin()` shims, and the **live prod bodies** (captured 2026-09-05 via `pg_get_functiondef`) of every function the migrations patch or call. 30 fixture POIs cover each class the tests need. |
| `tests.sql` | Behaviour tests (`_t(name, cond)` prints `PASS`/`FAIL`; `IF cond IS NOT TRUE` so a NULL counts as failure). Sections T1–T7 map to plan Tasks 1–7. |
| `run.sh` | Drops + recreates the database, loads the scaffold, applies each `0058x` migration present in `supabase/migrations/` **twice** (idempotency), runs the tests. |

## Running

One-time setup on the sandbox (already done for this session):

```bash
sudo apt-get install -y --no-install-recommends postgresql-16-postgis-3 postgresql-16-postgis-3-scripts
sudo -u pgtest /usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -l /home/pgtest/pg.log -o "-p 5433 -k /home/pgtest" start
```

Then:

```bash
supabase/tests/poi/run.sh              # everything
MAX=00579 supabase/tests/poi/run.sh    # only up to 00579
```

The last line prints `failures | 0` when every test passed.

## Why the bodies are pasted verbatim

The migrations patch `admin_update_poi`, `admin_create_poi`,
`approve_poi_submission` and `import_search_poi` **in place** (`DO $patch$`
over `pg_get_functiondef`), so the rehearsal must start from the exact text
that runs in prod: the patches assert their target literal appears exactly
once and fail loudly otherwise. If prod redefines one of these functions,
re-capture it here before re-running the rehearsal.

Differences from prod that do not affect the migrations: `unaccent` lives in
`public` (prod: `extensions`; every function's `search_path` covers both),
`cuba_landmask` is a bbox (prod: the real coastline), no RLS on the scaffold
tables (the migrations still create theirs).
