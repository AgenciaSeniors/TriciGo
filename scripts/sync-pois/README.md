# TriciGo POI sync pipeline

Syncs POI data from 3 open-source datasets to the `cuba_pois` table in Supabase.

## Sources

| Source | License | Update freq | Strength |
|---|---|---|---|
| [OpenStreetMap Cuba](https://download.geofabrik.de/central-america/cuba.html) | ODbL | Daily | Cross-streets, gov, hospitals |
| [Overture Maps Places](https://docs.overturemaps.org/) | CDLA-Permissive 2.0 | Quarterly | Confidence scores, brand info |
| [Foursquare OS Places](https://huggingface.co/datasets/foursquare/fsq-os-places) | Apache 2.0 | Monthly | Lifestyle (paladares, MIPYMES) |
| [Wikidata](https://www.wikidata.org/) (PR 6, 2026-05) | CC0 | Continuous | Notable landmarks (Capitolio, Catedral, museums, fortresses) — forced `importance=1` |

## Files

| File | Purpose |
|---|---|
| `categories.json` | Maps source taxonomies to TriciGo unified categories |
| `download_foursquare.py` | Downloads + bbox-filters Foursquare HF dataset |
| `merge_and_upsert.py` | Main weekly: dedup + categorize + upsert to Supabase |
| `apply_osm_delta.py` | Daily OSM delta — applies Geofabrik replication diffs incrementally (PR 5 of POI parity) |
| `download_wikidata.py` | SPARQL query → Wikidata GeoJSON for Cuban landmarks (PR 6 of POI parity) |
| `requirements.txt` | Python deps |

## Run locally (test)

```bash
cd scripts/sync-pois
pip install -r requirements.txt

# 1. Download Overture (Cuba bbox)
overturemaps download --bbox=-85,19.5,-74,23.5 -t place -f geojson -o /tmp/overture.geojson

# 2. Download Foursquare (Cuba bbox)
HF_TOKEN=hf_xxx python download_foursquare.py --bbox=-85,19.5,-74,23.5 --out /tmp/fsq.parquet

# 3. Download OSM Cuba extract + filter POIs
curl -sSL https://download.geofabrik.de/central-america/cuba-latest.osm.pbf -o /tmp/cuba.osm.pbf
osmium tags-filter /tmp/cuba.osm.pbf \
  n/amenity n/shop n/tourism n/leisure n/office n/historic n/healthcare n/public_transport \
  -o /tmp/osm-pois.geojson --output-format=geojson --overwrite

# 4. Merge + upsert (DRY_RUN to preview)
DRY_RUN=1 python merge_and_upsert.py \
  --osm /tmp/osm-pois.geojson \
  --overture /tmp/overture.geojson \
  --foursquare /tmp/fsq.parquet

# Real run
SUPABASE_URL=https://lqaufszburqvlslpcuac.supabase.co \
SUPABASE_SERVICE_ROLE=$SERVICE_ROLE \
python merge_and_upsert.py
```

## Run via GitHub Actions

Two complementary workflows (PR 5 of POI parity, 2026-05-24):

| Workflow | Cadence | Purpose |
|---|---|---|
| `.github/workflows/sync-pois.yml` | **Weekly** (Mondays 6am UTC) | Full merge of OSM + Overture + Foursquare. Resets `poi_sync_state` sequence to latest Geofabrik. |
| `.github/workflows/sync-osm-delta.yml` | **Daily** (every day 6am UTC) | Incremental OSM-only delta. Reads `poi_sync_state.last_sequence`, downloads diffs from Geofabrik `cuba-updates/`, applies CREATE/MODIFY/DELETE events. |

Effective freshness post-PR:

| Source | Update upstream | TriciGo refresh |
|---|---|---|
| OSM | continuous | **24h** (daily delta) |
| Overture | monthly | 7d (weekly full) |
| Foursquare | monthly | 7d (weekly full) |
| Mapbox / Google (search) | continuous | on-demand (30d EF cache) |
| Crowdsource | continuous | instant (post-approval) |

Manual triggers:

```bash
# Full weekly sync
gh workflow run sync-pois.yml
# or with a smaller test bbox:
gh workflow run sync-pois.yml -f bbox=-82.5,23.0,-82.3,23.2  # only La Habana

# Daily delta (manual replay if scheduled run failed)
gh workflow run sync-osm-delta.yml
gh workflow run sync-osm-delta.yml -f dry_run=true  # parse-only, no DB writes
```

Monitor state:

```sql
SELECT region, last_sequence, last_sync_at, last_sync_kind, stats
FROM poi_sync_state;
```

## Behaviour

- **Admin POIs (`is_admin=true`) are NEVER overwritten.** Their fields stay as the admin set them.
- **Non-admin rows matching by `source_ids` → UPDATE.** Fields from the new sync replace whatever was there.
- **New merged rows not yet in DB → INSERT** with `source` set to the dominant input source (or `merged` if multi-source).
- **Stale non-admin rows** (not seen in 60 days) get `is_active=false` so search excludes them. Run `scripts/sync-pois/deactivate-stale.sql` separately or via cron.

## Quality gates (PR E, 2026-05-25)

Two filters apply between dedup and upsert (`_enforce_quality_gates` in `merge_and_upsert.py`):

1. **Confidence ≥ 0.6** — records below this threshold are dropped. Bypassed for `source IN ('admin','wikidata','crowdsource')` which are editorially trusted.
2. **Coord-cluster guard** — records whose `lat,lng` rounded to 4 decimals (~11 m) match a cluster of 5+ records in the same batch are dropped. Same trusted-source bypass.

The coord-cluster guard exists because Overture and other providers occasionally geocode unresolvable addresses to the municipality centroid, stacking dozens of unrelated POIs at the same coordinate. Those entries caused the on-device bug 2026-05-25: searching "aeropuerto" returned `Aeropuerto Internacional José Martí` at a random spot in Habana centro (cluster of 44 POIs at that fake coord, including the airport mixed with casas particulares).

Historical cleanup of pre-existing low-quality rows ran via migration `00311_pois_cleanup_low_confidence.sql` — same criteria, applied once to the existing ~108k rows. Going forward the sync pipeline never re-introduces them.

## Dedup

- Spatial: R-tree, 50m radius
- Name: rapidfuzz `fuzz.ratio` ≥ 0.80 (0–1 normalized)
- Per-field merge preference (see `merge_and_upsert.py:Record.merge_with`):
  - `phone`: foursquare > osm > overture
  - `hours`: osm > foursquare > overture
  - `website`: foursquare > overture > osm
  - `address`: overture > foursquare > osm
  - `name`: osm > foursquare > overture (OSM has best Cuba locality context)

## Roadmap

- [ ] Add `--mode incremental` to skip shards we've fully processed last run
- [ ] Foursquare's `date_refreshed` filter — only download recently-refreshed rows
- [ ] Slack diff report (added/updated/closed counts) per category
- [ ] Cuba ONEI/government POI dataset (when accessible) as 4th source
