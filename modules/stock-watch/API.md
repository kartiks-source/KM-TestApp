# API: Stock-out Watch (web app)

Every HTTP route `server.js` answers, version 0.9.0. Source of truth: `server.js` `api()` and the route handlers in `src/backup.js`, `src/onorder.js`, `src/decide.js`, `src/digest-service.js`. Row and file formats: `FORMATS.md`. Secrets and auth model: root `SECURITY.md`. No `/api/v1` prefix yet (SW-050): routes may change between minor versions; check `CHANGELOG.md`.

## Conventions

- **Auth** column: **open** (no login), **key** (ingest key header), **view** (any signed-in role: admin or view-only), **admin** (admin only).
- Sign in with the `sw_session` cookie from `POST /login`, or HTTP Basic auth with any user name and the password. With no `ADMIN_PASSWORD` set (local only), every request is admin.
- A view-only session gets **403** `View-only sign-in: ask an admin to make this change` on every `POST/PUT/PATCH/DELETE /api/*`, before the route runs.
- JSON answers are `{ "ok": true, … }` or `{ "ok": false, "error": "<plain sentence>" }`, with `cache-control: no-store`.
- Writes marked ⚠ change or wipe stored data (also listed in `SECURITY.md` §Endpoints that change or wipe data).

**Errors any route can give**

| Code | When |
|---|---|
| 400 | bad address (`Bad address`), body that isn't a JSON object, bad value (route lists its own) |
| 401 | `/api/*` without a valid session or Basic password: `Login needed` |
| 403 | write from another site (`Cross-site request refused`: `Sec-Fetch-Site` cross-site/same-site, or `Origin` ≠ host); view-only session writing |
| 404 | unknown `/api/*` path: `Not found` |
| 413 | body over the route's limit (`Upload too large`; 25 MB default) |
| 429 | too many wrong passwords (10 per IP / 15 min; or a wrong one while 100 across all IPs failed); `retry-after: 900` |
| 500 | a bug: `Something went wrong on the server` (logged) |

**Report query values** (`/api/report`, `/api/product/:id`, `/api/groups`, `/api/export/reorder.csv`)

| Param | Meaning |
|---|---|
| `days` | `7`, `14`, `30`, `60` (default 30), or `month` = from the 1st of this month, store time |
| `leadDays`, `coverDays`, `safetyDays`, `demandWindowDays`, `smallTopUpDays`, `minPerDay`, `tzOffsetMin` | trial values, not saved; clamped to 0–180, 1–365, 0–60, 7–90, 1–60, 0–100, −720–840. Blank or not a number = the saved value |

## Open routes

| Method · path | Auth | Answer |
|---|---|---|
| `GET /health` | open | 200 `{"ok":true}`; 503 `{"ok":false,"error":"…"}` while the store can't be read or saving fails |
| `GET /status` | open | `{ ok, stale, ageMin, lastPull, shopify, running, pullFailing, saveOk, source, storeBytes, stockRows, orderRows, variants, uptimeMin }`; **503** when the last good Shopify pull is over 45 min old (or none 45 min after start) or saving fails. Without Shopify, `stale` is always false. No names, keys or error text |
| `GET /login` | open | sign-in page (302 to `/` when already signed in) |
| `POST /login` | open | form `password=…` (≤ 4 KB). Right → 303 to `/` with `set-cookie: sw_session=…; HttpOnly; SameSite=Lax; Max-Age=2592000` (`Secure` behind https). Wrong → 401 page; limited → 429 page. No `ADMIN_PASSWORD` → 303 to `/` |
| `POST /logout` | open | 303 to `/login`, cookie cleared. `GET /logout` → 303 to `/` (does nothing) |
| `GET /*` (static) | view | the page from `public/`; unknown paths serve `index.html`. Not signed in → 302 to `/login` (except `/favicon.svg`) |

## Flow ingest

| Method · path | Auth | Body | Answer |
|---|---|---|---|
| ⚠ `POST /ingest/stock` | key | one stock row: JSON object, JSON array (≤ 500), or a comma-separated line; ≤ 2 MB. `FORMATS.md` §Flow | `{ ok, received, added }` (duplicates not added) |
| ⚠ `POST /ingest/order` | key | one order line, same forms | same |

Key: header `X-Ingest-Key: <key>`. `?key=` still works but is deprecated (logged, at most hourly, without the key). Errors: **401** wrong or missing key; **409** Shopify is connected (one source per store, ADR-0009); **413** more than 500 rows.

## Report and lookups (view)

