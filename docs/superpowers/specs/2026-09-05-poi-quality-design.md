# POI quality overhaul — design

**Date:** 2026-09-05 · **Status:** approved by the owner (6 decisions + 3 design sections, see § Decisions)
**Scope:** `cuba_pois` data + sync, `search_pois_smart` v2, learning from rider picks, passenger app map/search/emoji, admin curation.
**Out of scope:** re-admitting OSM-only rows (owner kept the confidence gate), a TriciGo-drawn POI layer on the map (owner chose to keep Mapbox's labels), rider-side "report this place", automatic staleness deactivation.

---

## 1. Context — what production says today (read-only, 2026-09-05)

| Signal | Value |
|---|---|
| `cuba_pois` rows / active | 110,289 / **19,939** (389 admin, 6 footprints) |
| OSM-only rows deactivated by the confidence gate (00311, 2026-05-25) | 69,210 — **kept out by owner decision** |
| Active rows by source | overture 11,802 · merged 4,785 · foursquare 3,221 · osm 131 |
| Wikidata landmark source | **0 rows ever** — `download_wikidata.py` builds `FILTER(?type IN (wd:Q1 wd:Q2 …))` with spaces, SPARQL answers HTTP 400 every run |
| Province values among active rows | 15,402 canonical · 2,979 NULL · **1,558 non-canonical** ("FL", "TX", "Матанзас", "City of Havana"…) |
| Distinct `municipality` values among active rows | **759** (8,046 rows not matching `cuba_admin_areas`) |
| Exact duplicates (same `name_normalized`, ≤150 m) | 872 rows in 1,020 pairs (cross-source and same-source) |
| Overture "landmarks" whose name is a Swedish Wikidata descriptor (`Arroyo X (periodiskt vattendrag i Kuba…)`), categorised `museum` | 193 |
| Names carrying a city suffix (`La Bodeguita Del Medio La Habana Cuba`) | 264 · ALL-CAPS 163 · all-lowercase 234 |
| Names starting with a generic word (Hotel/Restaurante/Parque/Hospital/…) | **6,074 (30 %)** — they lose to prefix matches when the rider types the bare name |
| Active bus stops (`public_transport`) | 951, many named after the landmark they serve |
| Rider picks imported from Google/Mapbox | **0** — `importPoiFromSearch` is wired to `handleSelectResult`, but the dropdown commits through `commitSelection`, which drops `_src` |
| Admin RPCs `admin_create_poi`, `admin_update_poi`, `approve_poi_submission` | **broken since `name_normalized` became GENERATED** — every call fails with `428C9` (verified in a rolled-back transaction) |

Search smoke from the Capitolio (top-3 of `search_pois_smart`):

| Query | Today | Why |
|---|---|---|
| `capitolio` | Capitolio Residences · Capitolio Km 0 · "Capitolio Nacional (habana -Cuba )" | prefix beats substring; "El Capitolio" is rank 2 |
| `habana libre` | Habana Libre Residence · El Turquino · B&B Habana Libre | the real hotel is "Hotel Habana Libre" (substring, rank 2) |
| `hospital ameijeiras`, `coppelia`, `zoologico`, `parque lenin`, `la rampa`, `cujae` | a **bus stop** first | stop names equal the landmark name → `name_exact` |
| `aeropuerto`, `playa santa maria`, `plaza de la revolucion`, `melia habana` | 2–3 copies of the same place, one of them misplaced | cross-source duplicates outside the 0.001° dedupe cell |
| `la ceguera`, `la benefica`, `el naval`, `maternidad de linea` | a stop, "La Barca", fuzzy noise | popular Cuban names are not aliases anywhere |
| `cupet` | "CUPET" as `other` | brand not mapped to `gas_station` |

Ranking today: `rank_quality*1000 + is_generic*5000 + (is_admin?0:40) + (1-confidence)*30 + LEAST(dist_km,30) + (contact?0:8)` — no landmark tier, no popularity, no alias, no bare-name match, no stop demotion.

## 2. Decisions (owner, 2026-09-05)

1. **Keep the OSM confidence gate** ("calidad sobre cantidad").
2. **Names: both** — clean the displayed name AND add a popular-alias layer.
3. **Map: improve Mapbox's own labels only** (no TriciGo POI layer).
4. **Learn from picks: import** rider-chosen Google/Mapbox places and count popularity.
5. **Admin: full curation** (aliases, merge, landmark, footprint, suspects, sync health).
6. **Order: server first** (data → search → app → admin).
7. **Approach B**: alias table + precomputed search dictionary (the `street_search_names` pattern of 00544), curation columns the sync never writes.

## 3. Architecture

```
                 weekly / daily sync (GH Actions)          rider apps / web / admin
                          │                                        │
   bulk_upsert_pois ──────┼── writes name, category, location…     │ search_pois_smart v2 ──┐
   apply_osm_delta_batch ─┘                                        │ record picks (trigger)  │
                          │                                        │                          │
                          ▼                                        ▼                          │
   cuba_pois ── BEFORE trigger: display_name := COALESCE(name_override, _poi_clean_name(name))
     │             municipality/province := polygon lookup when NULL/changed
     │             tricigo_category_effective := COALESCE(category_override, tricigo_category)
     │
     ├── cuba_poi_aliases (popular/official/brand/short/old; admin CRUD; seeds)
     │
     └── statement triggers ──► poi_search_names (poi_id, norm, kind, weight)  ◄── search v2 reads this
```

Everything curated lives in columns/tables the sync never touches. The sync keeps overwriting `name`, `category`, `location`, contact fields; triggers re-derive what is derived; overrides win.

## 4. Data model (PR-1)

### 4.1 Fix the broken admin writers first
`admin_create_poi`, `admin_update_poi`, `approve_poi_submission` stop writing `name_normalized` (in-place `DO $patch$` from the live bodies, same technique as 00573). Verified by executing each inside `BEGIN … ROLLBACK` in the rehearsal.

### 4.2 New columns on `cuba_pois` (never written by the sync)
| Column | Type | Meaning |
|---|---|---|
| `display_name` | text NOT NULL | derived by trigger: `COALESCE(name_override, _poi_clean_name(name))` |
| `name_override` | text | admin-set display name; survives sync |
| `category_override` | text CHECK ∈ taxonomy | admin-set category; the effective category is `COALESCE(category_override, tricigo_category)` |
| `is_landmark` | boolean NOT NULL DEFAULT false | landmark tier in ranking; seeded from Wikidata + hand list |
| `pick_count` | int NOT NULL DEFAULT 0 | rider picks (ride endpoints resolved to this POI) |
| `last_picked_at` | timestamptz | |
| `merged_into` | bigint REFERENCES cuba_pois(id) | set on the loser of a merge; row is deactivated |
| `footprint_radius_m` | (exists, 00570) | unchanged |

`tricigo_category` gets `CHECK … NOT VALID` over the 24-value taxonomy (validated after the data fixes so a typo can no longer hide a row silently).

### 4.3 Name cleaner `_poi_clean_name(text)` (IMMUTABLE, tested with a fixture table)
Deterministic, in this order:
1. Trim, collapse whitespace, strip wrapping quotes/guillemets, normalise `“”` → `"`.
2. Remove Wikidata/Overture descriptors in parentheses: `\((ö|vattendrag|periodiskt|sjö|berg|by|ort|udde|bukt|flod|kulle|kommun|stad|halvö|lagun|vik|kanal|damm|grotta)[^)]*\)` and `\([^)]*\b(cuba|habana|havana)\b[^)]*\)` when the parenthesis holds only location words.
3. Strip trailing location suffixes: `,? (la )?habana( cuba)?$`, `,? cuba$`, ` havana cuba$`, ` l'havana cuba$`, `,\s*(vedado|centro habana|habana vieja|playa)$` (municipality echoes).
4. Case: ALL-CAPS tokens longer than 5 letters → Title Case; tokens ≤5 letters stay (ETECSA, CUJAE, CUPET, CADECA, DHL, FAC); all-lowercase names → Title Case; Spanish small words (`de del la las los y e el al en`) stay lowercase when not first.
5. Never returns empty: falls back to the trimmed input.

### 4.4 `cuba_poi_aliases`
```
id bigserial PK, poi_id bigint FK cuba_pois ON DELETE CASCADE,
alias text NOT NULL, alias_norm text NOT NULL (lower(unaccent)),
kind text CHECK (kind IN ('popular','official','brand','short','old')),
source text CHECK (source IN ('admin','osm','seed','import')),
created_by uuid, created_at timestamptz, UNIQUE (poi_id, alias_norm)
```
RLS: public SELECT; INSERT/UPDATE/DELETE via admin RPCs only. Seeds: (a) from OSM `tags` of active rows: `alt_name`, `official_name`, `short_name`, `old_name`, `brand`, `name:es` when different from `name`; (b) a hand-curated list of ~50 Havana popular names resolved at migration time by name + coordinates (skip with NOTICE when the target is not found), e.g. La Ceguera → Hospital de Oftalmología, La Benéfica → Hospital Miguel Enríquez, El Naval → Hospital Naval, Maternidad de Línea → Hospital América Arias, Pediátrico del Cerro, Oncológico, La Coubre, Cuatro Caminos, FAC → Fábrica de Arte Cubano, El Cañonazo → Fortaleza de la Cabaña, La Lonja, Karl Marx, Ciudad Deportiva, Cementerio de Colón, Zoológico de 26, ExpoCuba, Marina Hemingway, Manzana de Gómez → Kempinski, Habana Libre, Nacional, Capitolio, Inglaterra, Bodeguita, Floridita, Tropicana, Terminal de Ómnibus, Viazul, Terminal 3.

### 4.5 Dictionary `poi_search_names`
```
poi_id bigint, norm text, kind text CHECK (kind IN ('display','bare','alias','brand')), weight real,
PRIMARY KEY (poi_id, norm, kind); GIN (norm gin_trgm_ops); btree (norm)
```
Rows only for active POIs. `display` = `lower(unaccent(display_name))`; `bare` = `_poi_bare_name(display_name)` (strips a leading generic word — hotel|hostal|restaurante|bar|cafetería|cafeteria|paladar|parque|playa|hospital|policlínico|clínica|escuela|iglesia|museo|teatro|cine|farmacia|banco|tienda|mercado|agromercado|panadería|dulcería|heladería|pizzería|estadio|terminal|aeropuerto|universidad|instituto|casa|villa|plaza — and a leading article el|la|los|las, only when something remains); `alias`/`brand` from `cuba_poi_aliases`. Maintained by statement-level triggers with transition tables on `cuba_pois` (INSERT/UPDATE OF name, name_override, is_active, merged_into) and on `cuba_poi_aliases`. `norm` columns are plain columns filled by the trigger (unaccent is STABLE — same reason as 00544).

### 4.6 Municipality / province
`_poi_admin_area(location)` looks up `cuba_admin_areas` (admin_level 6 → municipality `name_es`, 4 → province). A BEFORE INSERT/UPDATE OF location trigger fills both when NULL or when the point moved. One-time backfill over the ~20k active rows, batched with `statement_timeout = 0`, mirroring 00545. The sync's `ON CONFLICT` does not write these two columns, so the backfill survives.

### 4.7 Cleanup (data migration, idempotent, guarded by the 00571 lock so the sync cannot resurrect)
- Deactivate the 193 Swedish-descriptor Overture "landmarks" (they are streams/islands, not places).
- Merge exact duplicates: same `name_normalized`, same effective category, ≤150 m. Winner = `is_admin` > `merged` > `overture` > `foursquare`, then confidence, then lowest id. Loser: `is_active=false`, `merged_into=winner`; the winner's `source_ids` gains the loser's ids so future syncs match the winner.
- Category fixes via `categories.json` + `map_category_to_tricigo` (systematic: brand `Cupet`/operator `CUPET` → `gas_station`; Overture `landmark_and_historical_building` → `landmark`; theatre/cinema/cabaret → `venue`; stadium → `stadium`) and `category_override` for the hand-verified rows (e.g. the dirty Melia Cohiba row noted in 00570).

### 4.8 Taxonomy
24 values = the 21 today + `landmark` 🏛️, `venue` 🎭, `stadium` 🏟️. Four mapping surfaces are kept and a CI check (`scripts/check-poi-taxonomy.mjs`, wired into `ci.yml`) asserts the value sets agree: `packages/api/src/services/poi.service.ts` `TRICIGO_CATEGORIES`, `scripts/sync-pois/categories.json` values, `supabase/functions/import-mapbox-poi/_shared/mapbox-categories.ts` values, and the SQL CHECK (read from the migration file).

### 4.9 Wikidata
`download_wikidata.py`: `", ".join(...)` inside `FILTER(?type IN (...))`; the merge marks Wikidata records `is_landmark=true` and the existing importance boost keeps applying. `bulk_upsert_pois` gains one nullable `is_landmark` input that only ever sets true (never clears an admin's true).

### 4.10 Freshness
No automatic deactivation. `synced_at` older than 90 days = "stale": ranking penalty (§5) and a row in the admin "Sospechosos" tab. The existing hourly watchdog (00574) keeps alerting when the syncs stop.

## 5. Search v2 + learning (PR-2)

### 5.1 `search_pois_smart` v2 (same signature and return shape, plus `matched_alias text`, `display_name text`, `is_landmark boolean`)
Candidate gather from `poi_search_names` (trgm on `norm`) joined to active `cuba_pois` with `merged_into IS NULL`, inside `radius_m`. Match tiers per row (best of its dictionary rows):

| tier | condition | rank |
|---|---|---|
| exact | `norm = q` on display / bare / alias | 0 |
| prefix | `norm LIKE q || '%'` | 1 |
| substring | `norm LIKE '%' || q || '%'` | 2 |
| all tokens | every query token in `norm` or `address_normalized` | 2.5 |
| fuzzy | `similarity(norm, q) > 0.3` (also `similarity(bare, q_bare)`) | 2.8 |
| category only | keyword → category | 3 |

The query is normalised once (`lower(unaccent)`), and `q_bare` = `_poi_bare_name(q)` so "hotel habana libre" and "habana libre" both hit the bare row.

Score (ascending):
```
rank*1000
+ is_generic*5000                       -- anti-placeholder (00551 semantics, unchanged)
+ CASE WHEN is_landmark THEN -120 WHEN is_admin THEN -60 ELSE 0 END
+ CASE WHEN category_eff='transport' AND subcategory/category is a stop AND NOT transport_intent THEN +700 END
- LEAST(pick_count, 20) * 15
+ CASE WHEN synced_at < now() - 90 days THEN +150 END
+ (1-confidence)*30 + LEAST(dist_km, 30) + (contact?0:8)
```
`transport_intent` = query matches `\m(parada|terminal|guagua|omnibus|ómnibus|estacion|estación|ruta|p-?\d{1,2}|a\d{2}|tren|ferry|aeropuerto)\M`. A stop whose `norm` equals a non-transport active POI within 400 m is dropped from the candidate set unless `transport_intent`.

Dedupe in the response: `DISTINCT ON (norm_display, round(lng,3)…)` replaced by a 300 m same-display-name collapse (keep the best-scored). Ties close with `p.id` (CLAUDE.md rule).

Performance guard: candidate gather is index-only on the dictionary; measured warm ≥3 runs against the live function on the 60-query suite (target ≤ 250 ms p95, today ~180 ms).

### 5.2 Verification suite
`supabase/tests/poi_search_suite.sql`: 60 Cuban queries (the 30 + 30 measured in this session plus the colloquial ones) with the expected first result (by id or by display name + municipality). Run as a `SELECT` against a candidate function (`search_pois_smart_v2c`, pattern of 00570 §10) BEFORE apply and against the real function after; the migration drops the candidate. Also a "no-change" control set (20 plain queries whose top-1 must not move).

### 5.3 Learning from picks (server-side; works with the installed apps)
- `record_poi_pick(p_poi_id)`: `SECURITY DEFINER`, authenticated, rate-limited via `check_rate_limit` (60/h), increments `pick_count`, sets `last_picked_at`.
- Trigger `AFTER INSERT ON rides` (defensive, `EXCEPTION … RETURN NEW`): for pickup and dropoff, `find_nearby_poi_match(leading_name, lat, lng, 60)` where `leading_name` = text before the first comma when the address is not a corner/placeholder (`_ride_address_is_placeholder` false, no ` e/ `/` entre `/` y ` pattern at the start). Match → `pick_count += 1`. No match and the text looks like a venue (≥2 letters, not a zone name from `cuba_admin_areas`) → insert into `poi_import_queue (ride_id, endpoint, name, lat, lng, status)`.
- Queue worker: the existing `import-mapbox-poi` Edge Function gains a service-role batch mode (`{ "drain": 20 }`) called by a `cron_http_post` job every 15 min (rule from CLAUDE.md: never raw `net.http_post`). Each item → Mapbox forward lookup → `import_search_poi` (already dedupes 50 m + similarity 0.6, geofenced by 00575's trigger) → new row gets `pick_count=1`, `source='mapbox'`. Items failing twice are marked `failed` with the reason; the admin suspects tab lists them.
- Client-side `importPoiFromSearch` calls are removed (dead path, replaced by the server), and the queue also covers the web app for free.

## 6. Passenger app (PR-3, APK rebuild)

- **Tap a Mapbox label** (`RideMapView.onPress` → `onPlacePress(name, lng, lat)`): the home no longer discards `name`. New hook `resolveTappedPlace(name, lng, lat)` → `find_nearby_poi_match(name, lat, lng, 60)` + `admin_get_poi`-like public read (`get_poi_card(id)`: display_name, category_eff, address, municipality, matched alias). Hit → `PlaceSheet` ("Ir aquí" / "Ajustar pin") with emoji + display name + address; the confirm commits `setDropoff/setPickup` with the POI-prefixed address (same format the reverse geocode produces: `POI, calle e/ X y Y, Municipio, Provincia`). Miss → reverse geocode of the tapped point, prefixing the tile name as the POI name (Spanish `name_es` preferred, already handled by `poiNameFromFeature`).
- Map style/labels unchanged (`PlacesLayer` keeps `name_es`, `filterrank` stepping, maki icons).
- **Dropdown rows**: `matched_alias` renders as `Alias · Display name` (alias first when the match came from an alias); emoji resolves from the effective category with the 24-value map (`landmark` 🏛️, `venue` 🎭, `stadium` 🏟️, `other` 🏢); subtitle = backfilled municipality + province.
- **Emoji keyword matching** in `packages/utils/src/addressSearch.ts`: `RAW_CATEGORY_EMOJI` and `NAME_KEYWORD_EMOJI` match on whole tokens (`\b`), scanned over the name only (not the address) for venue keywords; tests cover the known collisions (business, parking, Cienfuegos, Calle Terminal).
- **Recents** keep `displayName`, `tricigoCategory`, `address` → two-line rows with emoji (`recentAddresses.ts` schema bump with a tolerant reader).
- **Web** (`apps/web/src/components/AddressAutocomplete.tsx`): alias line + emoji map, nothing else.

## 7. Admin (PR-4)

Page `apps/admin/src/app/pois/page.tsx` grows into: list with pick_count/landmark/stale badges; editor with a map picker (reuse `PartnerPlacePicker`), fields `name_override`, `category_override` (24 values), `is_landmark`, `footprint_radius_m` (CHECK 1..60, admin rows), aliases editor (add/remove with kind); "Fusionar con…" (search a target, confirm, loser gets `merged_into`); tab "Sospechosos" (name with parentheses/suffix garbage, NULL municipality, exact-duplicate pairs, stale ≥90 d, `other` with a venue keyword, failed import-queue items); sync health card (`poi_sync_state`, `platform_config.poi_sync_health_*`, last workflow runs are linked, not fetched). Sidebar links `/pois/submissions`.

RPCs (`SECURITY DEFINER`, admin gate, `admin_actions` audit): `admin_update_poi` (extended params), `admin_merge_pois(loser, winner)`, `admin_list_poi_aliases(poi_id)`, `admin_upsert_poi_alias`, `admin_delete_poi_alias`, `admin_list_suspect_pois(kind, page)`, `admin_poi_sync_health()`. Service methods in `packages/api/src/services/poi.service.ts` with vitest (admin has no test runner).

## 8. Delivery

| PR | Content | DB | Rebuild |
|---|---|---|---|
| PR-1 data | §4 (migrations + `scripts/sync-pois` fixes + taxonomy CI check) | yes | no |
| PR-2 search | §5 (search v2 + suite + picks + import queue + EF drain mode + cron) | yes | no |
| PR-3 app | §6 | no | **client APK** (web deploy) |
| PR-4 admin | §7 | yes (admin RPCs) | admin deploy |

Migrations are committed, rehearsed on the sandbox's local Postgres 16 with the live function bodies transcribed (CLAUDE.md § "Cómo probar migraciones SQL de verdad"), and **not applied from the sandbox** (MCP guard); the PR bodies say so and every client path tolerates the absence (new columns are read through the RPC, which is versioned in the same migration).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Cleaner damages a real name (e.g. a bar literally called "La Habana Cuba") | fixture test with 40 real names before/after; `name_override` is the escape hatch; suspects tab shows every row the cleaner changed by >40 % of its length |
| Stop demotion hides a stop the rider wanted | only when a same-name non-stop POI is within 400 m; `transport_intent` restores; measured on the suite |
| Landmark bonus regresses Trinidad-style controls (lección-721) | the bonus is in **search** ranking only; `lookup_nearest_poi_ranked` (reverse geocode) is not touched |
| Merge picks the wrong winner | deterministic order, `merged_into` pointer keeps the loser recoverable; admin "Deshacer fusión" is a one-line RPC |
| Import queue imports garbage from mistyped addresses | only non-placeholder venue-like text, Mapbox must return a match ≥0.55, `import_search_poi` dedupes, geofence trigger, admin suspects lists imports |
| Sync overwrites curation | curated fields are columns/tables the `ON CONFLICT` never writes (verified against the live body); admin rows stay fully locked as today |
