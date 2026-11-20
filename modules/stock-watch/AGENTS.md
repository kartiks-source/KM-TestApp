# Module: stock-watch (Stock-out Watch web app)

Read the root `AGENTS.md` first. This file is this module's working memory: keep it current.

## What it does

Shows a D2C brand which products to reorder before they run out, and how many ₹ every stock-out cost in sales. The user is the brand or its agency. The question it answers: "was a bad sales day the ads, or an empty shelf?"

Live: https://web-production-6dd42b8d.up.railway.app. Opens a sign-in page; the password is the Railway variable `ADMIN_PASSWORD`. A signed cookie keeps you in for 30 days; Sign out is a POST to `/logout`. Scripts can still use Basic auth (any user name; the password may contain `:`). Optional `VIEW_PASSWORD`: a view-only sign-in that sees everything and changes nothing (server refuses every `/api` write with 403; LOGIC.md §13).

Login hardening (ADR-0011, SW-008): one limiter for the form and Basic auth, 10 wrong passwords per IP (last `X-Forwarded-For` hop, else the socket) and 100 across all IPs per 15 minutes → 429. When only the 100 cap is hit the password is still checked (right one passes, wrong one 429), so a stranger can't lock the owner out; the per-IP block is hard. With `NODE_ENV=production` (set in the Dockerfile) the app refuses to start unless `ADMIN_PASSWORD` is at least 12 characters. Cookies are signed with a random secret in `DATA_DIR/secret` (mode 600) plus a password fingerprint: changing the password signs everyone out; deleting the file does too.

## How data flows

```
Shopify (read-only GraphQL) ─┐
Shopify Flow → /ingest/*  ───┼─→ rows (stock changes, order lines) → store.json → engine → page
Google Sheet CSV / upload ───┘
```

