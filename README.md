# Stock-out Watch

Stock-out Watch shows which bestsellers to reorder before they run out, and what every stock-out cost in sales. Brands that spend heavily on ads can then see whether a bad day came from the ads or from an empty shelf.

- **No Shopify API key, no app on the store.** Data arrives from the store's own Shopify Flow (into a Google Sheet or straight to this app), or as a CSV upload.
- **Plain Node.js, zero dependencies.** One process, data kept in a JSON file.
- **Demo data on first run**, so it can be shown right away.

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

## Getting real data in (no API keys)

It needs two streams: **every stock change** and **every order line**.

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

## Deploy

Any Node host works. The repo has a `Dockerfile`; mount a volume at `/data`.

| Variable | Meaning |
|---|---|
| `PORT` | default 4400 |
| `ADMIN_PASSWORD` | set this in production |
| `DATA_DIR` | where `store.json` lives (default `./data`; `/data` in Docker) |

Health check: `GET /health`.

## Layout

```
server.js          HTTP server, API, Flow ingest, sheet sync
src/engine.js      all the maths (pure, tested)
src/rows.js        CSV / sheet / webhook → rows
src/store.js       JSON-file storage, de-duplication, 120-day retention
src/demo.js        made-up demo store
public/            the web page (no build step)
test/              node --test
```

## Limits / next steps

- **Storage:** the JSON-file store suits one store with a few months of data. For more stores, move `src/store.js` to Postgres; the rest is unchanged.
- **History:** it starts when data starts flowing. Shopify keeps no stock history, so lost-sales numbers build up from day one.
- **Stores:** one store per deployment. Multi-store would add a store id to every row and the URL.
