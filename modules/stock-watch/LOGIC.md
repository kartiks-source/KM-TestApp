# Stock-out Watch: how every number is worked out, and why

This is the reference for anyone who questions a number on the page. Each section gives:
- the rule, in plain words and as a formula
- why we chose it
- what else we considered
- when it can be wrong

The code is in `src/engine.js`, which has no inputs or outputs of its own, so every rule here can be tested. The tests are in `test/engine.test.js`. All settings mentioned can be changed under **Data & settings**; the defaults are shown in brackets.

If you change a rule, change this file in the same commit and add a line to `docs/DEVLOG.md`.

---

## 1. What goes in

Two streams, nothing else:

| Stream | One row per | Fields |
|---|---|---|
| Stock changes | each time a variant's stock number changes | time, variant ID, SKU, product, variant, stock before, stock after, list price, category (optional) |
| Order lines | each line of each order | time, order number, variant ID, SKU, quantity, unit price actually paid |

- **Stock is the variant's total across all locations.** A stock-out means the shopper couldn't buy it anywhere on the site, which is what loses the sale.
- **A variant is the unit of analysis** (e.g. "Nesting Table · Black Marble"), because that's what a shopper picks and what goes out of stock.
- **The same row arriving twice is stored once.** Stock rows are matched on time + variant + before + after; order lines on order number + variant + quantity (`src/rows.js`).
- **Data older than 120 days is dropped** (`src/store.js`), since nothing on the page looks further back than 90 days.

**Where it comes from and how precise it is:**

| Source | Stock-out timing |
|---|---|
| Shopify pull (read-only, every 15 minutes) | to within 15 minutes; a stock-out that starts and ends between two reads is missed |
| Shopify Flow → this app (no Shopify connection) or the Google Sheet | to the minute, because Flow fires on each change |
| CSV upload | as precise as the file |

