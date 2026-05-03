#!/usr/bin/env python3
"""
TriciGo POI sync — merge + upsert.

Reads pre-downloaded POI data from the 3 supported sources (OSM extract,
Overture Places, Foursquare OS Places), merges duplicates by spatial+name
fuzzy match, maps taxonomies to TriciGo unified categories, and upserts to
the cuba_pois table in Supabase.

Designed to run as the final step of `.github/workflows/sync-pois.yml`.

Inputs (paths via env or CLI):
  --osm        path to OSM POIs GeoJSON (from osmium tags-filter)
  --overture   path to Overture Places GeoJSON (from overturemaps CLI)
  --foursquare path to Foursquare Parquet (from HuggingFace download)

Required env:
  SUPABASE_URL              project URL
  SUPABASE_SERVICE_ROLE     service role key

Optional env:
  DRY_RUN=1                 parse + dedup only, no DB writes
  BBOX=west,south,east,north  filter inputs to a bbox (default: all of Cuba)

Behaviour summary:
  - admin POIs (is_admin=true) are NEVER touched
  - non-admin rows matching a new merged record by source_ids → UPDATE
  - new merged records not in DB → INSERT
  - non-admin rows not seen in this run AND older than 60 days → set is_active=false
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

import pyarrow.parquet as pq
import rapidfuzz
from rtree import index as rtree_index
from unidecode import unidecode

# ──────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────

CUBA_BBOX = (-85.0, 19.5, -74.0, 23.5)  # west, south, east, north
DEDUP_RADIUS_M = 50
NAME_SIM_THRESHOLD = 0.80
MAX_BATCH_SIZE = 1000

# Per-field source preference (when fields conflict, pick from highest-prio source present)
PREFER_PHONE     = ["foursquare", "osm", "overture"]
PREFER_HOURS     = ["osm", "foursquare", "overture"]
PREFER_WEBSITE   = ["foursquare", "overture", "osm"]
PREFER_NAME      = ["osm", "foursquare", "overture"]  # OSM has most local Cuba context
PREFER_ADDRESS   = ["overture", "foursquare", "osm"]


@dataclass
class Record:
    name: str
    name_normalized: str
    lat: float
    lng: float
    source: str                                # one source if not yet merged
    source_ids: dict[str, str] = field(default_factory=dict)
    osm_id: int | None = None
    osm_type: str | None = None
    category: str | None = None                 # raw source category (OSM tag, FSQ id, etc.)
    subcategory: str | None = None
    tricigo_category: str | None = None
    address: str | None = None
    municipality: str | None = None
    province: str | None = None
    phone: str | None = None
    website: str | None = None
    socials: dict[str, str] | None = None
    hours: str | None = None
    confidence: float = 0.5

    def merge_with(self, other: "Record") -> "Record":
        """Combine two duplicate records preferring per-field best source."""
        merged_sources = {**self.source_ids, **other.source_ids}

        def pick(field_name: str, prefer: list[str]) -> Any:
            for src in prefer:
                # Pick value from whichever record has this source set
                for rec in (self, other):
                    if rec.source == src and getattr(rec, field_name):
                        return getattr(rec, field_name)
            # Fallback: any non-None value
            for rec in (self, other):
                if getattr(rec, field_name):
                    return getattr(rec, field_name)
            return None

        return Record(
            name=pick("name", PREFER_NAME) or self.name,
            name_normalized=normalize_name(pick("name", PREFER_NAME) or self.name),
            lat=(self.lat + other.lat) / 2,
            lng=(self.lng + other.lng) / 2,
            source="merged",
            source_ids=merged_sources,
            osm_id=self.osm_id or other.osm_id,
            osm_type=self.osm_type or other.osm_type,
            category=self.category or other.category,
            subcategory=self.subcategory or other.subcategory,
            tricigo_category=self.tricigo_category or other.tricigo_category,
            address=pick("address", PREFER_ADDRESS),
            municipality=self.municipality or other.municipality,
            province=self.province or other.province,
            phone=pick("phone", PREFER_PHONE),
            website=pick("website", PREFER_WEBSITE),
            socials={**(self.socials or {}), **(other.socials or {})} or None,
            hours=pick("hours", PREFER_HOURS),
            confidence=min(1.0, max(self.confidence, other.confidence) * 1.1),  # boost for double-source
        )


# ──────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────

def normalize_name(name: str) -> str:
    """Lowercase + strip accents for accent-insensitive matching."""
    return unidecode(name).lower().strip()


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Approximate great-circle distance in meters (Haversine)."""
    from math import asin, cos, radians, sin, sqrt
    R = 6_371_000
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return 2 * R * asin(sqrt(a))