| Method · path | Params | Answer |
|---|---|---|
| `GET /api/report` | report query values | `{ ok, generatedAt, days, from, period: 'days'\|'month', settings, totals, daily[], reorder[], stockouts[], products[], data, decide[], decided[], yesterday, source, lastSync, lastSyncError, shopify, freshness }`. `products[]` rows: `id, name, sku, stock, perDay, price, daysLeft, status, orderQty, orderValue, lost, sold, cost, lostProfit, excessValue, overstock, abc, trendPct, trendCall, why, orderBy, onOrder, …` (LOGIC.md names each rule). `reorder[]` = rows to order, `decide[]` = slow sellers to decide, `yesterday` = `{ day, sold, lost, ranOut, back }`, `freshness` = `{ shopify, lastPull, ageMin, stale, staleAfterMin, running?, pullFailing? }` |
| `GET /api/product/:id` | report query values; `:id` = variant ID, URL-encoded | `{ ok, id, product, timeline[{t, stock}], dailyUnits[{day, units}], stockouts[] }`; `product` is null for an ID with no rows (still 200). Bad `%` encoding → 400 `Bad product ID in the address` |
| `GET /api/groups` | none | `{ ok, lenses[], catalog }`: which lenses this catalog can offer |
| `GET /api/groups?lens=` | `lens` = `product`, `type`, `collection`, `tag`; `all=1` shows catch-all collections; report query values | `{ ok, lens, overlap, groups[{ key, label, n, needOrder, sold, lost, lostProfit, orderValue, excessValue, ids[], trendPct, trendCall }], total, store, hidden[], storeTrendPct, catalog }`. `total` is null for `collection` / `tag` (a product can be in many). Unknown lens → 400 `Unknown group` |
| `GET /api/settings` | none | `{ ok, settings, role, changes[], lastPlanChange, runs[], source, lastSync, lastSyncError, shopify }`. View sessions: no `ingestKey` in `settings`, `changes` empty. `shopify` = `{ source, store, secretName, kind, ready, missing[], lastSync, lastError, lastTry, running, progress, backfilled, scopes, apiVersion }` (never a secret) |
| `GET /api/onorder` | none | `{ ok, onOrder: { variantId: { qty, eta, at, by } } }` |
| `GET /api/decide` | none | `{ ok, decisions: { variantId: { d, base, at } } }` |
| `GET /api/export/reorder.csv` | `filter` = `all` (default), `today`, `week`, `ordered`; `q` = search on name/SKU; report query values | CSV download `reorder-YYYY-MM-DD.csv` (UTF-8 BOM). Columns in `FORMATS.md` §PO CSV |
| `GET /api/export/backup.json` | none | **admin only** (view → 403). The whole `store.json` plus `sideFiles` (`onorder.json`, `decisions.json`) as a download `stock-watch-store-YYYYMMDD-HHMMSS.json`. Holds the ingest key: treat as a secret |

## Writes (admin)

| Method · path | Body / params | Answer | Errors |
|---|---|---|---|
| `PUT /api/settings` | JSON ≤ 64 KB: any of the trial keys above (clamped), `storeName` (≤ 60 chars), `sheetStockCsv`, `sheetOrderCsv` (≤ 500 chars), `newIngestKey: true` ⚠ rotates the key | `{ ok, settings }` (includes the new key). Each changed value is logged `{at, by, key, old, new}` (key masked) | 400 not a JSON object; 413 |
| ⚠ `POST /api/onorder` | JSON ≤ 256 KB `{ items: [{ id, qty, eta }], by? }`; `qty` 1–1,000,000 whole; `eta` `YYYY-MM-DD` (end of that day, store time) or ms, within −1…+365 days; `qty: 0` or `clear: true` removes; ≤ 500 items | `{ ok, saved, removed }` | 400 `Nothing to mark`, bad qty/date/id, not JSON; 405 other methods |
| ⚠ `POST /api/decide` | JSON ≤ 16 KB `{ id, decision }`; `decision` = `keep` \| `drop` \| `clear`, or null/'' to remove | `{ ok }` or `{ ok, removed }` | 404 `No such product` (not in the report); 400 bad decision, not JSON, over 5,000 decisions; 405 other methods |
| ⚠ `POST /api/import?kind=stock\|order` | CSV text (≤ 25 MB) with a header row; `FORMATS.md` §CSV | `{ ok, read, added, skipped, skips: { badTime, badNumber, noId, tooOld } }`. On a demo store the demo goes first | 400 missing columns (named); 409 Shopify connected or a pull running; 413 |
| `POST /api/sync` | none | `{ ok, stock, orders }` new rows from the Sheet links, or `{ ok, skipped: true }` with no links | 409 Shopify connected; 502 the Sheet fetch or parse failed (message says which tab) |
| `POST /api/shopify/sync` | none | `{ ok, stock, orders }` when the pull ends within 25 s, else 202 `{ ok, running: true }` (it carries on; poll `/api/settings`) | 400 Shopify isn't connected; 502 the pull failed |
| ⚠ `POST /api/demo` | none | `{ ok, stock, orders }`: demo data loaded, decisions forgotten (backup first) | 409 Shopify connected; 409 the store holds real data (Clear first) |
| ⚠ `POST /api/clear` | none | `{ ok }`: every row, Mark ordered record and decision gone (backup first, with `sideFiles`) | 409 a pull is running |

## Morning digest

| Method · path | Auth | Params / body | Answer | Errors |
|---|---|---|---|---|
| `GET /api/digest` | view | `role` = `ceo`, `founder`, `ops`, `buyer`, `marketing`, `finance`, `warehouse`, or none / `all` = everyone | `{ ok, role, roleName, title, lines[], link, text }` (≤ 6 lines + link) | 400 unknown role |
| `GET /api/digest.txt` | view | same | the text (`text/plain`) | 400 unknown role |
| `GET /api/digest/settings` | view | none | `{ ok, webhook: { set, host }, tzOffsetMin, hour, roles[], paused, scheduled[{ role, name, cadence, host, own }], log[] }` (last 20 sends; never a webhook URL) | — |
| `PUT /api/digest/settings` | admin | JSON ≤ 64 KB `{ hour?: 0–23, roles?: [...], paused?: bool }`; roles without a scheduled digest (buyer, warehouse, unknown) dropped | same as GET | 400 bad hour, not JSON, or any `webhookUrl` (env only) |
| ⚠ `POST /api/digest/send` | admin | `role` (none = every ticked role) | 200 `{ ok, sent[{ at, role, trigger, ok, status, error }] }`; 502 with `error` when any send failed | 400 no roles ticked; 400 no webhook (`DIGEST_WEBHOOK_URL` / `_<ROLE>`) |

Webhook payload (POST JSON to the env URL): `{ app: 'stock-watch', kind: 'digest', at, store, role, roleName, title, lines, link, text, note? }`. The alert webhook (`ALERT_WEBHOOK_URL`) gets `{ text }`.
