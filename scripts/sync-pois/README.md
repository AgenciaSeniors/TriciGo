# TriciGo POI sync pipeline

Syncs POI data from 3 open-source datasets to the `cuba_pois` table in Supabase.

## Sources

| Source | License | Update freq | Strength |
|---|---|---|---|
| [OpenStreetMap Cuba](https://download.geofabrik.de/central-america/cuba.html) | ODbL | Daily | Cross-streets, gov, hospitals |
| [Overture Maps Places](https://docs.overturemaps.org/) | CDLA-Permissive 2.0 | Quarterly | Confidence scores, brand info |
| [Foursquare OS Places](https://huggingface.co/datasets/foursquare/fsq-os-places) | Apache 2.0 | Monthly | Lifestyle (paladares, MIPYMES) |

## Files

| File | Purpose |
|---|---|
| `categories.json` | Maps source taxonomies to TriciGo unified categories |
| `download_foursquare.py` | Downloads + bbox-filters Foursquare HF dataset |
| `merge_and_upsert.py` | Main: dedup + categorize + upsert to Supabase |
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

The workflow `.github/workflows/sync-pois.yml` orchestrates this monthly (cron `0 6 1 * *`).
Manual trigger:

```bash
gh workflow run sync-pois.yml
# or with a smaller test bbox:
gh workflow run sync-pois.yml -f bbox=-82.5,23.0,-82.3,23.2  # only La Habana
```

## Behaviour

- **Admin POIs (`is_admin=true`) are NEVER overwritten.** Their fields stay as the admin set them.
- **Non-admin rows matching by `source_ids` → UPDATE.** Fields from the new sync replace whatever was there.
- **New merged rows not yet in DB → INSERT** with `source` set to the dominant input source (or `merged` if multi-source).
- **Stale non-admin rows** (not seen in 60 days) get `is_active=false` so search excludes them. Run `scripts/sync-pois/deactivate-stale.sql` separately or via cron.

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
