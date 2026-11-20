# Formats: Stock-out Watch (web app)

Every row format the app reads and every file it writes, version 0.9.0. Parsing: `src/rows.js`. Storage: `src/store.js` and the sidecar modules. Routes: `API.md`. Rules on what the numbers mean: `LOGIC.md` (§1a for parsing and skips).

**schemaVersion:** none of the stored files carry one yet. Everything below is **schema 1**, the shape on disk since Sprint 1 (SW-002 catalog, SW-006 `src`). Adding `schemaVersion` and migrations is SW-047; until then, a change to a stored shape must stay readable by old code paths (new keys optional, old keys kept), and `store.load()` fills missing top-level keys with defaults.

## Inbound rows

The same two columns sets everywhere: Shopify Flow → Google Sheet tabs, Sheet "Publish to web" CSV links, CSV upload, and Flow → `/ingest/*`. The Google Sheet module (`modules/stock-watch-sheets`) uses the same column order; keep them in step.

### Stock row (one per stock change)

| # | Column | Required | Notes |
|---|---|---|---|
| 1 | Time | yes (CSV / Sheet) | see §Times. Flow: blank or unreadable = the time it arrived |
| 2 | Variant ID | yes | digits; a `gid://shopify/ProductVariant/` prefix is removed; other characters except letters, digits, `_`, `-` dropped |
| 3 | SKU | | |
| 4 | Product | | product title |
| 5 | Variant | | variant title (not an ID) |
| 6 | Stock before | | blank = unknown: the engine uses the previous row's *Stock now* (LOGIC.md) |
| 7 | Stock now | yes | total across all locations; blank row skipped (`badNumber`) |
| 8 | Price | | selling price; blank = 0 |
| 9 | Type | | product type (category) |
| 10 | Cost | | unit cost; kept only when > 0 |

### Order row (one per order line)

| # | Column | Required | Notes |
|---|---|---|---|
| 1 | Time | yes (CSV / Sheet) | order created time |
| 2 | Order | | order name, e.g. `#1042` |
| 3 | Variant ID | yes | as above |
| 4 | SKU | | |
| 5 | Qty | yes | must be > 0 (refunds netted before it gets here) |
| 6 | Unit price | | price paid after discounts; blank = 0 |

### Header names (CSV and Sheet)

A CSV or Sheet tab must start with a header row naming at least the required columns (Stock: Time, Variant ID, Stock now; Order: Time, Variant ID, Qty), else **400** `Missing column(s): …` and nothing is stored. Headers are matched case-insensitively with `_` read as a space; an exact name always beats an alias; each column is used once. The delimiter is `,` or `;`, whichever the first line has more of. A UTF-8 BOM is ignored.

| Column | Also accepted |
|---|---|
| Time | timestamp, date, created at, createdat, at |
| Variant ID | variantid (not "variant": that is the title) |
| SKU | variant sku |
| Product | product title, title, name |
| Variant | variant title, option |
| Stock before | before, prior, inventory before, quantity before |
| Stock now | now, after, inventory, quantity, stock, inventory now |
| Price (stock) | unit price, selling price |
| Type | product type, category (not "collection") |
| Cost | unit cost, cost price, cogs, cost per item |
| Order | order name, order id, name |
| Qty | quantity, units |
| Unit price (order) | price, net price, discounted price |

### Numbers and times

- **Numbers:** `₹`, `Rs`, `INR`, commas and spaces are stripped (`₹1,299.50` → 1299.5). Anything else unreadable skips the row (`badNumber`).
- **Times:** ISO with zone (`2026-11-17T10:22:31+05:30`, `Z`); ISO without zone or date only (`2026-11-17` = 00:00) is store time (`tzOffsetMin`, India 330); `dd/mm/yyyy [hh:mm[:ss]]` (US `11/15/2026` is rejected, not guessed); a Sheets serial number (store time); `Tue, 17 Nov 2026 04:52:31 GMT`. Impossible dates (31/02) are rejected.
- **Skips** (reported as `skips` on import): `badTime` (unreadable, or more than 1 day in the future), `badNumber`, `noId`, `tooOld` (older than the 120 days kept).
- **Duplicates** are stored once. Stock key: `t|variantId|before|now`. Order key: `order|L<line>` when the row has a Shopify line ID, else `order (or t)|variantId|qty`.

### Shopify Flow templates

Flow → Google Sheet (**Add row to spreadsheet**) and Flow → this app (**Send HTTP request**, POST, header `X-Ingest-Key: <key>`) use the same line. Setup steps: `modules/stock-watch-sheets/SETUP.md` (Sheet) and `README.md` §B (direct).

Stock (trigger: *Product variant inventory quantity changed*):

```
{{ "now" | date: "%Y-%m-%dT%H:%M:%S%z" }},{{ productVariant.id | remove: "gid://shopify/ProductVariant/" }},{{ productVariant.sku | replace: ",", " " }},{{ product.title | replace: ",", " " }},{{ productVariant.title | replace: ",", " " }},{{ inventoryQuantityPrior }},{{ productVariant.inventoryQuantity }},{{ productVariant.price }}
```

