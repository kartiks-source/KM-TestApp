# 0003. JSON-file store now, move on a measured trigger

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder, builder

## Context

Stock-out Watch keeps everything in one `DATA_DIR/store.json` on a Railway volume, one replica, plain Node with zero dependencies. Demo data is 1.9 MB; the report takes ~21 ms at 50k orders and ~120 ms at 100k stock + 84k orders. Weak points found in review: whole-file synchronous rewrites, silent replacement on a bad read (fixed in SW-004), no backups (SW-005), no schema version (SW-047). Options: keep JSON, `node:sqlite` (built in, keeps zero deps), Postgres (needs a service and a driver dependency).

## Decision

Keep the JSON file for now, hardened by SW-004/SW-005. Move when any trigger is hit:

| Trigger | Move to |
|---|---|
| `store.json` > 50 MB, or > 300k rows, or report p95 > 500 ms | `node:sqlite` with WAL on the same volume |
| More than one store per deploy, or need for more than one replica | Postgres |
| A second team or module needs to query the data | Postgres |

The `store.js` interface (add, replaceOrders, replaceAll, settings) stays the boundary so the engine doesn't change.

## Consequences

- No database to run today; backups are a file copy.
- Single writer only: no replicas, no second instance on the same volume (ADR-0012).
- `/status` (SW-019) and a daily size log must report file size and row counts so the trigger is noticed, not guessed.
