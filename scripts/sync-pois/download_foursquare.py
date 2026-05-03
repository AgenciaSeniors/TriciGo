#!/usr/bin/env python3
"""
Download Foursquare OS Places parquet, filter to a bbox, save locally.

Foursquare publishes monthly snapshots on HuggingFace as Parquet shards
under ``release/dt=YYYY-MM-DD/places/parquet/places_NNNNNN.parquet``.
For a Cuba-only sync we only need a few rows per shard. Strategy:

  1. Auto-detect the latest release date (scan ``release/`` directory).
  2. List shards under ``places/parquet/`` (skip the ``categories/`` and
     other non-places subdirs that the early version of this script was
     accidentally picking up — see commit history).
  3. For each shard, stream-read the parquet and keep only rows in bbox.
  4. Concat keepers into one local parquet.

For Cuba bbox (-85,19.5,-74,23.5) result is typically ~10K-30K rows / ~5MB.

Important: the foursquare/fsq-os-places dataset is **gated** on HuggingFace.
Beyond setting HF_TOKEN, the token's owner must visit the dataset page once
and click "Agree and access repository". Without that, downloads return 403.

Usage:
  python download_foursquare.py --bbox -85,19.5,-74,23.5 --out /tmp/fsq.parquet

Env:
  HF_TOKEN   HuggingFace access token (required, free)
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

DATE_PATTERN = re.compile(r"^release/dt=(\d{4}-\d{2}-\d{2})/")


def latest_release(files: list[str]) -> str | None:
    """Return the latest ``YYYY-MM-DD`` release date present in the listing."""
    dates = set()
    for f in files:
        m = DATE_PATTERN.match(f)
        if m:
            dates.add(m.group(1))
    return max(dates) if dates else None


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bbox", required=True, help="west,south,east,north")
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--dataset", default="foursquare/fsq-os-places")
    p.add_argument(
        "--release",
        default="latest",
        help="Release date YYYY-MM-DD or 'latest' to auto-detect",
    )
    args = p.parse_args()

    bbox = tuple(map(float, args.bbox.split(",")))
    if len(bbox) != 4:
        print(f"--bbox needs w,s,e,n; got {args.bbox}", file=sys.stderr)
        return 2
    w, s, e, n = bbox

    try:
        from huggingface_hub import HfApi, hf_hub_download
        from huggingface_hub.errors import HfHubHTTPError
    except ImportError:
        print("ERROR: pip install huggingface_hub", file=sys.stderr)
        return 2

    token = os.environ.get("HF_TOKEN")
    if not token:
        print(
            "ERROR: HF_TOKEN env var is required. Get a free token at "
            "https://huggingface.co/settings/tokens",
            file=sys.stderr,
        )
        return 2
    api = HfApi(token=token)

    print(f"[fsq] listing files in {args.dataset}…", flush=True)
    try:
        files = api.list_repo_files(args.dataset, repo_type="dataset")
    except HfHubHTTPError as exc:
        print(
            f"ERROR: HuggingFace returned {exc.response.status_code} when listing the "
            f"dataset. If 403, the dataset is gated — visit "
            f"https://huggingface.co/datasets/{args.dataset} and click "
            f"'Agree and access repository' with the same account that owns the token.",
            file=sys.stderr,
        )
        return 1

    # Resolve release date
    if args.release == "latest":
        resolved = latest_release(files)
        if not resolved:
            print(
                f"ERROR: could not detect a release/dt=YYYY-MM-DD/ subdir in "
                f"{args.dataset}. Inspect "
                f"https://huggingface.co/datasets/{args.dataset}/tree/main/release",
                file=sys.stderr,
            )
            return 1
        release = resolved
        print(f"[fsq] auto-detected latest release: {release}", flush=True)
    else:
        release = args.release

    # Filter strictly to places/parquet/places_*.parquet — the dataset also has
    # categories/parquet/categories_*.parquet (taxonomy, no rows we need)
    # which broke the earlier wildcard filter.
    prefix = f"release/dt={release}/places/parquet/"
    shard_paths = [
        f for f in files
        if f.startswith(prefix) and f.endswith(".parquet")
    ]
    if not shard_paths:
        print(
            f"[fsq] no shards found under {prefix}. Available release dates: "
            f"{sorted(set(DATE_PATTERN.match(f).group(1) for f in files if DATE_PATTERN.match(f)))}",
            file=sys.stderr,
        )
        return 1
    print(f"[fsq] release={release} — found {len(shard_paths)} place shards", flush=True)

    keepers: list[pa.Table] = []
    skipped_403 = 0
    for i, shard_path in enumerate(shard_paths, 1):
        try:
            local = hf_hub_download(
                repo_id=args.dataset,
                filename=shard_path,
                repo_type="dataset",
                token=token,
            )
        except HfHubHTTPError as exc:
            status = getattr(exc.response, "status_code", "?")
            if status == 403:
                # Gated dataset — log once and continue. Failing the whole
                # job for one bad shard would lose the rest of the data.
                if skipped_403 == 0:
                    print(
                        f"::warning::Foursquare shard {shard_path} returned 403 "
                        "(gated dataset?). Visit "
                        f"https://huggingface.co/datasets/{args.dataset} and "
                        "click 'Agree and access repository' with the token's "
                        "account, then re-run.",
                        file=sys.stderr,
                    )
                skipped_403 += 1
                continue
            raise

        # Stream-read only the columns we use
        try:
            table = pq.read_table(
                local,
                columns=[
                    "fsq_place_id", "name", "latitude", "longitude",
                    "address", "locality", "region", "country", "postcode",
                    "tel", "website", "facebook_id", "instagram", "twitter",
                    "fsq_category_ids", "fsq_category_labels",
                    "date_created", "date_refreshed", "date_closed",
                ],
            )
        except (pa.ArrowInvalid, KeyError) as exc:
            # Some shards may have a different column layout (e.g. older
            # snapshots used different column names). Skip with a warning
            # rather than crashing the whole pipeline.
            print(
                f"::warning::shard {shard_path} has unexpected columns "
                f"({exc!s}); skipping",
                file=sys.stderr,
            )
            continue

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
        print(
            f"[fsq] shard {i}/{len(shard_paths)}: {len(df)} rows in shard, "
            f"{len(kept)} kept after bbox filter",
            flush=True,
        )

    if skipped_403 > 0:
        print(
            f"::warning::Skipped {skipped_403} shards on 403. If all shards "
            "skipped, the dataset is gated and the token owner needs to "
            "accept the dataset terms on HuggingFace web UI.",
            file=sys.stderr,
        )

    if not keepers:
        # Either the dataset is gated and all shards 403'd, or the token is
        # fine but the bbox has zero matching rows. Write an empty placeholder
        # parquet either way so the downstream merge step still runs with
        # OSM + Overture and the operator gets a clear log line. Failing the
        # whole workflow for a missing third source would be a brittle policy.
        if skipped_403 == len(shard_paths):
            print(
                "::warning::Every Foursquare shard returned 403 — likely the "
                f"HF_TOKEN account has not accepted the gated dataset terms at "
                f"https://huggingface.co/datasets/{args.dataset}. Continuing "
                "with OSM + Overture only.",
                file=sys.stderr,
            )
        else:
            print(
                f"[fsq] no rows in bbox {args.bbox} after scanning all shards; "
                "writing empty parquet placeholder",
                file=sys.stderr,
            )
        empty = pa.Table.from_pylist([], schema=pa.schema([
            ("fsq_place_id", pa.string()),
            ("name", pa.string()),
            ("latitude", pa.float64()),
            ("longitude", pa.float64()),
        ]))
        args.out.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(empty, args.out)
        return 0

    combined = pa.concat_tables(keepers, promote_options="default")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(combined, args.out)
    print(f"[fsq] wrote {combined.num_rows} rows to {args.out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
