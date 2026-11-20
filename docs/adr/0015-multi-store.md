# 0015. Several stores in one app: a folder per store, picked from the top bar

- Status: Accepted
- Date: 2026-11-20
- Deciders: owner (spec 19–20 Nov 2026); builder (layout and safety rules)

## Context

The Performity POC API (ADR-0014) returns every brand our key may use (`GET …/brands`) and a fresh token per brand. Until now the app pulled one store and `PERFORMITY_BRAND_ID` had to pick it when more than one was allowed. The owner wants every allowed brand in one app, switched from the store-name pill, without the numbers of two brands ever mixing. Data is a JSON file per store (ADR-0003); Railway runs one instance (ADR-0012); Performity allows 30 calls/min per IP and 10 token calls/min per brand, and the Shopify app's rate limit is shared with Performity's own pulls.

Options considered:
1. **A store id on every row** in one `store.json`. Every query, export, backup and side file would need a filter; one missed filter mixes brands. Rejected.
2. **One deployment per store.** Mixing impossible, but N Railway services, N passwords, N volumes, no picker. Rejected for now (still the fallback if a store outgrows ADR-0003's triggers).
3. **One folder per store** (`DATA_DIR/stores/<id>/`), each holding today's single-store files unchanged, and the code told which store it works for. Chosen.

## Decision

- **Registry** (`src/stores.js`): Performity → `keys.brands()`, store id = `brand_id` (lower case), name = `brand_name`, shop learned from its fresh-token; the last good list is kept in memory and `DATA_DIR/stores.json` so an API outage keeps the stores (their pulls fail with the reason). `PERFORMITY_BRAND_ID`, when set, limits the list to that brand. Key Vault → `STORES=<handle>,…` (else `SHOPIFY_STORE`). Railway variables → one store. No key → two clearly labelled demo stores (`Sammsara (demo)` seed 11, `Second store (demo)` with its own seed, two thirds of the catalog and prices × 0.6).
- **Store ids** are a uuid or `^[a-z0-9][a-z0-9-]{0,60}$`, and must be in the registry; anything else is a 404 before the file system is touched. No path traversal is possible: the id is the whole folder name.
- **Per-store data**: `DATA_DIR/stores/<id>/` holds `store.json` (rows, settings, Flow key, audit log, run history, digest settings), `onorder.json`, `decisions.json`, `catalog.json`, `backups/`, `restore.json`. Shared at the top: `secret` (sign-in) and `stores.json` (registry cache). Passwords and roles are for every store; the view-only role is read-only everywhere.
- **Which store** (`src/scope.js`): every request, pull, digest tick and daily backup runs inside `scope.run(id, fn)` (Node's `AsyncLocalStorage`, built in). The per-store modules ask `scope.dir()` for their folder and keep their in-memory state per folder. Outside `scope.run` there is no store: the call throws. There is no silent default, because a default is how stores would mix.
- **Requests**: every `/api` route and `/ingest/*` takes `?store=<id>`; without it, the `sw_store` cookie when it names a listed store, else the first store. `GET /api/stores` → `[{ id, name, demo, shop, status: { lastSync, lastError, stale, state } }]`.
- **Pulls**: one queue for all stores, one pull at a time. The 15-minute loop reads the brand list, then each store's sheet sync and Shopify pull in order. A manual "Pull now" joins the queue. Performity calls are spaced ≥ 2.1 s apart and token calls per brand ≥ 6.1 s apart in `src/keys.js`, under both limits even when a person presses Pull now repeatedly.
- **Alerts, status, digest name the store**: alerts per store (`Stock-out Watch (<name>)`), the digest title and webhook payload carry the store name and id, the digest link opens `/?store=<id>`, the PO CSV file name starts with the store name. `/status` (open) gives totals over all stores and no names or ids.
- **Migration**: on the first start, the old single-store files at the top of `DATA_DIR` move into their store's folder (the store `SHOPIFY_STORE` / `PERFORMITY_BRAND_ID` names when listed, else the first), once per `DATA_DIR`: when any store folder holds the marker, nothing moves again, so a later store-list change can't move a stray file into another store or stop the start: copy to `stores/.migrating-<id>/`, check every copy's SHA-256, write a marker with every file's hash, rename the folder (atomic), then delete each original whose hash still matches. A crash at any step either leaves the originals untouched or is finished on the next start; an original that changed after the copy is kept with a warning; a target folder that already holds other data stops the start with nothing touched.
- **UI**: the store pill is the picker (a menu with an ok / stale / error dot per store); choosing sets `?store=` in the address, `localStorage` and the `sw_store` cookie, and reloads. One store → the plain name. Every page call carries `?store=` explicitly, so two tabs on two stores never cross.

## Consequences

- Easier: a new Performity brand appears in the picker within 10 minutes of being allowed, with no deploy. Each store's data is exactly the old single-store layout, so backups, restore, FORMATS and the runbook still apply per folder.
- Harder: every new per-store module must resolve its path through `scope.dir()`; code that runs outside a request (timers) must wrap itself in `scope.run`. Tests cover the throw when it doesn't.
- Load: one process holds every opened store in memory. ADR-0003's move-to-Postgres trigger now counts the sum of all stores (watch `/status` `storeBytes`).
- Pull cadence: N stores × a pull each, one at a time. With many brands a full round can exceed 15 minutes; the next round then starts when the last ends (no overlap). Revisit if a round regularly takes over 10 minutes.
- Revisit when: a store needs its own password (per-store roles: done in ADR-0016), or the registry needs stores that aren't Performity brands alongside ones that are.
