#!/usr/bin/env python3
"""
Load Cuba admin areas (provincias + municipios) from Overpass JSON dumps
into the Supabase `cuba_admin_areas` table, then trigger the spatial
backfill of cuba_pois.province + municipality.

Reads:
  --provincias  Overpass JSON for admin_level=4 relations
  --municipios  Overpass JSON for admin_level=6 relations

Env (required):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE   (sb_secret_*, not legacy JWT)

Behaviour:
  1. Truncate cuba_admin_areas (idempotent)
  2. Insert each polygon as a row using ST_GeomFromText
  3. Call run_cuba_admin_backfill() RPC and print step counts

Usage (local):
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE=sb_secret_... \
      python scripts/backfill-cuba-geo/load_admin_areas.py \
      --provincias /tmp/cuba-admin/provincias-geom.json \
      --municipios /tmp/cuba-admin/municipios-geom.json
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import List, Tuple, Optional

# Reuse polygon assembly from build_admin_areas_sql.py — same chain logic
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_admin_areas_sql import relation_to_wkt  # noqa: E402


def iter_relations(json_path: str, admin_level: int):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    for rel in data.get("elements", []):
        if rel.get("type") != "relation":
            continue
        if (rel.get("tags") or {}).get("admin_level") != str(admin_level):
            continue
        yield rel


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provincias", required=True)
    ap.add_argument("--municipios", required=True)
    ap.add_argument("--no-truncate", action="store_true",
                    help="Skip TRUNCATE before insert (use to append)")
    ap.add_argument("--no-backfill", action="store_true",
                    help="Skip run_cuba_admin_backfill() after load")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE")
    if not url or not key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE env vars are required",
              file=sys.stderr)
        return 2

    try:
        from supabase import create_client
    except ImportError:
        print("ERROR: pip install supabase", file=sys.stderr)
        return 2

    sb = create_client(url, key)
    rest = f"{url}/rest/v1"

    # 1. TRUNCATE (idempotent reload)
    if not args.no_truncate:
        # Supabase-py doesn't expose TRUNCATE directly, use rpc
        # We'll just delete all rows — same effect, slightly slower.
        # For 0-200 rows this is negligible.
        print("[load] clearing existing cuba_admin_areas rows…", flush=True)
        sb.table("cuba_admin_areas").delete().neq("id", 0).execute()

    # 2. Insert each polygon. We use a tiny RPC `insert_cuba_admin_area`
    #    so that the WKT → geometry conversion happens server-side and
    #    we don't have to convert to GeoJSON or EWKB on the client.
    #    The RPC is created in migration 00254a (added below if missing).
    #    Idempotent: ON CONFLICT (osm_id) DO UPDATE.
    inserts = 0
    for level, path in ((4, args.provincias), (6, args.municipios)):
        print(f"[load] admin_level={level} from {path}…", flush=True)
        for rel in iter_relations(path, level):
            tags = rel.get("tags") or {}
            wkt = relation_to_wkt(rel)
            if not wkt:
                continue
            payload = {
                "p_osm_id": rel.get("id"),
                "p_admin_level": level,
                "p_name": tags.get("name") or "?",
                "p_name_es": tags.get("name:es") or tags.get("name") or "?",
                "p_iso_code": tags.get("ISO3166-2") or None,
                "p_wkt": wkt,
            }
            try:
                sb.rpc("insert_cuba_admin_area", payload).execute()
                inserts += 1
                if inserts % 25 == 0:
                    print(f"[load]   {inserts} rows inserted", flush=True)
            except Exception as exc:
                print(f"[load]   FAILED rel/{rel.get('id')} {tags.get('name')}: {exc!r}",
                      file=sys.stderr)
                raise

    print(f"[load] total rows inserted: {inserts}", flush=True)

    # 3. Run the spatial backfill
    if not args.no_backfill:
        print("[backfill] calling run_cuba_admin_backfill()…", flush=True)
        resp = sb.rpc("run_cuba_admin_backfill").execute()
        for step in resp.data or []:
            print(f"[backfill]   {step['step']}: {step['rows_affected']:,}", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())