Order line (trigger: *Order created* → For each `order / lineItems`):

```
{{ order.createdAt }},{{ order.name }},{{ lineItemsForeachitem.variant.id | remove: "gid://shopify/ProductVariant/" }},{{ lineItemsForeachitem.sku | replace: ",", " " }},{{ lineItemsForeachitem.quantity }},{{ lineItemsForeachitem.discountedUnitPriceSet.shopMoney.amount }}
```

A Flow body needs no header row (a first line is treated as a header only if it names 2+ columns and has no readable time). JSON bodies are also accepted: one object, or an array of at most 500. Field names read, first match wins:

| Stock column | JSON keys | Order column | JSON keys |
|---|---|---|---|
| Time | `time`, `at` | Time | `time`, `created_at`, `createdAt` |
| Variant ID | `variant_id`, `variantId`, `variant id` | Order | `order`, `order_name`, `name` |
| SKU | `sku` | Variant ID | `variant_id`, `variantId`, `variant id` |
| Product | `product`, `title` | SKU | `sku` |
| Variant | `variant`, `variant_title` | Qty | `qty`, `quantity` |
| Stock before | `before`, `stock_before`, `prior` | Unit price | `price`, `unit_price` |
| Stock now | `now`, `stock_now`, `quantity` | | |
| Price | `price` | | |
| Type | `type`, `product_type`, `category` | | |
| Cost | `cost`, `unit_cost`, `cost_price` | | |

## Outbound CSV

### PO CSV (`GET /api/export/reorder.csv`)

UTF-8 with BOM, every cell quoted, text starting with `= + - @ tab CR` gets a leading `'` (formula guard). File `reorder-YYYY-MM-DD.csv` (store date). Rows: the tab (`filter`) and search (`q`) shown on the page, grouped by vendor A–Z (unknown last), page order within a vendor.

`Vendor, Product, SKU, Variant ID, Order qty, Unit cost, Order value, Status, Why, Order by, Stock now, Sells per day, Days left, Sales lost (₹)`

*Order by* is a store date `YYYY-MM-DD`; *Unit cost* is blank when unknown; *Status* uses the page's labels.

### Browser-built CSVs (`public/app.js`, same BOM and formula guard)

- Products (`products-YYYY-MM-DD.csv`): the columns and rows shown.
- Pause promotion (`pause-promotion-YYYY-MM-DD.csv`): `Product, SKU, Variant ID, Why, Back in stock, In stock, Days left`.
- Push these (`push-these-YYYY-MM-DD.csv`): `Product, SKU, Variant ID, Overstock ₹, In stock, Days left`.

## Kept in the browser (per browser, never on the server)

Nothing here is a secret or a number; clearing site data only resets choices.

| Key | Where | Shape | Set by |
|---|---|---|---|
| `sw_store` | cookie, `Path=/`, a year, `SameSite=Lax` (`Secure` on https), readable by the page | a store id (uuid or `^[a-z0-9][a-z0-9-]{0,60}$`) | the store picker (`public/stores.js`); the server uses it only when the request has no `?store=` and the id is listed (ADR-0015) |
| `sw-store` | `localStorage` | the same store id | the store picker; the page's default when the address has no `?store=` |
| `sw-role` | `localStorage` | a role key (`ceo`, `ops`, …) or absent = All (the default) | the role list under the store pill, Data → Show me, `/?role=` (SW-020) |
| `sw-cols-off` | `localStorage` | `{ reorder: ['outs', …], products: [...] }`: optional columns **unticked** (every optional column is on by default; replaces the old opt-in `sw-cols`, which is ignored) | Columns… on Reorder / Products |
| `sw-colw` | `localStorage` | `{ <table>: { <column>: px } }`: dragged column widths | dragging a header edge; double-click resets |

## Files in `DATA_DIR` (`/data` on Railway)

Several stores (ADR-0015): each store's files are in its own folder, `DATA_DIR/stores/<id>/`, laid out exactly as one store's were before (`<id>` = Performity brand_id in lower case, a Key Vault store handle, or `sammsara-demo` / `second-demo`). Only `secret` and `stores.json` sit at the top, for every store. The table below is one store's folder, then the two shared files.

