# POI landmark footprint — design

**Date:** 2026-08-21
**Problem owner:** reverse geocoding (`lookup_nearest_poi_ranked`, migration 00550)
**Status:** validated against prod data (read-only); implementation plan follows

## Problem

A pin standing on a large landmark gets labeled with the landmark's own nearest
sub-venue instead of the landmark. Measured in prod (wave-3 addendum,
2026-08-21): pin at the centre of the Manzana de Gómez block → "Rooftop Pool &
Bar" (non-admin, 11.6 m) beats "Gran Hotel Manzana Kempinski" (is_admin,
confidence 1, ~23 m). The hotel is a whole city block represented by **one
point**; its amenities carry their own closer points.

The mechanism is 00550's 10 m distance banding: the sub-venue lands in band 1,
the landmark in band 2, and `is_admin` only tie-breaks *within* a band. The
distance to a point that represents a block is a lie — the pin is *on* the
hotel, at distance 0 from the building, yet 23 m from its point.

### Constraints established by prior measurement (do not re-derive)

1. **Any global distance allowance for admin landmarks regresses 00550's
   control**: Parque Céspedes (7 m, non-admin) must keep beating Iberostar
   Grand Trinidad (25 m, is_admin conf 1). The threshold that fixes Manzana
   (≥23 m) and the one that must not flip Trinidad (≤25 m) leave no usable
   margin. One constant cannot encode "some landmarks are blocks, some are
   ordinary buildings".
2. **Category-wide suppression is forbidden**: "suppress non-admin hotel POIs
   within 60 m of an admin hotel" was measured platform-wide → 721 suppressed,
   sample = legitimate neighbouring casas particulares. Cuba's admin hotel
   category includes hostales, and hostales cluster.
