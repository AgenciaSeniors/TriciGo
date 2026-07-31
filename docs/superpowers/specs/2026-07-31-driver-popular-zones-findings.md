# Driver "popular zones" — why it never worked, and the options

**Status:** investigated 2026-07-31. **Deferred by decision** — the toggle stays hidden; no work scheduled.
**Scope:** findings and options only. Nothing here is approved for implementation.
**Related:** commit `721a3f17` (hides the toggle while the layer has nothing to paint).

## The finding

`public.popular_locations` in production is **a plain TABLE, not a materialized view**. It is empty — 16 kB, just the structure and indexes.

Migration `00083_popular_locations.sql` declares `CREATE MATERIALIZED VIEW … GROUP BY type, ST_ClusterDBSCAN(…) OVER ()`. Postgres rejects that outright:

```
ERROR: 42P20: window functions are not allowed in GROUP BY
```

So the statement could never have run. What exists is a table with the right columns — enough for the RPC `get_popular_locations` to compile and return zero rows forever. The daily refresh cron the migration also declares (`refresh-popular-locations`) is absent too, which follows: `REFRESH MATERIALIZED VIEW` against a table fails.

**The feature was never deployed.** It was not data-starved, and the cron was not "lost" — the object is the wrong kind of thing.

For contrast, `hourly_demand_cells` **is** a real materialized view (populated, 56 kB) with a working hourly cron (`refresh-hourly-demand-cells`, jobid 16). It reads 0 rows only because its own threshold — 3+ rides in the same cell, day-of-week and hour over 28 days — is not met yet.

## There is enough data today

Replaying the clustering logic against production (read-only, 2026-07-31):

| Rule | Zones that would appear |
|---|---|
| Current rule (completed rides only) | **6** |
| Including canceled requests | **16** |
| Including canceled, minpoints 2 | 28 |
| Including canceled, eps ~330 m | 18 |

Ride counts: 24 completed, 85 canceled, 1 searching. **78 of the 85 canceled requests never had a driver assigned** — 26 distinct riders across many days, not test noise.

Platform shape at the time of writing: **280 riders (269 registered in the last 30 days) against 4 drivers.** The constraint is supply, not demand.

## Option A — fix the aggregate (server-side only)

Drop the broken table, create the materialized view with valid SQL (subquery instead of the window function in `GROUP BY`), schedule the refresh cron.

- No new data collection, no privacy-policy change, no app changes, no rebuild.
- The toggle and the pins are already written; commit `721a3f17` makes the button appear on its own once the view has rows.
- Open product question: count completed rides only (6 zones) or all requests including canceled (16). The argument for including canceled: for a driver deciding where to wait, "people asked here and nobody came" is worth more than "a ride happened here that someone already served".
- A second question if this is ever picked up: the original design mixed pickups and dropoffs with ↓↑ arrows. For a "where should I wait" layer, pickups alone are the more honest signal.

## Option B — live rider presence (declined 2026-07-31)

Designed in conversation, then declined as too much risk. Recorded so the reasoning is not re-derived.

The idea: show how many riders have the app open nearby, right now. The design reached was coarse grid cells (~500 m) computed **server-side** from coordinates the client sends, one row per rider keyed by `user_id` so each visit overwrites the last — no movement history can exist because there is nowhere to store it — a 30-minute window, and a k-anonymity floor of 3 distinct riders per cell. Visually it becomes a circle covering the cell, never a pin: a pin would imply precision the design deliberately destroys.

Why it was declined:

- It requires recording where riders are **when they are not requesting anything** — a new purpose of processing, needing a privacy-policy update (the policy lives in the CMS, `cms_content`).
- Even aggregated, the platform would hold a live map of where its user base is.
- It requires changes to both apps and a new build.
- It collides with the existing demand layer (`HotspotPulseMarker`), which is also orange and also live. Adding a third orange live thing makes the map unreadable; that collision was never resolved.

Disproportionate for 4 drivers. If it is ever revisited, the privacy prerequisites above are the gate, not the code.

## What is true right now

The toggle is hidden and will stay hidden, because the underlying object is empty and nothing populates it. That is the honest state: no dead switch on the driver's screen. Nothing further is scheduled.
