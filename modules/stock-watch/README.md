# Stock-out Watch

Stock-out Watch shows which bestsellers to reorder before they run out, and what every stock-out cost in sales. Brands that spend heavily on ads can then see whether a bad day came from the ads or from an empty shelf.

- **Shopify, read-only.** With a store key (from Azure Key Vault, or a Railway variable as a stop-gap) it reads stock every 15 minutes and new orders straight from Shopify. It can't change the store: every call is checked and anything but a read is refused.
- **Or no key at all.** Data can also come from the store's own Shopify Flow (into a Google Sheet or straight to this app), or as a CSV upload.
- **Plain Node.js, zero dependencies.** One process, data kept in a JSON file.
- **Demo data on first run**: 60 days of invented stock and sales on Sammsara's public product list, so it can be shown right away.

## Run it

```bash
npm start              # http://localhost:4400
npm test               # engine + parser tests
ADMIN_PASSWORD=secret npm start   # ask for a password (any user name)
```

Requires Node 20 or newer.

## What it shows

| Screen | What |
|---|---|
| **Overview** | ₹ lost to stock-outs and % of demand for the period, ₹ sold, out of stock now, to order now, small top-ups, out again within a week. Daily sold vs lost chart. Biggest losses. Order today. A ready-made paragraph for the client. |
| **Reorder** | Every selling product that is Out now / Critical (≤ 3 days) / Order now (runs out before a new order lands) / Order this week. Shows stock, sales per day, days left, order quantity and value, and ₹ lost. CSV download. |
| **Stock-outs** | Every stock-out with when it went out and came back, hours, units and ₹ lost, and the refill size. Flags small top-ups and products out again within a week. |
| **Products** | Every product. Click one for its stock-level chart (out-of-stock periods shaded), units sold per day, and its stock-outs. |
| **Data & settings** | Data status, demo reload and clear, CSV upload, Google Sheet links, Shopify Flow webhook URLs, and the settings. |

## How the numbers work

- **Sales per day** = units sold in the last 28 days ÷ days the product was actually in stock. Stock-out days don't pull the rate down.
- **₹ lost per stock-out:**

  > selling hours out of stock × (sales per day ÷ 24) × average price paid

  "Selling hours" are weighted by the store's own sales pattern by hour of day, so a stock-out at 3 am costs less than one at 8 pm.
- **Order quantity** = sales per day × (lead time + cover + safety days) − stock now.
- **Status:**
  - Out now: stock ≤ 0
  - Critical: ≤ 3 days left
  - Order now: ≤ lead + safety days
  - Order this week: ≤ lead + safety + 7 days
- **Small top-up:** a refill smaller than 7 days of sales, e.g. "added 10 pcs".
- **Out again within a week:** the next stock-out started less than 7 days after this one ended.

All of these settings can be changed under Data & settings.

## Getting real data in

It needs two streams: **every stock change** and **every order line**.

### Shopify, read-only (recommended)
The app pulls straight from Shopify into its own storage. It never connects to any other team's database.

- **Read permissions needed:** `read_products`, `read_inventory`, `read_orders`. Nothing else.
- **Read-only, enforced in code:** every request goes through one guard (`src/shopify.js`) that refuses anything except a GraphQL query, so even a token with write access can't change the store.
- **What it reads:** every 15 minutes, each variant's total stock (a stock change is stored only when the number moved) and the orders created since the last read. The first read loads the last 60 days of orders.
- **Gentle on the store:** it pauses whenever less than half of Shopify's request budget is left, so other apps on the store aren't slowed down.
- **Keys:** kept in memory for 30 minutes, never written to disk, logs or the page. If Shopify rejects a token, it's fetched again at once, so a rotated key is picked up without a restart.

**Credentials:** Shopify gives an app a **client ID + client secret** (apps created in the Shopify Dev Dashboard). The app swaps them for a 24-hour access token (the client credentials grant) and renews it automatically. Shopify only allows this when the app and the store are in the **same Shopify organisation**, so for a brand's store the brand creates the app, installs it with the three read scopes, and shares the ID + secret. Otherwise Shopify answers `shop_not_permitted` and the page says so.

Where the credentials come from (Railway variables, nothing typed into the page):

| Source | Variables |
|---|---|
| **Azure Key Vault** (preferred) | `AZURE_KEY_VAULT_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SHOPIFY_STORE`. Reads `shopify-<SHOPIFY_STORE>-client-id` and `shopify-<SHOPIFY_STORE>-client-secret` (or one `shopify-<SHOPIFY_STORE>` secret with JSON). Our Azure login needs only "Key Vault Secrets User" on that vault. The secret is the admin token (`shpat_…`), or JSON with `shop` + `accessToken`, or `clientId` + `clientSecret` for an app made in Shopify's Dev Dashboard. |
| **Railway variables** (stop-gap) | `SHOPIFY_STORE` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (legacy: `SHOPIFY_ACCESS_TOKEN`). Move to Key Vault and rotate the key once the vault is ready. |