def in_bbox(lng: float, lat: float, bbox: tuple[float, float, float, float]) -> bool:
    w, s, e, n = bbox
    return w <= lng <= e and s <= lat <= n


# ──────────────────────────────────────────────────────────────
# Category mapping
# ──────────────────────────────────────────────────────────────

def load_categories(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def map_osm_category(category: str | None, subcategory: str | None, mapping: dict) -> str | None:
    """category/subcategory are OSM tag/value, e.g. amenity/restaurant → 'restaurant'."""
    if not category:
        return None
    osm_map = mapping.get("osm", {})
    key = f"{category}={subcategory or ''}"
    if key in osm_map:
        return osm_map[key]
    wildcard = f"{category}=*"
    if wildcard in osm_map:
        return osm_map[wildcard]
    return None


def map_foursquare_category(label: str | None, mapping: dict) -> str | None:
    """Match by label substring. fsq_category_label e.g. 'Cuban Restaurant'."""
    if not label:
        return None
    label_norm = label.lower().replace(" ", "_").replace("-", "_")
    keywords = mapping.get("foursquare", {}).get("label_keywords", {})
    for keyword, tricigo in keywords.items():
        if keyword in label_norm:
            return tricigo
    return None


def map_overture_category(category: str | None, mapping: dict) -> str | None:
    if not category:
        return None
    cat_norm = category.lower()
    ovt_map = mapping.get("overture", {})
    if cat_norm in ovt_map.get("exact", {}):
        return ovt_map["exact"][cat_norm]
    for keyword, tricigo in ovt_map.get("substring", {}).items():
        if keyword in cat_norm:
            return tricigo
    return None


# ──────────────────────────────────────────────────────────────
# Source loaders
# ──────────────────────────────────────────────────────────────

def load_osm(path: Path, categories: dict, bbox: tuple) -> Iterable[Record]:
    """OSM GeoJSON from `osmium tags-filter ... -o file.geojson`."""
    if not path.exists():
        print(f"[osm] file not found: {path}, skipping", file=sys.stderr)
        return
    print(f"[osm] reading {path}…", flush=True)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    count = 0
    for feat in data.get("features", []):
        props = feat.get("properties", {}) or {}
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        lng, lat = geom["coordinates"][0], geom["coordinates"][1]
        if not in_bbox(lng, lat, bbox):
            continue
        name = props.get("name")
        if not name:
            continue
        # OSM has many tags; pick the dominant one for category
        for tag in ("amenity", "shop", "tourism", "leisure", "office", "historic", "healthcare", "public_transport"):
            if tag in props:
                category = tag
                subcategory = props[tag]
                break
        else:
            continue  # skip rows without a recognized POI tag

        osm_id = props.get("@id") or props.get("osm_id")
        osm_type = props.get("@type") or "node"
        if osm_id and "/" in str(osm_id):
            osm_type, osm_id = str(osm_id).split("/", 1)
        try:
            osm_id_int = int(osm_id) if osm_id is not None else None
        except (TypeError, ValueError):
            osm_id_int = None

        yield Record(
            name=name,
            name_normalized=normalize_name(name),
            lat=lat,
            lng=lng,
            source="osm",
            source_ids={"osm": f"{osm_type}/{osm_id}"} if osm_id_int else {},
            osm_id=osm_id_int,
            osm_type=osm_type,
            category=category,
            subcategory=subcategory,
            tricigo_category=map_osm_category(category, subcategory, categories),
            address=props.get("addr:street"),
            municipality=props.get("addr:city") or props.get("addr:municipality"),
            province=props.get("addr:province") or props.get("addr:state"),
            phone=props.get("phone") or props.get("contact:phone"),
            website=props.get("website") or props.get("contact:website"),
            hours=props.get("opening_hours"),
            confidence=0.5,
        )
        count += 1
    print(f"[osm] loaded {count} records", flush=True)


def load_overture(path: Path, categories: dict, bbox: tuple) -> Iterable[Record]:
    """Overture Places GeoJSON from `overturemaps download -t place ...`."""
    if not path.exists():
        print(f"[overture] file not found: {path}, skipping", file=sys.stderr)
        return
    print(f"[overture] reading {path}…", flush=True)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    count = 0
    for feat in data.get("features", []):
        props = feat.get("properties", {}) or {}
        geom = feat.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        lng, lat = geom["coordinates"]
        if not in_bbox(lng, lat, bbox):
            continue
        names_obj = props.get("names") or {}
        name = names_obj.get("primary") or props.get("name")
        if not name:
            continue
        cats = props.get("categories") or {}
        primary = cats.get("primary")
        ovt_id = props.get("id")
        confidence = float(props.get("confidence", 0.5) or 0.5)
        addresses = props.get("addresses") or []
        addr = addresses[0] if addresses else {}
        yield Record(
            name=name,
            name_normalized=normalize_name(name),
            lat=lat,
            lng=lng,
            source="overture",
            source_ids={"ovt": ovt_id} if ovt_id else {},
            category=primary,
            subcategory=None,
            tricigo_category=map_overture_category(primary, categories),
            address=addr.get("freeform"),
            municipality=addr.get("locality"),
            province=addr.get("region"),
            phone=(props.get("phones") or [None])[0],
            website=(props.get("websites") or [None])[0],
            socials={s.split("/")[2]: s for s in (props.get("socials") or []) if "/" in s} or None,
            confidence=confidence,
        )
        count += 1
    print(f"[overture] loaded {count} records", flush=True)


def load_foursquare(path: Path, categories: dict, bbox: tuple) -> Iterable[Record]:
    """Foursquare OS Places parquet from HuggingFace."""
    if not path.exists():
        print(f"[foursquare] file not found: {path}, skipping", file=sys.stderr)
        return
    print(f"[foursquare] reading {path}…", flush=True)
    table = pq.read_table(path)
    df = table.to_pylist()
    count = 0
    for row in df:
        lat = row.get("latitude")
        lng = row.get("longitude")
        if lat is None or lng is None:
            continue
        if not in_bbox(lng, lat, bbox):
            continue
        name = row.get("name")
        if not name:
            continue
        labels = row.get("fsq_category_labels") or []
        primary_label = labels[0] if labels else None
        socials = {}
        for k in ("instagram", "facebook_id", "twitter"):
            if row.get(k):
                socials[k] = row[k]
        yield Record(
            name=name,
            name_normalized=normalize_name(name),
            lat=lat,
            lng=lng,
            source="foursquare",
            source_ids={"fsq": row.get("fsq_place_id")} if row.get("fsq_place_id") else {},
            category=primary_label,
            subcategory=None,
            tricigo_category=map_foursquare_category(primary_label, categories),
            address=row.get("address"),
            municipality=row.get("locality"),
            province=row.get("region"),
            phone=row.get("tel"),
            website=row.get("website"),
            socials=socials or None,
            hours=None,
            confidence=0.7,
        )
        count += 1
    print(f"[foursquare] loaded {count} records", flush=True)


# ──────────────────────────────────────────────────────────────
# Dedup
# ──────────────────────────────────────────────────────────────

def dedup_records(records: list[Record]) -> list[Record]:
    """Spatial + name fuzzy dedup. Returns merged records.

    Uses an R-tree to find candidates within DEDUP_RADIUS_M for each record;
    pairs with name similarity > NAME_SIM_THRESHOLD are merged.
    """
    print(f"[dedup] processing {len(records)} records…", flush=True)
    if not records:
        return []

    # Build R-tree (lng/lat as float bbox of single point)
    idx = rtree_index.Index()
    for i, r in enumerate(records):
        idx.insert(i, (r.lng, r.lat, r.lng, r.lat))

    # Buffer ~50m in degrees: 50/111000 ≈ 0.00045 lat, varies for lng but close enough at Cuba lat
    buffer_deg = DEDUP_RADIUS_M / 111_000

    union: list[int] = list(range(len(records)))  # union-find roots

    def find(x: int) -> int:
        while union[x] != x:
            union[x] = union[union[x]]
            x = union[x]
        return x

    def merge(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            union[max(ra, rb)] = min(ra, rb)

    for i, r in enumerate(records):
        nearby = idx.intersection(
            (r.lng - buffer_deg, r.lat - buffer_deg, r.lng + buffer_deg, r.lat + buffer_deg)
        )
        for j in nearby:
            if j <= i:
                continue
            other = records[j]
            d = haversine_m(r.lat, r.lng, other.lat, other.lng)
            if d > DEDUP_RADIUS_M:
                continue
            sim = rapidfuzz.fuzz.ratio(r.name_normalized, other.name_normalized) / 100
            if sim >= NAME_SIM_THRESHOLD:
                merge(i, j)

    # Group by root, merge each group
    groups: dict[int, list[int]] = {}
    for i in range(len(records)):
        groups.setdefault(find(i), []).append(i)

    merged: list[Record] = []
    for root, indexes in groups.items():
        if len(indexes) == 1:
            merged.append(records[indexes[0]])
        else:
            base = records[indexes[0]]
            for i in indexes[1:]:
                base = base.merge_with(records[i])
            merged.append(base)

    print(f"[dedup] {len(records)} → {len(merged)} after merging duplicates", flush=True)
    return merged


# ──────────────────────────────────────────────────────────────
# Supabase upsert
# ──────────────────────────────────────────────────────────────

UPSERT_BATCH_SIZE = 5000  # rows per RPC call — Postgres+Supabase comfortably handle this

def upsert_to_supabase(records: list[Record], dry_run: bool) -> dict[str, int]:
    """Upsert records to cuba_pois preserving admin overrides.

    Calls the `bulk_upsert_pois(JSONB)` RPC (migration 00250) which does
    the insert/update split server-side in a single transaction per
    batch. The previous client-side per-row UPDATE loop took ~16 min for
    20K rows and didn't fit in the 30-minute workflow timeout for full
    Cuba (~80K+ rows).

    Behavior rules (enforced server-side, mirror Python intent):
      - Rows with `is_admin = TRUE` are NEVER touched.
      - Match by any shared (key, value) entry in source_ids.
      - Sync-managed columns get rewritten; admin-set values preserved.
    """
    if dry_run:
        print(f"[upsert] DRY_RUN — would write {len(records)} records", flush=True)
        sample = records[:5] if records else []
        for r in sample:
            print(f"  • {r.name} ({r.tricigo_category}) @ {r.lat:.4f},{r.lng:.4f} src={r.source}", flush=True)
        return {"would_insert": len(records), "would_update": 0, "skipped_admin": 0}

    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE"]
    sb = create_client(url, key)

    def to_payload(r: Record) -> dict:
        """Marshal a Record into the JSONB shape the RPC expects."""
        return {
            "name": r.name,
            "name_normalized": r.name_normalized,
            "category": r.category or "other",
            "subcategory": r.subcategory,
            "tricigo_category": r.tricigo_category,
            "address": r.address,
            "municipality": r.municipality,
            "province": r.province,
            "lat": r.lat,
            "lng": r.lng,
            "source": "merged" if len(r.source_ids) > 1 else r.source,
            "source_ids": r.source_ids,
            "phone": r.phone,
            "website": r.website,
            "socials": r.socials,
            "hours": r.hours,
            "confidence": r.confidence,
            "osm_id": r.osm_id,
            "osm_type": r.osm_type,
        }

    total_inserted = 0
    total_updated = 0
    total_skipped = 0
    total = len(records)

    for chunk_start in range(0, total, UPSERT_BATCH_SIZE):
        chunk = records[chunk_start:chunk_start + UPSERT_BATCH_SIZE]
        payload = [to_payload(r) for r in chunk]
        try:
            resp = sb.rpc("bulk_upsert_pois", {"p_records": payload}).execute()
        except Exception as exc:
            print(f"[upsert] batch starting at {chunk_start} failed: {exc!r}", file=sys.stderr)
            raise
        # bulk_upsert_pois returns a single row (i, u, s) — supabase-py
        # surfaces it as a list of dicts.
        rows = resp.data or []
        if rows:
            row = rows[0]
            ins = int(row.get("inserted_count") or 0)
            upd = int(row.get("updated_count") or 0)
            skp = int(row.get("skipped_admin_count") or 0)
        else:
            ins = upd = skp = 0
        total_inserted += ins
        total_updated += upd
        total_skipped += skp
        print(
            f"[upsert] batch {chunk_start // UPSERT_BATCH_SIZE + 1}: "
            f"+{ins} inserted, {upd} updated, {skp} skipped (admin) "
            f"({chunk_start + len(chunk)}/{total} total processed)",
            flush=True,
        )

    return {
        "inserted": total_inserted,
        "updated": total_updated,
        "skipped_admin": total_skipped,
    }


# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="TriciGo POI sync — merge + upsert")
    p.add_argument("--osm", type=Path, default=Path("/tmp/osm-pois.geojson"))
    p.add_argument("--overture", type=Path, default=Path("/tmp/overture.geojson"))
    p.add_argument("--foursquare", type=Path, default=Path("/tmp/foursquare.parquet"))
    p.add_argument("--categories", type=Path, default=Path(__file__).parent / "categories.json")
    p.add_argument("--bbox", default=os.environ.get("BBOX", ",".join(map(str, CUBA_BBOX))))
    args = p.parse_args()

    bbox = tuple(map(float, args.bbox.split(",")))
    if len(bbox) != 4:
        print(f"BBOX must have 4 values: w,s,e,n. Got: {args.bbox}", file=sys.stderr)
        return 2
    dry_run = os.environ.get("DRY_RUN") == "1"

    categories = load_categories(args.categories)
    print(f"[main] loaded {len(categories.get('osm', {}))} OSM mappings", flush=True)

    all_records: list[Record] = []
    all_records.extend(load_osm(args.osm, categories, bbox))
    all_records.extend(load_overture(args.overture, categories, bbox))
    all_records.extend(load_foursquare(args.foursquare, categories, bbox))

    if not all_records:
        print("[main] no records loaded — nothing to do", file=sys.stderr)
        return 1

    print(f"[main] {len(all_records)} total records before dedup", flush=True)
    merged = dedup_records(all_records)

    stats = upsert_to_supabase(merged, dry_run=dry_run)
    print(f"[main] done: {stats}", flush=True)

    # Output for GH Actions step summary + downstream steps
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write(f"inserted={stats.get('inserted', stats.get('would_insert', 0))}\n")
            f.write(f"updated={stats.get('updated', stats.get('would_update', 0))}\n")
            f.write(f"skipped_admin={stats.get('skipped_admin', 0)}\n")
            f.write(f"total={len(merged)}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