**One source per store (ADR-0009).** Once Shopify is connected, the pull is the only source: Flow (`/ingest/*`), Sheet sync and CSV import are refused (409) with a plain message, because their order lines are keyed differently (order + variant + quantity vs Shopify's line ID) and the same sale would count twice. Clear and import also wait while a pull runs. Without Shopify, Flow, Sheet and CSV can be used together: they share one key, so the same order line sent by two of them is stored once. Every row records where it came from (`src`: shopify, flow, sheet, csv, demo). Rows stored before Shopify was connected stay; the pull replaces all lines of each order it reads (by order name), so a Flow or CSV copy of an order from the last 60 days is replaced, not doubled. Exact repeats of a row are dropped.

**Times without a time zone** (in a CSV or Flow row) are read as India time.

### What counts as a sale

| | Shopify pull | Flow / Sheet / CSV |
|---|---|---|
| Cancelled orders | left out, also when cancelled after we first read the order | whatever the template sends; send only live orders |
| Test orders | left out | left out only if the Flow condition excludes them |
| Refunds and removed items | netted: units are Shopify's `currentQuantity` | as sent |
| Discounts | price after line **and** order-level discounts (`discountedUnitPriceAfterAllDiscountsSet`) | as sent |
| Later edits | each run re-reads orders updated since the last run (30-minute overlap) and replaces their lines | not picked up |

This matches the DAWBU dashboard's definition (cancelled out, refunds and discounts netted), so the two show the same sales for the same days. One known difference remains: DAWBU sums variants into products **by title**, and we keep **variants by ID**. Totals agree, but per-product rows can differ where two products share a title.

---

## 2. Stock-out episodes

**Rule:** a product goes **out** when its stock drops to 0 or below, and comes **back** when it rises above 0. A stock-out that hasn't ended runs until "now" and is shown as **Still out**.

**Why:** zero stock is the only state in which a shopper definitely can't buy. Negative stock (overselling) counts as out too, because it means orders were taken that can't ship.

**Edge cases:**
- **Stock-outs that started before the selected period:** ₹ lost and the "product-days with an empty shelf" count only the hours inside the period. The **Out for** column shows the stock-out's full length, so you can see how long it really lasted.
- **A cancellation or return that puts stock back** can end a stock-out early, and if it's only a piece or two it shows up as a small top-up. Read small top-ups of 1–2 pieces with that in mind.
- **A product whose first-ever record shows 0:** counted as out from that moment, because we have no evidence it was in stock.

**When it can be wrong:**
- **Bundles or pre-orders** sold at 0 stock would look like stock-outs.
- **Products that are paused rather than out** would also look out. Untracked products and products not set to Active are skipped in the Shopify pull for this reason.

---

## 3. Sales per day (the in-stock rate)

**Rule:**

> sales per day = units sold in the last 28 days ÷ days the product was **in stock** during those 28 days (at least 1 day)

Setting: *Sales history used* [28 days]. If the store's data starts later than 28 days ago, the window starts with the data. **A product's own window starts at its first stock record or first order**, so a product launched 5 days ago is measured over those 5 days, not diluted by 23 days before it existed. (Without this, a new launch looked like a slow, overstocked product.)

**Why in-stock days, not calendar days:** a product that sold 28 units but was out of stock for 7 of the 28 days really sells 28 ÷ 21 = 1.33 a day, not 1.0. Dividing by 28 would make every stock-out shrink the next order, and the product would run out sooner the next time, a loop that keeps getting worse. Removing the out-of-stock time breaks that loop.

**Why 28 days:** four full weeks, so every weekday counts equally, and it's recent enough to follow a trend. We considered 7 days (too jumpy for slow sellers) and 90 days (too slow to react to a season or a campaign).

**When it can be wrong:**
- **Seasonal peaks:** right after a festive peak such as Diwali the rate is still high, so it may over-order for a week or two. Shorten the window during a known peak if needed.
- **New products** with only a few days of data: the rate is noisy. Use the product's stock chart before trusting the order quantity.

---

## 4. ₹ lost to a stock-out

**Rule:**

> units lost = selling hours out of stock × (sales per day ÷ 24)
> ₹ lost = units lost × average price paid

- **Average price paid** = the product's revenue ÷ units over the same 28 days, after discounts. If it hasn't sold in that time, the list price is used.
- **Selling hours** = clock hours out of stock, each multiplied by **how busy that hour of the day is** for this store (next section).

**Why this way:**
- **It values the stock-out at the demand the product had when it was in stock** (section 3). Without a stock-out those shoppers would have bought at the usual rate.
- **The price is what shoppers actually paid,** not the list price, so discounts aren't counted as lost money.
- **Hours are weighted** because demand isn't flat: a 2 am to 6 am stock-out costs far less than 6 pm to 10 pm.

**What else we considered:**
- **Counting abandoned carts or product-page views during the stock-out:** more direct, but it needs analytics access we don't have and misses shoppers who never reached the page.
- **Comparing with the same days last year:** this needs a year of history and breaks for new products.

**When it can be wrong:**
- **Overstated** if shoppers bought a similar product instead (substitution). The demand wasn't lost, it moved. On a deep range of similar products, read ₹ lost as an upper bound.
- **Understated** if the brand paused ads while the product was out, or if the stock-out started before our data did.
- **Approximate either way:** it's an estimate of demand that didn't happen, and it can't be checked against an order. Treat it as a size of the problem, not an accounting figure.

### 4a. How busy each hour is (hour-of-day profile)

**Rule:** from the store's own order lines of the last 60 days, units sold are counted per local hour of the day (0–23). One unit is added to every hour, so a quiet hour never counts as zero. The 24 numbers are then scaled so their average is exactly 1.

- A stock-out across a busy evening hour counts for, say, 1.6 hours.
- Across 3 am it might count for 0.3.
- **Over a full day the weights add up to 24,** so a day-long stock-out still costs exactly one day of sales.

**Why:** most D2C stores sell mostly in the evening. Without weighting, overnight stock-outs would be overvalued and evening ones undervalued.

**Why the store-wide pattern and not each product's own:** most products sell too few units for a reliable 24-hour pattern of their own. The store-wide pattern is stable.

### 4b. Worked example

Say a product sold 28 units in 28 days but was out of stock for 7 of them, at an average paid price of ₹1,200.
1. **Sales per day** = 28 ÷ 21 = 1.33.
2. **It goes out on Friday 18:00 and is back on Sunday 10:00.** That's 40 clock hours, including two evenings. Weighted by the store's pattern, say it comes to 46 selling hours.
3. **Units lost** = 46 × 1.33 ÷ 24 = 2.56.
4. **₹ lost** = 2.56 × ₹1,200 = **₹3,067.**

---

## 5. Totals on the Overview

| Number | Rule |
|---|---|
| Sold | sum of quantity × price paid for every order line in the period. Totals are the sum of the product rows, so the Overview and the Products page always agree |
| Lost to stock-outs | sum of ₹ lost (section 4) for stock-out hours inside the period; a stock-out spanning midnight is split across the days it covers |
| % of demand | lost ÷ (sold + lost). "Demand" = what was sold plus what would have been sold |
| Daily chart | the same two numbers per local day (India time by default, setting *Time zone offset* [330 minutes]); the first bar is the partial day the period starts in |
| Selling items out now | products at 0 stock that sell at least the minimum rate (section 7) |
| Out of stock right now (list) | every open stock-out, slow sellers included, so it can be higher than the count above |
| Product-days with an empty shelf | total stock-out hours across all products ÷ 24 |

---

## 6. Reorder status and quantity

**Days left** = stock now ÷ sales per day.

| Status | When | Why this threshold |
|---|---|---|
| **Out now** | stock ≤ 0 | already losing sales |
| **Critical** | 3 days or fewer left | out before most suppliers could deliver even if ordered today |
| **Order now** | ≤ lead time + safety days [7 + 3] | an order placed today only just lands in time |
| **Order this week** | ≤ lead time + safety + 7 days | an order placed in the next week still lands in time |
| **OK** | more than that | — |

**Order quantity:**

> order qty = sales per day × (lead time + cover + safety days) − stock now, rounded up, never below 0

Settings: *Lead time* [7 days], *Cover after a reorder* [30 days], *Safety stock* [3 days].

**Why:** the order has to cover the days until it lands (lead time) and then last the cover period, with a few days' buffer for busy days or a late supplier. Stock already on hand is subtracted.

**What else we considered:**
- **Safety stock from demand variability** (the textbook formula using standard deviation and service level) is more precise. But it needs months of clean history per product, and brands find "3 days of extra stock" easier to reason about. It's a good next step once there's more data.
- **Order value** = order qty × **unit cost** (the cash you commit to the supplier). If a product has no unit cost, the average price paid is used instead, which overstates the cash.

**When it can be wrong:**
- **Lead time is one number for the whole store.** Products from slower suppliers need a manual top-up.
- **Minimum order quantities and case packs aren't applied.** Round up to the supplier's pack size.

---

## 6a. Changing the assumptions (live)

The six assumptions (lead time, cover, safety, sales history window, slow-seller cutoff, small top-up) sit in the **Assumptions** bar on Overview, Reorder and Products. Changing one recalculates every number straight away, but only for you and only until you leave or press **Reset**. **Save as default** stores them for everyone. Next to the inputs the bar shows what the change does to the cash side: order value for everything urgent, the whole reorder list, and cash in overstock.

**Why:** the right lead time or cover differs by supplier, season and cash position. Seeing "cover 30 → 20 days frees ₹X of order value" lets a brand trade working capital against stock-out risk before committing.

## 7. Slow sellers

**Rule:** a product selling below *Ignore below* [0.2 units a day, about 6 a month] is a **Slow seller**. Slow sellers are left out of the reorder list and alerts, but their stock-outs and ₹ lost are still counted.

**Exception: a best seller (A, section 7a) is never a slow seller.** A ₹90,000 sofa selling one a month can be in the top 80% of revenue; it stays on the reorder list.

**Why:** for a product selling one unit a month, "days left" and "order quantity" swing wildly with a single order, and filling the reorder list with them hides the products that matter. It's not marked "not selling" because these products do sell, just slowly. A product with no sales at all is never "Out now" or on the reorder list, whatever the cutoff.

---

## 7a. Best sellers (A / B / C)

**Rule:** products are ranked by ₹ sold in the selected period. Going down that list, the products that together make the **first 80% of sales are A (best sellers)**, the next 15% are B, and the rest, plus anything that didn't sell, are C. A products show a small **A** badge everywhere.

- **Best sellers at risk** = A products that are Out now, Critical or Order now.
- The reorder list puts A products first within each status.

**Why:** a stock-out on an A product costs the most and is usually the one ads are pushing. 80 / 15 / 5 is the standard ABC split in inventory management.

**When it can be wrong:** a launch or a heavily discounted product can jump into A for one period. Switch the period (7 / 30 / 60 days) to see whether it holds.

## 7b. Profit lost and margin

**Rule:**

> profit lost = units lost × (average price paid − unit cost)
> margin = (average price paid − unit cost) ÷ average price paid

**Unit cost** comes from Shopify's inventory item cost ("Cost per item", readable with `read_inventory`), or from a `cost` column in a CSV/Flow row. Products without a cost show "–" and aren't counted in profit lost. The Overview tile only appears when at least one product has a cost, and says "N/M costed" when only some do: then it's a minimum.

**Why:** ₹ lost in sales overstates what the business lost. What it actually lost is the margin on those sales, and that's the number to weigh against the cost of holding more stock.

## 7c. Excess stock and overstock (cash tied up)

**Rule:**

> needed = sales per day × (lead time + cover + safety days)
> excess pieces = stock now − needed (never below 0)
> excess ₹ = excess pieces × unit cost (× average price paid if cost is unknown)

A product is **Overstocked** when its stock is more than **twice** what's needed, or it has stock but hasn't sold at all. **Cash in overstock** on the Overview adds up, for overstocked products only, the excess ₹ beyond **one times** the need (the cash you could free by selling down to a normal level). The "twice" is only the flag threshold.

**Why:** this is the cost-cutting side of the same maths. Money sitting in stock that won't sell for months could pay for stock that's running out. The usual moves are to stop reordering it, bundle it with a best seller, or discount it. The "twice" margin keeps a product that's only slightly over from being flagged.

**When it can be wrong:** stock bought ahead of a known season or campaign will look overstocked until the demand arrives.

## 7d. Trend (sparkline and % change)

**Rule:**
- **Bars:** units sold in each of the last 8 rolling 7-day blocks ending now, oldest on the left, scaled to that product's best week. A **rose mark** under a bar means the product was out of stock for part of that week (hover a bar for units and days out).
- **% change** = sales per **in-stock** day in the last 14 days vs the 14 days before:

  > rate = units sold ÷ days in stock (in that 14-day half)
  > change = (recent rate − earlier rate) ÷ earlier rate

  ▲ green at +10% or more, ▼ rose at −10% or less, ▬ in between. **New** = in stock for at least 7 days of the earlier half with no sales, and 3 or more sold since. **·** = too little to call: under 6 units over the 28 days, or under 3 in-stock days in either half.
- **Only time we have data for counts.** Days before a product's first record are "no data" (an empty bar), never "in stock, sold 0". Without this, a store with 20 days of history showed every product at +133%.
- **Typical-product baseline:** the **median** of all product trends (needs 5 or more), shown next to the Products tabs and in each chip's tooltip. It's the same measure as the product trend. An earlier version compared raw store units, which store-wide stock-outs dragged down; that made flat products look like they were outperforming.

**Why it's built this way (and what's wrong with plain week-on-week, as in the DAWBU sheet):**
- **Stock-outs aren't demand.** A product out for half of last week shows −50% week-on-week, though shoppers wanted it as much as ever. Dividing by in-stock days removes that. It's the same principle as section 3.
- **Two weeks against two weeks.** For a product selling a few a week, one week against one week swings wildly (2 → 1 = −50%). Doubling the window halves most of that noise, and the 6-unit minimum hides changes that are just noise.
- **Rolling weeks ending now,** not calendar weeks, so there's never a half-finished current week dragging the last bar down.
- **A ±10% band,** wider than ±5%, so normal week-to-week wobble stays "flat".
- **The baseline separates season from product.** After a peak like Diwali almost everything falls. A product down 20% while the typical product is down 25% is holding up; one down 50% isn't.

