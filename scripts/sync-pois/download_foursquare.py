#!/usr/bin/env python3
"""
Download Foursquare OS Places parquet, filter to a bbox, save locally.

Foursquare publishes monthly snapshots on HuggingFace as Parquet shards
(~50 files of ~50MB each). For a Cuba-only sync we only need a few rows
per shard. Strategy:

  1. List shards in the latest release on HuggingFace
  2. For each shard, stream-read the parquet and keep only rows in bbox
  3. Concat keepers into one local parquet

For Cuba bbox (-85,19.5,-74,23.5) result is typically ~10K-30K rows / ~5MB.

Usage:
  python download_foursquare.py --bbox -85,19.5,-74,23.5 --out /tmp/fsq.parquet

Env:
  HF_TOKEN   HuggingFace access token (free, required for dataset download)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", required=True, help="west,south,east,north")
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--dataset", default="foursquare/fsq-os-places")
    p.add_argument("--release", default="2026-04-14",
                   help="Latest release date string (YYYY-MM-DD)")
    args = p.parse_args()

    bbox = tuple(map(float, args.bbox.split(",")))
    if len(bbox) != 4:
        print(f"--bbox needs w,s,e,n; got {args.bbox}", file=sys.stderr)
        return 2
    w, s, e, n = bbox

    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError:
        print("ERROR: pip install huggingface_hub", file=sys.stderr)
        return 2

    token = os.environ.get("HF_TOKEN")
    api = HfApi(token=token)

    print(f"[fsq] listing shards in {args.dataset} @ {args.release}…", flush=True)
    files = api.list_repo_files(args.dataset, repo_type="dataset")
    shard_paths = [
        f for f in files
        if f.startswith(f"release/dt={args.release}/") and f.endswith(".parquet")
    ]
    if not shard_paths:
        print(f"[fsq] no shards found for release {args.release}. "
              f"Check https://huggingface.co/datasets/{args.dataset}/tree/main/release",
              file=sys.stderr)
        return 1
    print(f"[fsq] found {len(shard_paths)} shards", flush=True)

    keepers: list[pa.Table] = []
    for i, shard_path in enumerate(shard_paths, 1):
        local = hf_hub_download(
            repo_id=args.dataset,
            filename=shard_path,
            repo_type="dataset",
            token=token,
        )
        # Stream-read only the columns we use, with row-group filter
        table = pq.read_table(local, columns=[
            "fsq_place_id", "name", "latitude", "longitude",
            "address", "locality", "region", "country", "postcode",
            "tel", "website", "facebook_id", "instagram", "twitter",
            "fsq_category_ids", "fsq_category_labels",
            "date_created", "date_refreshed", "date_closed",
        ])
        # Filter Cuba bbox in-memory
        df = table.to_pandas()
        keep_mask = (
            (df["longitude"] >= w) & (df["longitude"] <= e) &
            (df["latitude"]  >= s) & (df["latitude"]  <= n) &
            df["date_closed"].isna()        # exclude closed places
        )
        kept = df[keep_mask]
        if len(kept) > 0:
            keepers.append(pa.Table.from_pandas(kept))
        print(f"[fsq] shard {i}/{len(shard_paths)}: kept {len(kept)} rows", flush=True)

    if not keepers:
        print("[fsq] no rows in bbox — nothing to write", file=sys.stderr)
        return 1

    combined = pa.concat_tables(keepers)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(combined, args.out)
    print(f"[fsq] wrote {combined.num_rows} rows to {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