`SHOPIFY_STORE` is the part before `.myshopify.com`. Once either source is set, the app won't start without `ADMIN_PASSWORD`, and demo data is turned off.

### A. Shopify Flow → Google Sheet → this app
1. In the store's Shopify Flow, add two workflows that use **Add row to spreadsheet**:
   - "Product variant inventory quantity changed" → tab `Stock log`
   - "Order created" → For each line item → tab `Order log`

   Use the row formats below.
2. In the sheet: **File → Share → Publish to web**. Publish each of the two tabs as CSV.
3. Paste both links under **Data & settings → Google Sheet**. The app syncs every 15 minutes.

### B. Shopify Flow → this app directly
Use Flow's **Send HTTP request** action (POST) to the URLs shown under Data & settings:
- `/ingest/stock?key=…`
- `/ingest/order?key=…`

The body is the same comma-separated row as below, or JSON with the same fields. Check that the store's Shopify plan includes this action.

### C. CSV upload
Upload a CSV of either kind under **Data & settings**, with these columns and a header row.

### Row formats

**Stock:** `Time, Variant ID, SKU, Product, Variant, Stock before, Stock now, Price`

```
{{ "now" | date: "%Y-%m-%dT%H:%M:%S%z" }},{{ productVariant.id | remove: "gid://shopify/ProductVariant/" }},{{ productVariant.sku | replace: ",", " " }},{{ product.title | replace: ",", " " }},{{ productVariant.title | replace: ",", " " }},{{ inventoryQuantityPrior }},{{ productVariant.inventoryQuantity }},{{ productVariant.price }}
```

**Order line:** `Time, Order, Variant ID, SKU, Qty, Unit price`

```
{{ order.createdAt }},{{ order.name }},{{ lineItemsForeachitem.variant.id | remove: "gid://shopify/ProductVariant/" }},{{ lineItemsForeachitem.sku | replace: ",", " " }},{{ lineItemsForeachitem.quantity }},{{ lineItemsForeachitem.discountedUnitPriceSet.shopMoney.amount }}
```

Notes on these formats:
- **A row without a time** gets the time it arrived.
- **The same row sent twice** is stored once.
- **Stock** is the variant's total across all locations.

## Deploy (Railway)

Railway builds the `Dockerfile` at the repo root, which copies this folder. Attach a volume at `/data` and set `RAILWAY_RUN_UID=0` so the app can write to it. Run **one** replica only, so the 15-minute pulls never run twice.

| Variable | Meaning |
|---|---|
| `ADMIN_PASSWORD` | required in production (any user name) |
| `RAILWAY_RUN_UID` | `0`, so the app can write to the Railway volume |
| `PORT` | set by Railway (default 4400 locally) |
| `DATA_DIR` | where `store.json` lives (default `./data`; `/data` in Docker) |
| Shopify key variables | see "Shopify, read-only" above |
| `SHOPIFY_API_VERSION` | optional, default `2026-07` |
| `DIGEST_WEBHOOK_URL` | optional: where the morning digest is POSTed (overrides the one saved under Data & settings) |
| `PUBLIC_URL` | optional: the app's address for links in scheduled digests (Railway's `RAILWAY_PUBLIC_DOMAIN` is used if set) |

Health check: `GET /health`.

Morning digest: `GET /api/digest?role=ops` (JSON) or `/api/digest.txt?role=ops` (text), signed in. Roles: ceo, founder, ops, buyer, marketing, finance, warehouse (none = everyone).

## Layout

```
server.js          HTTP server, API, Flow ingest, sheet sync, Shopify pull schedule
src/keys.js        where the Shopify key comes from (Key Vault or variables)
src/shopify.js     read-only guard + stock and order pulls
src/engine.js      all the maths (pure, tested)
src/rows.js        CSV / sheet / webhook → rows
src/store.js       JSON-file storage, de-duplication, 120-day retention
src/demo.js        made-up demo store
src/period.js      "This month" + the Yesterday strip
src/digest.js      morning digest text per role (pure)
src/digest-service.js  digest routes, webhook, daily schedule, send log
public/            the web page (no build step); roles.js = role views, digest-ui.js = Share menu + digest settings
test/              node --test
```

## Limits / next steps

- **Storage:** the JSON-file store suits one store with a few months of data. For more stores, move `src/store.js` to Postgres; the rest is unchanged.
- **History:** it starts when data starts flowing. Shopify keeps no stock history, so lost-sales numbers build up from day one.
- **Stock timing:** read every 15 minutes, so a stock-out is timed to within 15 minutes, and one that starts and ends between two reads is missed. For exact timing, also send stock changes through Shopify Flow (option B above).
- **Stores:** one store per deployment. Multi-store would add a store id to every row and the URL.