**When it can be wrong:**
- **Promotions in either half** distort it, and so do price changes.
- **Gifting and decor seasons,** where the store baseline helps but doesn't remove the effect entirely.

## 8. Restocking patterns

| Flag | Rule | Why it matters |
|---|---|---|
| **Small top-up** | a stock-out ended with a refill smaller than *Small top-up* [7] days of sales | someone added "a few pieces" by hand; the product will be out again within days |
| **Out again within a week** | the next stock-out started less than 7 days after this one ended | the refill was too small, or the reorder came too late |
| **Refilled with** | stock right after the product came back, in pieces and in days of sales | shows how big each restock really was |

These two flags are the habits that turn one stock-out into many. They're counted separately so a brand can see whether it has a supply problem or a restocking-habit problem.

---

## 9. Products page columns

| Column | Rule |
|---|---|
| Units / Sold / Lost | inside the selected period (7 / 14 / 30 / 60 days) |
| Sells / day, Avg price | over the last 28 days, whatever period is selected, so the reorder maths doesn't change when you switch the view |
| % lost | the product's lost ÷ (its sold + its lost) |
| Outs | stock-outs touching the selected period |
| Category | the product type from Shopify (or the CSV/Flow `type` column) |

Tables are built to fit the screen without sideways scrolling: on laptops narrower than 1400px the lower-priority columns (Units, Outs, Units lost) step aside, and under 1180px Category and the SKU do too. Every column is still in the CSV, and hovering a column header explains it. Column edges can be dragged to resize, like a spreadsheet; widths are remembered in that browser, and double-clicking an edge resets them.