- **Stock row:** `{ t, variantId, sku, product, variant, before, now, price, src }`, one per stock change.
- **Order row:** `{ t, order, variantId, sku, qty, price, src }`, one per order line.
- **Several stores (ADR-0015):** `src/stores.js` lists them (Performity brands; Key Vault `STORES`; `SHOPIFY_STORE`; no key → two demo stores). Each store's data is in `DATA_DIR/stores/<id>/`, the old single-store layout unchanged. Every request, pull, digest tick and daily backup runs inside `scope.run(id)` (`src/scope.js`, AsyncLocalStorage); per-store modules get their folder from `scope.dir()`, which **throws outside a store** (never a default). `?store=<id>` on every `/api` route and `/ingest/*` (else the `sw_store` cookie, else the first store); unknown id → 404. Pulls: one queue, one store at a time. First start moves an old single-store `DATA_DIR` into the first store (`src/migrate.js`).
- **One source per store (ADR-0009):** `src` = shopify / flow / sheet / csv / demo. With Shopify connected, `/ingest/*`, `/api/sync` and `/api/import` return 409; `/api/clear` and import return 409 while a pull runs. `/api/demo` returns 409 while the store holds real data (source `live`).
- **Catalog** (`store.json` → `catalog`, Shopify only): `{variantId → productId, product, variant, sku, type, tags, price, cost, status, tracked, active, stock, seenAt, inactiveSince}`, replaced on every pull (ADR-0010). Engine takes stock now and attributes from it; inactive variants are left out of reorder and overstock.
- **Engine** (`src/engine.js`, pure functions): stock-out episodes, in-stock sales rate, ₹ lost (weighted by the store's hour-of-day sales pattern), reorder status and quantity.

## Files

| File | Role |
|---|---|
| `LOGIC.md` | how every number is worked out and why; read it before changing `src/engine.js` |
| `server.js` | HTTP server, API, Flow ingest, sheet sync, Shopify pull every 15 min (one store at a time, `pullAll`), demo loader; `openStore` / `inStore` / `eachStore` run work for one store |
| `src/scope.js` | which store the current work is for: `run(id, fn)`, `id()`, `dir()` → `DATA_DIR/stores/<id>`; store id rule (uuid or `^[a-z0-9][a-z0-9-]{0,60}$`); `useDir()` for tests only |
| `src/stores.js` | the store registry (ADR-0015): `list()`, `refresh()` (Performity brand list, last good one kept in `DATA_DIR/stores.json`), `pick(?store, cookie)` → id or 404/503 |
| `src/migrate.js` | one-time, crash-safe move of an old single-store `DATA_DIR` into `stores/<first id>/` (copy, SHA-256 check, marker, atomic rename, delete originals that still match) |
| `src/groups.js` | Group by (SW-022): rolls Products rows up by parent product, category, collection or tag, keyed by IDs (LOGIC.md §9a) |
| `src/catalog.js` | variant → product ID, type, tags (from the SW-002 store catalog snapshot, no second copy) and collections + members (read-only, 24 h cache, resumable) in `DATA_DIR/catalog.json` (LOGIC.md §9b); demo IDs, tags and collections from `demo.catalog()` |
| `src/engine.js` | all the maths (tested) |
| `src/rows.js` | CSV / sheet / webhook → rows; refuses files without the required header columns, skips bad rows with a reason (LOGIC.md §1a); `csvCell` guards exports against formulas |
| `src/store.js` | JSON-file storage on the `/data` volume, de-duplication, 120-day retention. Only a missing file starts blank; a bad file is copied to `store.json.corrupt-<time>`, `store.json.bak` (previous good save) is used, else the server refuses to start. Writes fsync before rename; a failed write retries (5 s, 30 s, 2 min) and turns `/health` 503 |
| `src/backup.js` | backups of `store.json` + `sideFiles` (`onorder.json`, `decisions.json`) in `/data/backups` (daily + before every replace/clear, 14 each), restore from `/data/restore.json` on start (side files too), `GET /api/export/backup.json`. Restore steps: `docs/RUNBOOK.md` |
| `src/sidefile.js` | `onorder.json` / `decisions.json` kept like `store.json`: a bad file is copied to `.corrupt-<time>` and never overwritten; `.bak` used instead; none → refuse to start (critic r2 X1) |
| `src/onorder.js` | "Mark ordered" records (`DATA_DIR/onorder.json`, one per variant: qty, eta, at, by) + `GET/POST /api/onorder`; the engine counts them (LOGIC.md §6b) |
| `src/access.js` | roles: admin / view password, role in the signed cookie, the 403 gate for view sessions (SW-029) |
| `src/audit.js` | settings change log `{at, by, key, old, new}` (SW-029) |
| `src/runs.js` | sync progress ("Syncing · 2,340 orders") and the last 20 runs: start, time taken, rows, error, notes (SW-030) |
| `src/keys.js` | where the Shopify key comes from: Performity POC API, Azure Key Vault or Railway variables; `access(storeId)`, caches per store; Performity calls paced (≥ 2.1 s, token calls per brand ≥ 6.1 s) |
| `src/shopify.js` | read-only guard, stock and order pulls (stock pull also returns the catalog), paced by Shopify's cost budget |
| `src/helpers.js` | decision helpers on top of the report (LOGIC.md §15): why sentence + order-by date, still-out cost/day, PO CSV lines, Pause/Push lists, slow-seller Decide bucket. Pure, tested (`test/helpers.test.js`; HTTP in `test/helpers-server.test.js`; browser in `test/ui-helpers.test.js`, skipped unless `PLAYWRIGHT_PATH` points at a playwright package, `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome) |
| `src/decide.js` | slow-seller decisions (keep/drop/clear) in `DATA_DIR/decisions.json`; `GET/POST /api/decide` |
| `src/period.js` | "This month" period and the Yesterday strip (SW-027) |
| `src/digest.js` | morning digest text per role, pure (SW-028) |
| `src/digest-service.js` | digest routes, outbound webhook, daily schedule at a store-time hour, send log in `store.digest` |
| `public/roles.js` | role home views (SW-020): what each RACI role removes from the default; also read by the digest |
| `public/digest-ui.js` | Overview Share menu (copy / WhatsApp) and Data → Morning digest settings |
| `src/demo.js` + `src/demo-catalog.json` | 60-day demo on Sammsara's public catalog (255 variants); stock and sales invented |
| `public/` | the page (plain JS, no build step), styled like the Performity app: tokens at the top of `styles.css` |
| `test/` | `node --test` (`npm test`): `engine`, `shopify`, `rows` (parsing, table-driven), `server` (spawns the real server on a free port + temp DATA_DIR: auth, limiter, headers, ingest, 400s), `store`, `backup`, `docs`; multi-store: `stores` (ids, registry incl. the stand-in API with 2 brands, migration), `multistore` (real server, two demo stores never mix, 404s, cookie, view-only), `scheduler` (one pull at a time); module tests point a module at one folder with `scope.useDir()`; `parity.test.js` checks the Google Sheet's maths against `engine.js`. `test/smoke/` is a Playwright smoke run on demand, not part of `npm test` |

## Shopify access (decided 19 Nov 2026)

- Pull straight from Shopify into our own storage. **No connection to the dev team's database.**
- Shopify credentials are the app's **client ID + client secret** (Dev Dashboard app, same Shopify organisation as the store); `src/keys.js` swaps them for a 24-hour token (client credentials grant) and renews it. A legacy `shpat_` token still works.
- Key source 1: **Azure Key Vault**, secrets `shopify-<store>-client-id` and `shopify-<store>-client-secret` (or one `shopify-<store>` JSON secret). Variables: `AZURE_KEY_VAULT_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SHOPIFY_STORE`.
- Key source 2 (stop-gap): `SHOPIFY_STORE` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.
- Fallback if tokens can't be shared: our own read-only Shopify app (not built).
- Scopes needed: `read_products`, `read_inventory`, `read_orders`.
- Once a key source is set, the app refuses to start without `ADMIN_PASSWORD`, and demo data is turned off.

## Role views and digest (Sprint 2 · B-roles)

- Role views only remove UI (ADR-0006); config in `public/roles.js`, rules in LOGIC.md §16. Browser check: `node test/smoke/roles-smoke.js` (needs Playwright; uses its browser, else system Chrome, else `CHROMIUM_PATH`). Not in `npm test` (no browser in CI, no deps).
- Digest: LOGIC.md §17. Optional variables `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_URL_<ROLE>` (per-role recipient), `PUBLIC_URL`. Env only, never saved from the page. Without a webhook nothing is sent; Share → Copy / WhatsApp still works.
- Warehouse home = Reorder → Ordered: every open PO (part, late, too late), late first, *Lands* + *On order (pcs)*, headline "N on order · M due this week · K late"; warehouse digest lists the same (`helpers.onOrderRows` / `onOrderSummary`, LOGIC §6b). Marketing home = Products → Pause promotion.
- Smoke (`test/smoke/smoke.js`): refuses a `SMOKE_PORT` already in use and fails when the app dies or no check runs.

## Railway variables now

`ADMIN_PASSWORD`, `RAILWAY_RUN_UID=0` (so the app can write to the volume), with a volume at `/data`. No Shopify variables yet, so it shows the demo.

## Running in production

- Runs under tini (Dockerfile). SIGTERM/SIGINT: timers stop, a running Shopify pull gets up to 25 s (`STOP_WAIT_MS`), the store is written, then the process exits.
- `/health`: 200, or 503 while saving fails. Railway health check set in root `railway.json`.
- `/status` (no login, for an uptime monitor): `{ok, stale, ageMin, lastPull, shopify, running, pullFailing, saveOk, source, storeBytes, stockRows, orderRows, variants, uptimeMin}`; 503 when the last Shopify pull is > 45 min old or saving fails. No names, keys or error text. `/api/report` carries the same `freshness` for the stale-data banner (UI: stream E).

## Commands

```bash
npm start          # http://localhost:4400 (demo data on first run)
npm test
ADMIN_PASSWORD=x SHOPIFY_STORE=brand SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… npm start
```

## Status

- Done: engine, page, Flow/Sheet/CSV ingest, read-only Shopify pull with Key Vault, Railway deploy, Sammsara demo.
- Sprint 1 security (SW-008/009/010/016/017/018): login limiter + prod password check, session secret in `DATA_DIR/secret`, POST logout, ingest key in the `X-Ingest-Key` header only (≤ 500 rows/request), strict CSV import, security headers + same-origin writes, CSV formula guard, 400s for bad input.
- Before the next deploy: Railway `ADMIN_PASSWORD` must be ≥ 12 characters (the Dockerfile sets `NODE_ENV=production`, so a shorter one stops the app starting). Flow workflows using `?key=` keep working but should move to the header.
- Sprint 1 (E-ui): plan bar Save/Reset fixed (SW-011); "Mark ordered" for ticked Reorder rows (bulk bar; phone cards have the tick too) and in the drawer, with an Ordered tab (SW-012; the per-row button went in critic round 1, S2: one control per row); trend bars in the Products/Reorder rows, phone cards and drawer, Overview "Moving" card by ₹ effect (SW-021; group rows wait for SW-022).
- Sprint 2 D-helpers (branch `sprint2/D-helpers`): SW-024 Why cell + order-by + still-out ₹/day, SW-025 reorder CSV as a PO (`?filter=&q=`, vendor, unit cost, variant ID), SW-026 Pause / Push chips on Products, SW-032 slow-seller Decide bucket.
- Sprint 2 merged on `main` (C-access, D-helpers, A-groups, B-roles + integration fixes, see docs/DEVLOG.md): one `reportOpts()` for report, groups, drawer, CSV and digest; roles cover Sprint 1/2 controls per RACI.
- Multi-store (ADR-0015, branch `feature/multistore`): registry, per-store folders, migration, `?store=` everywhere, sequential pulls, per-store alerts / digest / backups.
- Waiting on: Key Vault access from the dev team (vault URL, tenant, app ID, secret, token format), and Performity's repo to align conventions.
- Group by (SW-022, branch `sprint2/A-groups`): "View: Products ▾" on Products; `GET /api/groups?lens=product|type|collection|tag[&all=1]` (no lens: lenses on offer). Variants come from `store.catalog` (SW-002); `/api/groups` uses the same report options as `/api/report` (integration).

## Next

1. Connect the first real store via Key Vault; compare 10 days of orders and stock for 10 SKUs against Shopify admin.
2. Alert when a pull fails or data is older than expected.
3. Move storage to Postgres when the stores together pass ADR-0003's triggers (sum of `/status` `storeBytes`), or a store needs more than a few months of data.
4. Push stock changes through Shopify Flow too, so stock-outs are timed to the minute rather than to 15 minutes.
