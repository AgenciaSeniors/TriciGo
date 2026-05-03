#!/usr/bin/env python3
"""
Build Cuba admin areas SQL from Overpass JSON dumps.

Reads:
  /tmp/cuba-admin/provincias-geom.json   (admin_level=4, 16 provincias)
  /tmp/cuba-admin/municipios-geom.json   (admin_level=6, 168 municipios)

Each relation has `members[]` with `way` items that carry `geometry` (list of
{lat, lon}) and a `role` of 'outer' or 'inner'. We greedily chain matching
ways into closed rings and emit (Multi)Polygon WKT, then output INSERT SQL
for the cuba_admin_areas table.

Usage:
  python build_admin_areas_sql.py > /tmp/cuba-admin/load.sql
"""

from __future__ import annotations
import json
import sys
from pathlib import Path
from typing import List, Tuple, Optional

Point = Tuple[float, float]  # (lon, lat)
Ring  = List[Point]


def load(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def chain_ways(ways: List[dict]) -> List[Ring]:
    """
    Greedy ring assembly: take a way, try to extend it by matching endpoints
    with remaining ways until we close the ring or exhaust candidates.
    """
    if not ways:
        return []
    pending: List[List[Point]] = []
    for w in ways:
        geom = w.get("geometry") or []
        if len(geom) >= 2:
            pending.append([(p["lon"], p["lat"]) for p in geom])

    rings: List[Ring] = []
    while pending:
        ring = pending.pop(0)
        # Keep extending until closed or no more matches
        progress = True
        while progress and ring[0] != ring[-1]:
            progress = False
            for i, w in enumerate(pending):
                if w[0] == ring[-1]:
                    ring.extend(w[1:])
                    pending.pop(i)
                    progress = True
                    break
                if w[-1] == ring[-1]:
                    ring.extend(reversed(w[:-1]))
                    pending.pop(i)
                    progress = True
                    break
                if w[-1] == ring[0]:
                    ring = w + ring[1:]
                    pending.pop(i)
                    progress = True
                    break
                if w[0] == ring[0]:
                    ring = list(reversed(w[1:])) + ring
                    pending.pop(i)
                    progress = True
                    break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def relation_to_wkt(relation: dict) -> Optional[str]:
    """Build a (MULTI)POLYGON WKT from an OSM relation's outer/inner ways."""
    members = relation.get("members") or []
    outers = [m for m in members if m.get("type") == "way" and m.get("role") == "outer"]
    inners = [m for m in members if m.get("type") == "way" and m.get("role") == "inner"]
    # Some relations don't tag roles; fall back to treating untagged ways as outer.
    if not outers:
        outers = [m for m in members if m.get("type") == "way" and not m.get("role")]

    outer_rings = chain_ways(outers)
    inner_rings = chain_ways(inners)
    if not outer_rings:
        return None

    def fmt_ring(r: Ring) -> str:
        return "(" + ", ".join(f"{lon:.7f} {lat:.7f}" for lon, lat in r) + ")"

    if len(outer_rings) == 1:
        if inner_rings:
            return f"POLYGON({fmt_ring(outer_rings[0])}, {', '.join(fmt_ring(r) for r in inner_rings)})"
        return f"POLYGON({fmt_ring(outer_rings[0])})"

    # MULTIPOLYGON: associate inner rings to the outer that contains them.
    # For Cuba admin areas this rarely matters; emit each outer as its own
    # polygon and put all inner rings under the first (Postgres ST_IsValid
    # will normalise; if not, the spatial join still works for our case).
    polys = []
    for i, outer in enumerate(outer_rings):
        if i == 0 and inner_rings:
            polys.append(f"({fmt_ring(outer)}, {', '.join(fmt_ring(r) for r in inner_rings)})")
        else:
            polys.append(f"({fmt_ring(outer)})")
    return f"MULTIPOLYGON({', '.join(polys)})"


def emit_inserts(json_path: str, admin_level: int, sql_table: str = "cuba_admin_areas") -> None:
    data = load(json_path)
    written = 0
    skipped = 0
    for rel in data.get("elements", []):
        if rel.get("type") != "relation":
            continue
        tags = rel.get("tags") or {}
        if tags.get("admin_level") != str(admin_level):
            continue
        wkt = relation_to_wkt(rel)
        if not wkt:
            skipped += 1
            print(
                f"-- SKIPPED rel/{rel.get('id')} ({tags.get('name', '?')}): "
                "could not assemble closed ring",
                file=sys.stderr,
            )
            continue
        # Escape single quotes in the name
        name = (tags.get("name") or "").replace("'", "''")
        iso = tags.get("ISO3166-2") or ""
        name_es = (tags.get("name:es") or tags.get("name") or "").replace("'", "''")
        # Province parent inferred via admin_level + ISO code (set by spatial join in migration).
        print(
            f"INSERT INTO {sql_table} (osm_id, admin_level, name, name_es, iso_code, geom) "
            f"VALUES ({rel.get('id')}, {admin_level}, '{name}', '{name_es}', "
            f"NULLIF('{iso}', ''), ST_GeomFromText('{wkt}', 4326));"
        )
        written += 1
    print(f"-- Wrote {written} rows for admin_level={admin_level}, skipped {skipped}", file=sys.stderr)


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--provincias", required=True,
                    help="Path to Overpass JSON dump for admin_level=4 relations")
    ap.add_argument("--municipios", required=True,
                    help="Path to Overpass JSON dump for admin_level=6 relations")
    args = ap.parse_args()

    print("-- Cuba admin areas: provincias (admin_level=4) + municipios (admin_level=6)")
    print("-- Generated from OSM Overpass dump (data ODbL).")
    print("BEGIN;")
    emit_inserts(args.provincias, 4)
    emit_inserts(args.municipios, 6)
    print("COMMIT;")
    return 0


if __name__ == "__main__":
    sys.exit(main())