---

## 10. Demo data (not real)

`src/demo.js` builds 60 days for a home-décor store on **Sammsara's public product list** (names, variants, prices from `sammsara.com/products.json`, saved in `src/demo-catalog.json`). **Every stock level, order and stock-out is invented.** The page shows "Demo data" whenever it's on. **Demo and real data never mix:** the first real row (Shopify, Flow, Sheet or CSV) deletes the demo before it's stored, and once a store has held real data the demo is never loaded again at start-up, not even after **Clear all data** or a new demo version (`everLive` in `store.json`). Loading it by hand from the Data page still works while Shopify isn't connected.

How it's generated, so the patterns look like a real store:
- **Popularity:** each product gets a demand rank. A few sell 5–10 a day; most sell under 1. Cheaper items sell more.
- **Time of day and week:** orders follow an evening-heavy day, and weekends are 15% busier.
- **Season:** gifting categories rise in the 18 days before Diwali (8 Nov 2026), peak around it, then dip for a week.
- **Baskets:** about 25% of orders include a second item.
- **Restocking habits** are assigned per product: proper restocks, late restocks, "a few pieces by hand" top-ups, overstocked slow movers, and a few never restocked.
- **Small extras:** damage write-offs and returns at a low rate.
- **Fixed seed:** the same seed gives the same demo every time.

The demo exists to show the screens with realistic shape. Its numbers say nothing about Sammsara's real business.

---

## 11. Known limits, in one place

- ₹ lost is an estimate of demand, and an upper bound where substitutes exist (section 4).
- Stock-out timing is to within 15 minutes with the Shopify pull alone (section 1).
- One lead time for all products; no supplier minimums or case packs (section 6).
- Profit lost and excess at cost need a unit cost per product; without one they fall back to selling price or are left out (sections 7b, 7c).
- The rate follows the last 28 days, so it lags a sudden season or campaign (section 3).
- Returns and cancellations aren't netted out of sales.
- One store per deployment; time zone is a fixed offset (no daylight saving, which India doesn't use).

## 12. Differences in the Google Sheet version

`modules/stock-watch-sheets/StockWatch.gs` uses the same rules, settings and thresholds, with two differences:
- **It values every hour of a stock-out equally** (no hour-of-day weighting, section 4a). Its ₹ lost can differ from the web app's for stock-outs mostly at night or mostly in the evening; over whole days the two agree.
- **It uses a fixed 30-day window** and counts a stock-out that started before it in full, where the web app counts only the hours inside the selected period.
