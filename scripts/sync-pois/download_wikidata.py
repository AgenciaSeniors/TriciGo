#!/usr/bin/env python3
"""
TriciGo POI sync — Wikidata SPARQL download.

PR 6 of the POI parity program. Queries Wikidata for Cuban POIs that match
a curated set of Q-IDs (museums, landmarks, hotels, government buildings,
parks, religious sites, etc) and emits a GeoJSON file consumable by
merge_and_upsert.py via the `load_wikidata()` loader.

Wikidata is a 4th data source complementing OSM/Overture/Foursquare. Its
strength: notable landmarks have a Wikidata page → coordinates + curated
type info. We use it to ensure top-tier Cuban POIs (Capitolio Nacional,
Catedral de La Habana, Plaza de la Revolución, museums, fortresses)
are always present in cuba_pois with high importance.

Endpoint: https://query.wikidata.org/sparql (public, no auth, no token).
Rate limit: be polite — Wikimedia requires a User-Agent header and
expects <5 queries/sec from a single source.

Usage:
    python download_wikidata.py --out /tmp/sync/wikidata.geojson
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# ──────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────

SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "TriciGo-POI-Sync/1.0 (https://tricigo.com; ops@tricigo.com) python-urllib"

# Curated Q-IDs for POI types we actually want on the map.
# Coordinated with scripts/sync-pois/categories.json wikidata.q_ids.
# Skipping: Q41176 (building, too generic), Q23397 (lake), Q34627 (mountain),
# Q15324 (body of water) — not POIs anyone would search for.
POI_TYPE_QIDS = [
    "Q33506",    # museum
    "Q570116",   # tourist attraction / landmark
    "Q108325",   # church building
    "Q22746",    # historic hotel
    "Q11707",    # restaurant
    "Q4989906",  # castle / fortress
    "Q2074034",  # urban park
    "Q1370598",  # religious building
    "Q12280",    # bridge
    "Q124388",   # courthouse / government office
    "Q40357",    # prison (some are historic landmarks)
    "Q9259",     # UNESCO World Heritage Site
    "Q5727902",  # plaza / square
    "Q44613",    # monastery
    "Q16970",    # church
    "Q12518",    # tower
    "Q839954",   # archaeological site
]

# Cuba's Wikidata ID — used as the country filter (wdt:P17)
CUBA_QID = "Q241"


def build_sparql_query() -> str:
    """Build the SPARQL query as a single string."""
    qids_filter = " ".join(f"wd:{q}" for q in POI_TYPE_QIDS)
    return f"""
SELECT DISTINCT ?item ?itemLabel ?coord ?type ?typeLabel WHERE {{
  ?item wdt:P17 wd:{CUBA_QID} .
  ?item wdt:P625 ?coord .
  ?item wdt:P31 ?type .
  FILTER(?type IN ({qids_filter}))
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "es,en". }}
}}
LIMIT 5000
"""


# ──────────────────────────────────────────────────────────────
# SPARQL execution
# ──────────────────────────────────────────────────────────────

def run_sparql(query: str, retries: int = 3) -> dict:
    """Execute a SPARQL query with retry on 503/timeout. Returns parsed JSON."""
    encoded = urllib.parse.urlencode({"query": query, "format": "json"})
    url = f"{SPARQL_ENDPOINT}?{encoded}"
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/sparql-results+json",
    })

    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            print(f"[wikidata] SPARQL attempt {attempt + 1}/{retries}", flush=True)
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read())
            return data
        except urllib.error.HTTPError as e:
            last_error = e
            if e.code in (503, 504, 429):
                wait = (2 ** attempt) * 2  # 2, 4, 8 seconds
                print(f"[wikidata] HTTP {e.code} — retrying in {wait}s", flush=True)
                time.sleep(wait)
                continue
            raise
        except urllib.error.URLError as e:
            last_error = e
            wait = (2 ** attempt) * 2
            print(f"[wikidata] network error: {e} — retrying in {wait}s", flush=True)
            time.sleep(wait)
            continue

    raise RuntimeError(f"SPARQL query failed after {retries} attempts: {last_error}")


# ──────────────────────────────────────────────────────────────
# Convert SPARQL bindings → GeoJSON
# ──────────────────────────────────────────────────────────────

def parse_point(coord_literal: str) -> tuple[float, float] | None:
    """Parse a Wikidata Point literal like 'Point(-82.358 23.137)' → (lng, lat)."""
    if not coord_literal or not coord_literal.startswith("Point("):
        return None
    inner = coord_literal[len("Point("):].rstrip(")").strip()
    parts = inner.split()
    if len(parts) != 2:
        return None
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None


def qid_from_uri(uri: str) -> str | None:
    """Extract the Q-ID from a Wikidata entity URI."""
    if not uri:
        return None
    # URIs look like http://www.wikidata.org/entity/Q628969
    return uri.rsplit("/", 1)[-1]


def to_geojson(sparql_data: dict) -> dict:
    """Convert SPARQL JSON results to GeoJSON FeatureCollection."""
    bindings = sparql_data.get("results", {}).get("bindings", [])
    features = []
    seen_qids: set[str] = set()

    for b in bindings:
        item_uri = (b.get("item") or {}).get("value", "")
        wd_qid = qid_from_uri(item_uri)
        if not wd_qid or wd_qid in seen_qids:
            continue

        coord_literal = (b.get("coord") or {}).get("value", "")
        coords = parse_point(coord_literal)
        if not coords:
            continue
        lng, lat = coords

        # Cuba bbox sanity (Wikidata sometimes has wrong coords)
        if not (-85.0 <= lng <= -74.0 and 19.5 <= lat <= 23.5):
            continue

        name = (b.get("itemLabel") or {}).get("value", "").strip()
        if not name or name == wd_qid:
            # No Spanish/English label available — skip (likely a noise entity)
            continue

        type_uri = (b.get("type") or {}).get("value", "")
        type_qid = qid_from_uri(type_uri)
        type_label = (b.get("typeLabel") or {}).get("value", "")

        seen_qids.add(wd_qid)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "wikidata_qid": wd_qid,
                "name": name,
                "type_qid": type_qid,
                "type_label": type_label,
            },
        })

    return {"type": "FeatureCollection", "features": features}


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Download Wikidata POIs for Cuba")
    parser.add_argument("--out", type=Path, required=True, help="Output GeoJSON path")
    args = parser.parse_args()

    query = build_sparql_query()
    print(f"[wikidata] running query against {SPARQL_ENDPOINT}", flush=True)

    data = run_sparql(query)
    geojson = to_geojson(data)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(geojson, ensure_ascii=False, indent=2))

    n_features = len(geojson["features"])
    print(f"[wikidata] wrote {n_features} features to {args.out}", flush=True)

    # If we got zero, that's almost certainly a SPARQL/network issue, not
    # an actual zero — fail loud so the workflow surfaces it.
    if n_features == 0:
        print("[wikidata] WARNING: 0 features returned — check Wikidata SPARQL endpoint health", flush=True)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