| File | Written by | Shape | In app backups? |
|---|---|---|---|
| `store.json` | `src/store.js` (temp + fsync + rename) | below | yes: it is what backups copy |
| `store.json.bak` | `src/store.js` | the previous good save | no (rebuilt every save) |
| `store.json.corrupt-<time>` | `src/store.js` | a copy of an unreadable store, left for a human | no |
| `onorder.json` | `src/onorder.js` via `src/sidefile.js` (temp + fsync + rename, previous kept as `.bak`) | `{ [variantId]: { qty, eta, at, by } }`: units on order, landing time (ms), when marked (ms), who (≤ 40 chars or null). Records due more than 60 days ago are dropped | yes, as `sideFiles['onorder.json']` (SW-005) |
| `decisions.json` | `src/decide.js` via `src/sidefile.js` (temp + fsync + rename, previous kept as `.bak`) | `{ [variantId]: { d: 'keep'\|'drop'\|'clear', base, at } }`: base = sales per day when decided | yes, as `sideFiles['decisions.json']` (SW-005) |
| `onorder.json.bak`, `decisions.json.bak`, `….corrupt-<time>` | `src/sidefile.js` | the previous good save (used when the file can't be read), and a copy of an unreadable file left for a human; with neither good, the app refuses to start (critic r2 X1) | no |
| `catalog.json` | `src/catalog.js` (temp + rename) | `{ collections: { [collectionId]: { title, productIds[] } }, collectionsAt, pending, lastError, variants, variantsAt }`: Shopify collections cache for Group by, re-read daily; `pending` = a resumable read in progress | no (rebuilt from Shopify within a day) |
| `backups/store-YYYYMMDD.json`, `backups/store-YYYYMMDD-HHMMSS-<why>.json` | `src/backup.js` | copies of `store.json` plus `sideFiles: { 'onorder.json', 'decisions.json' }` (`why` = `before-clear`, `before-demo`, `before-restore`); newest 14 of each kind | — |
| `restore.json` | a human | a `store.json` to put in place at the next start (`docs/RUNBOOK.md`) | — |
| `.migrated-from-data-dir.json` | `src/migrate.js`, first store only | `{ from: 'DATA_DIR', id, at, files: [{ path, sha256 }] }`: the old single-store files moved here, with their hashes (originals are deleted only while they still match) | no |
| **top of `DATA_DIR`:** `secret` | `server.js` (mode 600) | 64 hex characters: the session cookie key, for every store | no (a new one signs everyone out) |
| **top of `DATA_DIR`:** `stores.json` | `src/stores.js` (Performity only) | `{ list: [{ id, name, shop }], at }`: the last good brand list, used while the API is down | no (re-read every 10 minutes) |
| **top of `DATA_DIR`:** `stores/.migrating-<id>/` | `src/migrate.js` | a half-done copy left by a crash during the move; thrown away and redone on the next start | no |

### `store.json` (schema 1)

```
{
  "settings": {
    "storeName": "Demo Store", "tzOffsetMin": 330,
    "leadDays": 7, "coverDays": 30, "safetyDays": 3, "demandWindowDays": 28, "smallTopUpDays": 7, "minPerDay": 0.2,
    "ingestKey": "<32 hex>", "ingestKeyAt": 0, "sheetStockCsv": "", "sheetOrderCsv": "", "demoVersion": 0
  },
  "stock":  [ { "t": 0, "variantId": "", "sku": "", "product": "", "variant": "", "before": 0, "now": 0, "price": 0,
                "type": "?", "cost": "?", "vendor": "?", "src": "shopify|flow|sheet|csv|demo" } ],
  "orders": [ { "t": 0, "order": "#1001", "line": "?", "variantId": "", "sku": "", "qty": 1, "price": 0, "src": "…" } ],
  "catalog": { "<variantId>": { "productId": "", "product": "", "variant": "", "sku": "", "type": "", "vendor": "", "tags": [],
                "price": 0, "cost": null, "status": "ACTIVE|ARCHIVED|DRAFT|UNTRACKED|DELETED", "tracked": true, "active": true,
                "stock": 0, "seenAt": 0, "inactiveSince": "?" } },
  "source": "empty|demo|live", "everLive": true,
  "lastSync": null, "lastSyncError": null,
  "shopify": { "lastQty": { "<variantId>": 0 }, "ordersCursor": null, "lastSync": null, "lastError": null, "lastTry": null },
  "settingsLog": [ { "at": 0, "by": "admin|view|admin (script)", "key": "leadDays", "old": 7, "new": 10 } ],
  "syncRuns":    [ { "kind": "shopify|sheet", "start": 0, "ms": 0, "stock": 0, "orders": 0, "lines": 0, "error": null, "notes": [] } ],
  "digest": { "hour": 9, "roles": ["ceo", "founder", "ops", "marketing", "finance"], "paused": false,
              "lastSent": { "<role>": "YYYY-MM-DD" }, "log": [ { "at": 0, "role": "", "trigger": "schedule|manual", "ok": true, "status": 200, "error": null, "note": "?" } ] }
}
```

- Times are ms since 1970 (UTC). `"?"` marks an optional key. `before` may be `null` (unknown).
- Rows older than 120 days are pruned, except per variant the newest stock row and the row that opened a stock-out still running (ADR-0010).
- `catalog` is Shopify only, replaced whole on every stock pull; a variant that disappears stays as `DELETED` until it is 120 days gone.
- `settingsLog` keeps 200 entries, newest first; the ingest key shows as `(old key)` → `(new key)`. `syncRuns` keeps 20. `digest.log` keeps 50.
- Keys starting with `_` are in-memory indexes and never written.
- A file is accepted as a store when it is a JSON object with `stock` and `orders` arrays (restore also needs `settings`).
