#!/usr/bin/env python3
"""
TriciGo POI sync — daily OSM delta application.

Downloads daily Geofabrik replication diffs for Cuba (.osc.gz format),
parses CREATE/MODIFY/DELETE events that match our POI filter (amenity,
shop, tourism, etc), and applies them to cuba_pois via the
apply_osm_delta_batch RPC.

PR 5 of the POI parity program. Complements the existing
sync-pois.yml workflow:
  - sync-pois.yml runs WEEKLY (Mondays 6am UTC) — full merge of OSM PBF
    + Overture + Foursquare. Resets the replication sequence pointer.
  - sync-osm-delta.yml (THIS script) runs DAILY (every day 6am UTC) —
    pulls just the diff since the last sync, applies it incrementally.

Frescura efectiva post-PR: OSM 24h (was 30d). Other sources still weekly
because Overture and Foursquare publish monthly upstream anyway.

State management:
  - poi_sync_state table (Supabase) holds the last applied Geofabrik
    sequence number per region.
  - If no state exists (first run), the script bootstraps from the
    current latest sequence available at Geofabrik (skipping historical
    backfill — the weekly full sync already brought us up to date).

Required env:
  SUPABASE_URL              project URL
  SUPABASE_SERVICE_ROLE     service role key

Optional env:
  DRY_RUN=1                 parse only, don't call apply_osm_delta_batch
  REGION=cuba               region name (default: 'cuba')
  REPLICATION_URL           override (default: Geofabrik central-america/cuba-updates)
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterator

import requests  # noqa: F401 — used via supabase-py underneath

# ──────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────

REGION = os.environ.get("REGION", "cuba")
DEFAULT_REPLICATION_URL = "https://download.geofabrik.de/central-america/cuba-updates"
REPLICATION_URL = os.environ.get("REPLICATION_URL", DEFAULT_REPLICATION_URL).rstrip("/")
DRY_RUN = os.environ.get("DRY_RUN") == "1"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE = os.environ.get("SUPABASE_SERVICE_ROLE", "")

# OSM tag prefixes we consider as POIs (must align with sync-pois.yml filter)
POI_TAGS = {
    "amenity", "shop", "tourism", "leisure", "office",
    "historic", "healthcare", "public_transport",
}

# Cuba bbox (must match server-side validation in apply_osm_delta_batch)
CUBA_BBOX = (-85.0, 19.5, -74.0, 23.5)  # west, south, east, north

# Batch size for RPC calls (smaller = more roundtrips but smaller failure blast radius)
BATCH_SIZE = 500


# ──────────────────────────────────────────────────────────────
# Geofabrik replication helpers
# ──────────────────────────────────────────────────────────────

def fetch_remote_state() -> int:
    """Fetch the latest replication sequence number from Geofabrik's state.txt."""
    url = f"{REPLICATION_URL}/state.txt"
    print(f"[delta] fetching {url}", flush=True)
    with urllib.request.urlopen(url, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    for line in text.splitlines():
        if line.startswith("sequenceNumber="):
            return int(line.split("=", 1)[1])
    raise RuntimeError(f"sequenceNumber not found in {url}")


def sequence_to_path(seq: int) -> str:
    """Geofabrik diff files use a 3-tier directory tree: AAA/BBB/CCC.osc.gz."""
    s = f"{seq:09d}"
    return f"{s[:3]}/{s[3:6]}/{s[6:9]}"


def download_diff(seq: int, dest_path: Path) -> bool:
    """Download a single .osc.gz file for the given sequence. Returns False on 404."""
    url = f"{REPLICATION_URL}/{sequence_to_path(seq)}.osc.gz"
    print(f"[delta] downloading seq {seq} from {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "TriciGo-POI-Sync/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            dest_path.write_bytes(resp.read())
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"[delta] seq {seq} not yet available (404) — stopping", flush=True)
            return False
        raise


# ──────────────────────────────────────────────────────────────
# .osc.gz parsing — XML streaming
# ──────────────────────────────────────────────────────────────

# OSM Change format (.osc) is a simple XML:
#   <osmChange>
#     <create><node id=... lat=... lon=...><tag k=... v=... /></node></create>
#     <modify><node ...>...</node></modify>
#     <delete><node id=... /></delete>
#   </osmChange>
#
# We process it as a stream to avoid loading the full file in memory.

def iter_osc_events(osc_gz_path: Path) -> Iterator[dict]:
    """Yield normalized event dicts from a .osc.gz file.

    Each event has shape:
      {
        op: 'CREATE' | 'MODIFY' | 'DELETE',
        osm_type: 'node' | 'way' | 'relation',
        osm_id: int,
        lat: float | None,        # only for CREATE/MODIFY nodes
        lng: float | None,
        name: str | None,
        category: str | None,     # POI top-level (amenity/shop/...)
        subcategory: str | None,  # OSM value (restaurant/supermarket/...)
        tags: dict,
      }
    """
    with gzip.open(osc_gz_path, "rb") as f:
        # iterparse processes XML as it streams in — cheap on memory
        context = ET.iterparse(f, events=("start", "end"))
        current_op = None  # 'create' | 'modify' | 'delete'

        for event, elem in context:
            tag = elem.tag.lower()
            if event == "start" and tag in ("create", "modify", "delete"):
                current_op = tag.upper()
                continue

            if event == "end" and tag in ("create", "modify", "delete"):
                current_op = None
                elem.clear()
                continue

            if event == "end" and tag in ("node", "way", "relation"):
                if current_op is None:
                    elem.clear()
                    continue

                osm_id_str = elem.get("id")
                if not osm_id_str:
                    elem.clear()
                    continue

                # Build tags dict from <tag k= v=> children
                tags = {
                    child.get("k", ""): child.get("v", "")
                    for child in elem.findall("tag")
                }

                # Find POI category (first matching tag key)
                category = None
                subcategory = None
                for key in POI_TAGS:
                    if key in tags:
                        category = key
                        subcategory = tags[key]
                        break

                # DELETE doesn't carry coords — we still emit so RPC can soft-delete
                if current_op == "DELETE":
                    yield {
                        "op": "DELETE",
                        "osm_type": tag,
                        "osm_id": int(osm_id_str),
                    }
                else:
                    # CREATE / MODIFY — needs to be a POI (have a known category)
                    if not category:
                        elem.clear()
                        continue

                    # Only nodes have inline lat/lon. Ways/relations need geometry
                    # resolution which the delta diff doesn't include directly —
                    # skip those for the delta path. The weekly full sync via
                    # osmium-tool will pick them up.
                    if tag != "node":
                        elem.clear()
                        continue

                    try:
                        lat = float(elem.get("lat") or "")
                        lng = float(elem.get("lon") or "")
                    except (TypeError, ValueError):
                        elem.clear()
                        continue

                    name = tags.get("name") or tags.get("name:es") or tags.get("alt_name")
                    if not name:
                        # Anonymous POIs are usually noise (street furniture, etc).
                        # Skip; the weekly full sync filter is also name-based.
                        elem.clear()
                        continue

                    yield {
                        "op": current_op,
                        "osm_type": tag,
                        "osm_id": int(osm_id_str),
                        "lat": lat,
                        "lng": lng,
                        "name": name,
                        "category": category,
                        "subcategory": subcategory,
                        "tags": tags,
                    }

                elem.clear()


# ──────────────────────────────────────────────────────────────
# Supabase RPC client (tiny — avoids pulling supabase-py just for this)
# ──────────────────────────────────────────────────────────────

def rpc(name: str, args: dict) -> dict:
    """Call a Supabase RPC via PostgREST. Returns parsed JSON response."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE env vars are required")

    url = f"{SUPABASE_URL}/rest/v1/rpc/{name}"
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE}",
        "Content-Type": "application/json",
    }
    resp = requests.post(url, headers=headers, json=args, timeout=60)
    resp.raise_for_status()
    if not resp.content:
        return {}
    return resp.json()


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

def main() -> int:
    # 1. Get last applied sequence from server
    state = rpc("poi_sync_state_get", {"p_region": REGION})
    last_seq = None
    if state and isinstance(state, dict):
        last_seq = state.get("last_sequence")

    # 2. Get current sequence from Geofabrik
    remote_seq = fetch_remote_state()
    print(f"[delta] local last_seq={last_seq}, remote_seq={remote_seq}", flush=True)

    if last_seq is None:
        # First run — bootstrap from current remote (skip historical backfill,
        # the weekly full sync already covers us). Just record the pointer.
        print(f"[delta] no local state — bootstrapping at seq {remote_seq}", flush=True)
        if not DRY_RUN:
            rpc("poi_sync_state_set", {
                "p_region": REGION,
                "p_sequence": remote_seq,
                "p_kind": "delta",
                "p_stats": {"bootstrap": True},
            })
        return 0

    if remote_seq <= last_seq:
        # Latido. Este early-return es el "success" más común de este workflow
        # y hasta 2026-08-22 NO escribía estado: entre "corrió y no había nada
        # que aplicar" (sano) y "el workflow dejó de correr" (roto) la base veía
        # exactamente lo mismo — un last_sync_at que no se movía. Escribir acá
        # convierte poi_sync_state en un heartbeat honesto y es lo que le da
        # sentido al umbral de check_poi_sync_freshness() (00574).
        # Es un upsert idempotente con la MISMA secuencia: solo refresca los
        # timestamps, no avanza el puntero ni re-aplica nada.
        print(f"[delta] already up to date at seq {last_seq}", flush=True)
        if not DRY_RUN:
            rpc("poi_sync_state_set", {
                "p_region": REGION,
                "p_sequence": last_seq,
                "p_kind": "delta",
                "p_stats": {"heartbeat": True, "diffs_applied": 0},
            })
        return 0

    # 3. Walk sequences from last_seq+1 to remote_seq, applying each diff
    total_stats = {
        "inserted": 0, "updated": 0, "deactivated": 0,
        "skipped_admin": 0, "skipped_unmapped": 0,
        "diffs_applied": 0,
    }

    tmp_dir = Path("/tmp/osm-delta")
    tmp_dir.mkdir(exist_ok=True)

    seq = last_seq + 1
    while seq <= remote_seq:
        diff_path = tmp_dir / f"{seq}.osc.gz"
        if not download_diff(seq, diff_path):
            # 404 — Geofabrik state.txt was ahead of actual available files.
            # Stop walking; next run will resume.
            break

        # Parse the diff into events
        events: list[dict] = list(iter_osc_events(diff_path))
        print(f"[delta] seq {seq}: parsed {len(events)} POI events", flush=True)

        # Batch the events through the RPC
        if not DRY_RUN and events:
            for i in range(0, len(events), BATCH_SIZE):
                batch = events[i:i + BATCH_SIZE]
                result = rpc("apply_osm_delta_batch", {"p_events": batch})
                for k in ("inserted", "updated", "deactivated", "skipped_admin", "skipped_unmapped"):
                    total_stats[k] += result.get(k, 0)

        # Cleanup diff file (keep disk clean even on long runs)
        try:
            diff_path.unlink()
        except OSError:
            pass

        total_stats["diffs_applied"] += 1
        seq += 1

    # 4. Persist new state
    new_seq = seq - 1
    print(f"[delta] done — advanced to seq {new_seq}", flush=True)
    print(f"[delta] stats: {json.dumps(total_stats)}", flush=True)

    if not DRY_RUN:
        rpc("poi_sync_state_set", {
            "p_region": REGION,
            "p_sequence": new_seq,
            "p_kind": "delta",
            "p_stats": total_stats,
        })

    # Emit GH Actions output for the workflow to consume
    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        with open(gh_output, "a") as f:
            f.write(f"inserted={total_stats['inserted']}\n")
            f.write(f"updated={total_stats['updated']}\n")
            f.write(f"deactivated={total_stats['deactivated']}\n")
            f.write(f"skipped_admin={total_stats['skipped_admin']}\n")
            f.write(f"diffs_applied={total_stats['diffs_applied']}\n")
            f.write(f"new_sequence={new_seq}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