3. Client-side fixes (11 m cache cells + distance-gated Nominatim fallback,
   PR #973) cover the reported symptom; the residual fires when the pin sits
   ≤20 m from a sub-venue's own point.

## Options considered

**(a) Per-row curated footprint radius** — `footprint_radius_m` on `cuba_pois`,
set only on curated `is_admin` rows, used as an *effective distance* correction
(`GREATEST(0, dist − radius)`). Opt-in per row: unseeded rows behave byte-for-
byte as today, so the Trinidad control passes by construction. Robust to future
imports: any new sub-venue point inside a footprint lands in the same 0–10 m
band as the landmark's effective distance and loses the tie to `is_admin DESC`.
Upgradeable later to real polygons without schema conflict.

**(b) Curated parent-child (`parent_poi_id`)** — precise per-venue, but
curation is per *sub-venue* (unbounded set, drifts as `import_search_poi`
inserts new rows), it leaves the returned `distance_m` semantics muddy (parent
returned with whose distance?), and it does nothing for a pin near the block
edge where no sub-venue point is close. Rejected as the base mechanism; a
footprint makes most parent links unnecessary (they fall out of the band-0
tie-break).

**(c) OSM building polygons** — best precision, but requires an import
pipeline, polygon storage, and coverage is unverified for exactly the 389
curated admin rows (`source='merged'`, many not OSM-backed). Rejected for now;
the design leaves the door open (a future `footprint geometry` column can
supersede the radius).

**Decision: (a).**

## Design

### 1. Column

```sql
ALTER TABLE cuba_pois ADD COLUMN footprint_radius_m smallint
  CHECK (footprint_radius_m IS NULL
         OR (is_admin AND footprint_radius_m BETWEEN 1 AND 60));
```

`NULL` (the default, and the value for 382 of 389 admins) = no footprint =
exactly today's behavior. The 60 m hard cap bounds the blast radius of any
future curation mistake and is coupled to the constant in the function's
index prefilter (see below). The `is_admin` conjunct makes un-admining a
seeded row an explicit two-step (clear the radius first).

Nothing can clobber the column: the only writer of `cuba_pois` is the
`import_search_poi` RPC (INSERT-only dedup; verified — no `.from('cuba_pois')`
writer exists in apps or packages).

### 2. Ranking function (`lookup_nearest_poi_ranked` v3)

Same signature, same return shape (PostgREST callers unaffected). Three
changes, all no-ops for rows without a footprint:

1. **Candidate gathering**: a landmark qualifies if its *footprint* touches
   the search circle — `ST_DWithin(location, pin, p_radius_m + footprint)`.
   For index use, a constant prefilter `ST_DWithin(location, pin,
   p_radius_m + 60)` runs first (60 = the CHECK cap; keep in sync).
2. **Effective distance** everywhere distance is used — banding, ordering, and
   the **returned `distance_m`**: `GREATEST(0, raw − footprint)`. Returning the
   effective distance is load-bearing: the client only prepends a POI when
   `distance_m ≤ 20` (`POI_INCLUSION_THRESHOLD_M`, `packages/utils/src/geo.ts`),
   so returning the raw 23 m would fix the ranking and still lose the label.
3. **Deterministic final tie-breaker**: raw distance appended after effective
   distance in ORDER BY. Two seeded/inner-admin candidates at effective 0
   (e.g. Hotel Nacional r=40 vs its own Cabaret Le Parisien, also admin, 30 m
   inside) resolve to the closer point instead of unstable ordering.

Semantics at a glance, pin inside a footprint: landmark's effective distance
is 0 → band 0 → ties against any sub-venue standing at ≤10 m are broken by
`is_admin DESC` → the landmark wins even when the pin sits exactly on the
sub-venue's point (the wave-3 residual case). Pin outside the footprint by
>10 m: the nearer street-front venue wins, as today.

Consumers — both inherit the fix with no change:
- `packages/utils/src/geo.ts` `lookupNearestPoi` (radius 30, anon REST)
- `resolve_point_address` (00539 ride-address backstop, radius 120; uses the
  name only)

### 3. Seeds (curation, shipped in the migration)

**Criterion (physical, falsifiable):** radius r is valid iff the circle of
radius r around the row's point lies entirely on the landmark's own property
(block / grounds). Inside such a circle every other point is either the
landmark's own amenity or mis-geocoded garbage — famous landmarks are garbage
magnets ("Estadio Latinoamericano" 9.8 m from Hotel Nacional, "Playa Boca
Ciega" 13.4 m from Iberostar Parque Central) — so the landmark label is
physically true regardless.

Seeds (each verified against a 45 m neighbor dump from prod; nearest genuine
distinct venue listed):

| Landmark (is_admin, conf 1) | r | Nearest genuine distinct thing kept outside |
|---|---|---|
| Gran Hotel Manzana Kempinski | 35 | bus stop 46.7 m, casa particular 47.9 m |
| Hotel Nacional de Cuba | 40 | none physically possible ≤45 m (promontory grounds) |
| Hotel Habana Libre | 35 | Fonda La Paila (paladar) 39.5 m |
| Iberostar Selection Parque Central | 25 | La Xana 25.3 m, Bodeguita del Medio Cuba 25.4 m |
| Hotel Inglaterra | 15 | Pastelería Francesa 25.1 m |
| Hotel Casagranda (Santiago de Cuba) | 12 | Parque Céspedes SCU 20.8 m |
| Hotel Ambos Mundos | 10 | Gabinete de Patrimonio Musical Esteban Salas 13.3 m |

Explicitly **not** seeded, with reasons recorded so nobody retries:
- **Hotel Brisas Guardalavaca**: "Hostal Brisas del Mar" 18.8 m / "Hostal
  Finca La Esperanza" 22.3 m from its point — exactly the 721-lesson pattern;
  the point's placement inside the resort is unverified.
- **"Parque Central" (admin)**: its point is misplaced — 7.5 m from the
  Iberostar hotel's point, ~70 m from the actual park. Seeding it would halo
  the hotel with the park's name. (Point relocation is data curation, out of
  scope here.)
- **Iberostar Grand Trinidad**: 00550 control case; its surroundings are a
  garbage dump (misplaced beaches/waterfalls at 5–30 m) plus genuine hostales.
- Dense small venues (El Patio, paladares in Habana Vieja alleys): their close
  neighbors are legitimate distinct businesses.
- **Hotel Melia Cohiba**: dirty row (tricigo_category='transport'; "Ballet
  Nacional de Cuba" 6 m from its point).

Seed updates match on `id AND name AND is_admin` so a drifted prod row makes
the update a counted no-op rather than a mis-hit.

### 4. Verification (campaign method, adapted)

DDL in prod is MCP-guarded, so the A/B does not create a candidate function:
the candidate body runs as an **inline SELECT** against prod (read-only, same
SQL text the migration ships). Suites:

1. **The 3 Manzana pins** (block centre, Rooftop's own point, block edge):
   candidate must return Kempinski; live returns the sub-venue (documents the
   fix).
2. **The 3 control cases of 00550** (Parque Céspedes/Trinidad, La Esquina De
   Oro, Playa Plaza Caracol): candidate == live.
3. **Per-seed neighborhood sweeps** (grid over each seeded footprint + 100 m
   ring): every diff vs live must have the seeded landmark as the new winner
   AND the pin within the seed's radius; zero diffs outside.
4. **National no-change sweep** (stratified sample across all provinces,
   deterministic jitter, radii 30 and 120): **0 diffs** — the "calles sin nada
   especial: 0 filas cambiadas" analog.
5. **Performance**: warm timings, ≥3 runs alternated, candidate vs live
   (the added refine filter must not lose the GIST index).

Results tables are recorded in the migration header (house style of 00550)
and the implementation plan.

## Out of scope (recorded, not forgotten)

- Misplaced duplicate famous-hotel rows ("Gran Hotel Manzana Kempinski"
  non-admin at 23.104 / "…La Habana" at the university; "Hotel Tryp Habana
  Libre"; Little Cayman Beach Resort — not even in Cuba) → separate
  data-cleanup task.
- Growing the seed list (e.g. Brisas with verified point placement, Capitolio
  — currently not an admin row) → follow-up curation using the same per-seed
  protocol.
- Polygons (option c) as a future upgrade.
