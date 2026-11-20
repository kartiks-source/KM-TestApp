# Stock-out Watch: how every number is worked out, and why

This is the reference for anyone who questions a number on the page. Each section gives:
- the rule, in plain words and as a formula
- why we chose it
- what else we considered
- when it can be wrong

The code is in `src/engine.js`, which has no inputs or outputs of its own, so every rule here can be tested. The tests are in `test/engine.test.js`. All settings mentioned can be changed under **Data & settings**; the defaults are shown in brackets.

If you change a rule, change this file in the same commit and add a line to `docs/DEVLOG.md`.

---

## 0a. Store time (SW-049, `public/tz.js` via `src/tz.js`)

**Rule:** every store has one time zone, `settings.timeZone`, an IANA name such as `Asia/Kolkata` (default) or `Europe/London`. Every store-time day, hour, month and date stamp goes through the one helper `public/tz.js` (the page loads it, the server requires it through `src/tz.js`): rows without a zone (§1a), the daily chart and hour profile (§4a, §5), This month and Yesterday (§5a), Mark ordered dates (§6b), Why / PO / Pause dates (§15), the digest hour and title (§17), backup file names and the page's own dates. Nothing adds a fixed +5:30 any more.

- **Daylight saving:** the offset is looked up per moment (cached per 15 minutes), so a London or New York store's days run midnight to midnight on its own clock. The day the clocks go forward is 23 hours long, the day they go back 25; each is still one day on the chart and one Yesterday.
- **Clock times that don't exist or happen twice:** a row stamped 02:30 on the spring change day reads as the moment the clock jumps (03:00); 01:30 on the autumn day reads as the first 01:30.
- **Digest hour** is the store's wall clock: "09:00" stays 09:00 after the change.
- **Older stores** saved only `tzOffsetMin` (minutes east of UTC). 330 reads as `Asia/Kolkata`; any other number as a fixed offset (`+05:45`) with no daylight saving. Picking a zone in Settings replaces it. Reports still echo `tzOffsetMin` = today's offset, for older readers.

**Why:** one helper means one answer; a fixed offset breaks every store outside India twice a year.
**Considered:** keeping fixed offsets (wrong in Europe, US, Australia); the server's local time (Railway runs in UTC).
**Can be wrong:** a zone whose rules change after the runtime's time zone data was built (Node and browsers update with their releases).

## 1. What goes in

Two streams, nothing else:

| Stream | One row per | Fields |
|---|---|---|
| Stock changes | each time a variant's stock number changes | time, variant ID, SKU, product, variant, stock before, stock after, list price, category (optional) |
| Order lines | each line of each order | time, order number, variant ID, SKU, quantity, unit price actually paid |

- **Stock is the variant's total across all locations.** A stock-out means the shopper couldn't buy it anywhere on the site, which is what loses the sale.
- **A variant is the unit of analysis** (e.g. "Nesting Table · Black Marble"), because that's what a shopper picks and what goes out of stock.
- **The same row arriving twice is stored once.** Stock rows are matched on time + variant + before + after; order lines on order number + variant + quantity (`src/rows.js`).
- **Data older than 120 days is dropped** (`src/store.js`), since nothing on the page looks further back than 90 days, **with two exceptions per variant:** its newest stock row (its stock now, even if it hasn't moved in months) and the row that opened a stock-out that's still running. Without them, dead stock lost its only row after 120 days and vanished from Overstock, and a long stock-out lost its start.

### Current stock and attributes (the catalog)

With Shopify connected, every pull also stores the **catalog**: each variant's stock now, list price, unit cost, category, tags, product ID and status, replaced whole on every pull (ADR-0010). The numbers use it as follows:

- **Stock now, price, cost and category come from the catalog**, not from the last stock row. A cost change in Shopify shows on the next pull even if stock didn't move, so profit and cash maths use today's cost. Stock rows are the change history, used for stock-outs.
- **Inactive variants** (product archived or draft, inventory not tracked, or no longer in Shopify) are left out of reorder and overstock: they can't be sold, so their stock isn't cash you can free by selling and they don't need ordering. They still count in Sold and Lost for days they sold, and appear in Products (status *Inactive*) only if they sold or had a stock-out in the period. The Data page shows **Excluded: N archived/draft, X pcs**.
- **A stock-out on a variant that went inactive ends when it went inactive** (first pull that saw it inactive), so an archived product doesn't keep adding ₹ lost or sit in *Still out*.
- **A variant that is made active again keeps its inactive spells** (catalog `spells: [{from, to}]`, up to 20, dropped 120 days after they end). Stock-outs are cut at each spell: the part before it ends when the variant went inactive, and if the variant comes back still at 0 it is out again from that moment. The spell's days are also not in-stock days for the sales rate (§3), so days it couldn't be sold don't dilute it. *Why:* a common practice is to set a sold-out product to draft and reactivate it on restock. Without the spells, the reactivation forgot the draft time and the stock-out ran straight through it: one repro (5 a day at ₹1,000, out 25 days ago, draft 24 days ago, back 1 day ago) jumped from ₹926 lost to ₹1,15,714, and past daily bars and Yesterday changed after the fact (final critic L1). *Considered:* keeping only the last spell (a variant drafted twice would lose the first). *When it can be wrong:* spells start at the first pull that saw the variant inactive, so they are as precise as the pull (15 minutes).
- A variant deleted from Shopify is kept as *deleted* for 120 days, then dropped with its rows.

Without Shopify (Flow, Sheet, CSV), there's no catalog: stock now is the newest stock row, and nothing is inactive unless the row source leaves it out.

**Where it comes from and how precise it is:**

| Source | Stock-out timing |
|---|---|
| Shopify pull (read-only, every 15 minutes) | to within 15 minutes; a stock-out that starts and ends between two reads is missed |
| Shopify Flow → this app (no Shopify connection) or the Google Sheet | to the minute, because Flow fires on each change |
| CSV upload | as precise as the file |

**One source per store (ADR-0009).** Once Shopify is connected, the pull is the only source: Flow (`/ingest/*`), Sheet sync and CSV import are refused (409) with a plain message, because their order lines are keyed differently (order + variant + quantity vs Shopify's line ID) and the same sale would count twice. Clear and import also wait while a pull runs. Without Shopify, Flow, Sheet and CSV can be used together: they share one key, so the same order line sent by two of them is stored once. Every row records where it came from (`src`: shopify, flow, sheet, csv, demo). Rows stored before Shopify was connected stay; the pull replaces all lines of each order it reads (by order name), so a Flow or CSV copy of an order from the last 60 days is replaced, not doubled. Exact repeats of a row are dropped.

**Is the data fresh?** With Shopify connected, the data counts as **stale when the last good pull is more than 45 minutes old** (three missed 15-minute pulls), or when there has been no good pull within 45 minutes of the app starting. Each store is judged on its own (§18); stale data in any store turns the unauthenticated `/status` to 503 for the uptime monitor, and `/api/report` carries `freshness {lastPull, ageMin, stale}` for the "Data is X h old" banner. Without Shopify nothing is ever stale, because Flow, Sheet and CSV data arrive whenever the brand sends them.

**Stale banner:** when Shopify is connected and the data is stale, a red banner above every page says "Data is X h old" with the time of the last pull and any error, and links to Data & settings. It reads the server's `/status` when available, else the pull time sent with the report; re-checked every 60 s; never shown on demo data.

**Times without a time zone** (in a CSV, Sheet or Flow row) are read in the store's time zone (setting *Time zone*, India by default).

### 1a. CSV, Sheet and Flow rows: what's accepted and what's refused

Bad rows feed reorder money, so a file is refused or a row skipped rather than guessed (`src/rows.js`, tests in `test/rows.test.js`).

| Rule | Why | Considered instead |
|---|---|---|
| A CSV upload or Sheet tab must start with a header row. Required: stock `Time, Variant ID, Stock now`; orders `Time, Variant ID, Qty`. Missing ones → upload refused (400) naming them; Sheet sync shows the same message | a file with other headers used to import by position, as phantom stock-outs | guessing columns by position (silently wrong) |
| Exact column names beat aliases (e.g. `Stock now` over `Inventory`); each column is used once. `Variant` is the variant title, never the ID; `Collection` is not a category | `Variant` was read as the ID, so whole files keyed on titles | first match wins (order-dependent) |
| Numbers may carry `₹`, `Rs`, thousands commas and spaces (`₹1,299` = 1299). Text that isn't a number skips the row (*bad number*); a blank stock or qty skips the row; a blank price is ₹0 | `₹1,299` used to become ₹0, blank stock became 0 = a stock-out | treating blank as 0 |
| Dates are day first: `15/11/2026 10:30`, or ISO `2026-11-15 10:30`. Month must be 1–12 and day 1–31 (and a real date), so US `11/15/2026` is refused, not guessed. A date with no time is 00:00 store time | a US date silently became a different day or a future date | guessing US vs Indian order per file |
| CSV / Sheet: a row with no readable time, or a time more than 1 day in the future, is skipped (*bad time*). Only Shopify Flow rows with no readable time are stamped "now" (Flow fires at the moment of the change) | stamping a file's rows "now" made old history look like today's stock-outs | stamping all rows now |
| Rows older than 120 days are skipped (*older than 120 days*), so the counts shown match what is kept | they'd be pruned on save anyway | importing and pruning silently |
| `;`-separated files are detected from the first line | spreadsheet exports in some locales use `;` | asking the user |

The upload message lists how many rows were read, new, and skipped for each reason.

**When it can be wrong:** a day-first file where every date has day ≤ 12 (e.g. `05/11/2026`) can't be told apart from a US file and is read day first. Decimal commas (`1.299,50`) aren't supported.

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
- **A blank *Stock before* = the previous row's *Stock now*,** never 0. *Stock before* can be blank: a CSV without that column, or a Shopify variant made active again (its last-seen stock was forgotten while it was draft). A blank used to read as 0, so every stock-out after the first was missed (one repro: 3 stock-outs showed as 1 and ₹ lost fell to a sixth, *Out now* with nothing *Still out*), and a variant reactivated at 0 was never counted as out. A blank on a product's first row is still 0 (no earlier evidence). *Considered:* always using the previous row's *Stock now* (wrong where a file skips rows: its *Stock before* is the better evidence) and refusing rows without *Stock before* (Shopify's own reactivation rows have none).

**When it can be wrong:**
- **Bundles or pre-orders** sold at 0 stock would look like stock-outs.
- **Products that are paused rather than out** would also look out. Untracked products and products not set to Active get no stock rows from the Shopify pull for this reason, and a stock-out ends when the product turns inactive (section 1, catalog). If it is made active again, the inactive time stays cut out: the stock-out is not stretched back over it (section 1, spells).

---

## 3. Sales per day (the in-stock rate)

**Rule:**

> sales per day = units sold in the last 28 days ÷ days the product was **in stock** during those 28 days (at least 1 day)

Setting: *Sales history used* [28 days]. If the store's data starts later than 28 days ago, the window starts with the data. **A product's own window starts at its first stock record or first order**, so a product launched 5 days ago is measured over those 5 days, not diluted by 23 days before it existed. (Without this, a new launch looked like a slow, overstocked product.)

**Long stock-outs (fewer than 7 in-stock days in the window):** the window can't say what the product sells, so the rate looks further back:
1. **The most recent 28 in-stock days** within the history we keep (120 days), skipping the time it was out: units sold over that stretch ÷ the in-stock days in it.
2. **If it hasn't been in stock at all in that history**, the 28 days before the stock-out began.

The average price paid (section 4) comes from the same sales. A product launched recently, or a store whose data starts recently, has no older history, so for it nothing changes. The product's `rateBasis` says which rule gave the rate (`window`, `history` or `before-out`) and `rateFrom` when that stretch starts.

*Why:* without this, a best seller out for the whole 28 days sold 0 in the window, so it got a rate of 0: it showed as a Slow seller with ₹0 lost and dropped off the reorder list. The costliest stock-outs vanished from exactly the lists meant to catch them. Example: 5 a day at ₹1,000, out for the last 30 days → still 5 a day, **Out now**, order 5 × 40 = 200, ₹ lost ≈ 30 × 5 × ₹1,000 = ₹1,50,000 over a 30-day view. *Why 7 days:* under a week, one good or bad day swings the rate too much, and weekdays aren't all covered. *Considered:* a fixed 90-day window for everyone (too slow to follow a season) and carrying the last rate forward from before the stock-out (ignores any in-stock days since). *When it can be wrong:* if demand really fell while the product was out (season over, trend passed), the older rate over-orders; check the product's sales chart before a big order.

**Days it couldn't be sold** (archived, draft, untracked, deleted: §1) count like out-of-stock days: they're left out of the in-stock days, so a product drafted for three weeks and then reactivated keeps its rate.

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
| Daily chart | the same two numbers per store day (setting *Time zone* [Asia/Kolkata], §0a); the first bar is the partial day the period starts in |
| Selling items out now | products at 0 stock that sell at least the minimum rate (section 7) |
| Out of stock right now (list) | every open stock-out, slow sellers included, so it can be higher than the count above |
| Product-days with an empty shelf | total stock-out hours across all products ÷ 24 |
| Headline | "Order ₹X today · ₹Y sales lost in N days": ₹X = order cost of the *Order today* rows (§6), ₹Y = Lost to stock-outs above. The lost number is called **sales lost** on every screen |
| Tiles | each says what the headline doesn't (final critic SIMP-1: the same ₹ used to show three times, under two names): **profit lost** (§7b) · % of demand, or, with no unit costs, **% of demand lost** · number of stock-outs; **more to order this week** = order cost of the *This week* rows (whole reorder list − Order today) · products, opens Reorder → This week; **best sellers at risk**; **stuck in overstock** |

### 5a. "This month" and the Yesterday strip (SW-027, `src/period.js`)

- **This month** (period picker): from the 1st of the current month at 00:00 store time until now. On the 1st it covers only today so far. Every number that follows the period (sold, lost, % of demand, daily chart, Products and Stock-outs pages, CSV) uses this window. The reorder plan does not depend on the period: best-seller rank (§7a) rests on the 28-day demand of active products only, so order value, best sellers and order quantities are the same for 7, 30, 60 days and This month. Shown as "this month" instead of "in N days".
- **Yesterday strip** (one line under the Overview headline): `Yesterday: ₹X sold · ₹Y lost · N ran out · M back`.
  - *Sold* and *lost* are yesterday's store-time calendar day, exactly the numbers on that day's bar in the daily chart (same rules as section 5, including the hour-of-day weighting for lost).
  - *Ran out* = products where a stock-out started yesterday; *back* = products where a stock-out ended yesterday (stock came back above 0). A product that ran out twice counts once.
  - When the period doesn't reach back to yesterday (This month on the 1st), the strip is worked out from a separate 2-day report with the same settings. That report drops the page's own period (`from`), which would otherwise override the 2 days and leave the strip blank on the 1st (critic L1; `test/period.test.js`).
- Why: the owner checks "how did yesterday go" every morning; a fixed rolling 30 days hides it, and month-to-date matches how targets and budgets are set (DAWBU sheet).
- Considered: a "Yesterday" button in the picker (a one-day period). Rejected: one line answers the question without changing every other number on the screen.
- When it can be wrong: *lost* yesterday uses today's in-stock rate, like every ₹ lost figure (section 4); stock-outs are timed to within 15 minutes with the Shopify pull alone, so one that started just before midnight can land on the wrong day.

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

## 6b. Already ordered ("Mark ordered")

**Rule:** when someone places a purchase order they tick the row on Reorder (one or many) and press **Mark N ordered** in the bar that appears, or use **Mark ordered** in the product drawer and give the quantity and the expected date it lands (defaults: the suggested order quantity, today + lead time). The app stores one record per variant: `{ qty, eta, at, by }` (`DATA_DIR/onorder.json`, kept as safely as `store.json` and carried in every backup, export and restore: a damaged file is never read as "nothing on order", which would put ordered lines back in Order today; critic r2 X1, RUNBOOK → Backups).

> received = sum of stock increases recorded after the order was marked, each measured from *Stock before*, or from the previous row's stock when that's blank (section 2), so a row with a blank *Stock before* isn't read as an increase from 0
> still to come = ordered qty − received; once 90% has arrived the order is treated as complete and dropped
> it **counts** when it's not past its date **and** lands before the shelf empties, or no later than an order placed today could (today + lead time), with a day's grace because dates are whole days
> when it counts: the plan is worked out on stock now + still to come

| Result | Shown as |
|---|---|
| stock + on order is enough (status would be OK) | **Ordered · lands 25 Nov**, off Order today, listed under the **Ordered** tab, order qty 0 |
| stock + on order still isn't enough | stays in Order today, order qty = only the extra still needed, with "50 on order" next to the status. The row keeps the status it has without the order (**Out now**, **Critical**, **Order now** or *This week*) however close the order gets, since units on the way don't change when the shelf empties; the Why cell still says "order by today" (critic L2: a part-filled order used to move an empty shelf to *Order now* or even *This week*, off Order today and out of "out now"; final r2 L1: the same for stock > 0, e.g. 5/day, 10 in stock, 50 on order moved Critical to *This week*) |
| past the expected date and less than 90% received | back in **Order today**, in red: "Ordered 200 · was due 25 Nov" |
| lands after the shelf empties and later than a fresh order could | doesn't count: the row stays in Order today with the order shown, so you can decide whether to chase the supplier or order elsewhere |

**Ordered tab** (Reorder): every open order, whatever its status: one that covers the need, a part order (still in Order today too), a late one, one landing too late to count. Late first, then by landing date. Columns: *Lands* ("Lands 25 Nov · 40 of 200 in · order 150 more" / "Late · was due 22 Nov", red), *On order (pcs)* = still to come, days left, in stock. Headline: "N on order · M due this week · K late" (due this week = lands within 7 days, not late); empty: "Nothing on order. Marked orders show here until they land." The tab's CSV has the same rows. Rule in `helpers.onOrderRows` / `onOrderSummary` (app.js mirrors it). Critic SIMP-1: the tab used to list status *Ordered* only, so a part or late order (the ones a warehouse must chase) never showed there, and the tab's qty column read 0.

**Days left** still uses stock on hand only, because that's when the shelf empties. A product that's out of stock but ordered still counts in "out now" and keeps losing sales until the order lands.

**Why:** the plan used to look at stock on hand only, so a line ordered yesterday showed up again today with the same quantity, which invites a duplicate purchase order. Counting units only when they land in time keeps the list honest: an order that arrives after the shelf is empty doesn't stop the stock-out. Detecting arrival from stock increases means nobody has to "receive" the order in a second step.

**What else we considered:**
- **Reading purchase orders from Shopify:** Shopify has no purchase-order API for most stores, and the app is read-only (ADR-0001).
- **Clearing the mark on any stock increase:** a return of one piece would clear a 200-piece order. Counting units received is more exact.

**When it can be wrong:**
- **Returns or manual stock corrections after the mark** count as received, so a large return can make an order look partly arrived.
- **A short shipment of up to 10%** is treated as complete.
- **One record per variant:** marking again replaces the previous order (add the quantities yourself if there are two open orders).
- Overstock (§7c) doesn't count units on order.

## 7. Slow sellers

**Rule:** a product selling below *Ignore below* [0.2 units a day, about 6 a month] is a **Slow seller**. Slow sellers are left out of the reorder list and alerts, but their stock-outs and ₹ lost are still counted.

**Exception: a best seller (A, section 7a) is never a slow seller.** A ₹90,000 sofa selling one a month can be in the top 80% of ₹ demand; it stays on the reorder list.

**Why:** for a product selling one unit a month, "days left" and "order quantity" swing wildly with a single order, and filling the reorder list with them hides the products that matter. It's not marked "not selling" because these products do sell, just slowly. A product with no sales at all is never "Out now" or on the reorder list, whatever the cutoff.

---

## 7a. Best sellers (A / B / C)

**Rule:** products are ranked by **₹ demand a day** = sales per day (section 3) × average price paid (section 4), both from the 28-day sales history, **not** the selected period. Going down that list, the products that together make the **first 80% of demand are A (best sellers)**, the next 15% are B, and the rest, plus anything with no demand, are C. A products show a **Best seller** tag everywhere. **Inactive products** (archived, draft, untracked or deleted, §2) are not ranked and are always C: they can't be ordered, and they appear in the rows only when they sold or lost sales in the selected period, so ranking them let the period buttons move A slots, best sellers at risk and order value (critic r2 L2: demo with 15 variants archived 6 days ago gave 90 A at 7 days, 97 at 30).

- **Best sellers at risk** = A products that are Out now, Critical or Order now.
- The reorder list puts A products first within each status.

**Why:** a stock-out on an A product costs the most and is usually the one ads are pushing. 80 / 15 / 5 is the standard ABC split in inventory management.

**Why demand, and why not the selected period:** the rank decides who stays on the reorder list (section 7) and comes first in it, so it has to rest on the same 28 days as the order quantity. Ranked by the selected period, switching 7 → 60 days changed who was a best seller and so the cash to order (demo: order value ₹46.3 lakh at 7 days vs ₹46.8 lakh at 60). Demand rather than ₹ sold, because ₹ sold drops for a product while it's out of stock: a best seller out for three weeks fell to C and out of **Best sellers at risk**, exactly when it was most at risk. For a product in stock the whole time, demand a day is just its ₹ sold ÷ days, so the order is the same as ranking by sales.

*Considered:* ₹ sold over the 28-day window (simpler, but has the stock-out problem above).

**When it can be wrong:** a launch or a heavily discounted product can jump into A while its 28 days are dominated by the launch or the sale. Its rate has the same lag (section 3).

## 7b. Profit lost and margin

**Rule:**

> profit lost = units lost × (average price paid − unit cost)
> margin = (average price paid − unit cost) ÷ average price paid

**Unit cost** comes from Shopify's inventory item cost ("Cost per item", readable with `read_inventory`), or from a `cost` column in a CSV/Flow row. Products without a cost show "–" and aren't counted in profit lost. The Overview's first tile shows profit lost only when at least one product has a cost (otherwise it shows % of demand lost), and says "N/M costed" when only some do: then it's a minimum.

**Why:** ₹ lost in sales overstates what the business lost. What it actually lost is the margin on those sales, and that's the number to weigh against the cost of holding more stock.

## 7c. Excess stock and overstock (cash tied up)

**Rule:**

> needed = sales per day × (lead time + cover + safety days)
> excess pieces = stock now − needed (never below 0)
> excess ₹ = excess pieces × unit cost (× average price paid if cost is unknown)

A product is **Overstocked** when its stock is more than **twice** what's needed, or it has stock but hasn't sold at all. **Cash in overstock** on the Overview adds up, for overstocked products only, the excess ₹ beyond **one times** the need (the cash you could free by selling down to a normal level). The "twice" is only the flag threshold.

**Why:** this is the cost-cutting side of the same maths. Money sitting in stock that won't sell for months could pay for stock that's running out. The usual moves are to stop reordering it, bundle it with a best seller, or discount it. The "twice" margin keeps a product that's only slightly over from being flagged.

**Left out:** inactive variants (archived, draft, untracked, deleted; section 1). A variant that hasn't moved in months still counts: its stock comes from the catalog or its newest stock row, which is never pruned.

**When it can be wrong:** stock bought ahead of a known season or campaign will look overstocked until the demand arrives. A product set to draft while it's being restocked or re-shot drops out of overstock until it's active again.

## 7d. Trend (sparkline and % change)

**Rule:**
- **Bars:** units sold in each of the last 8 rolling 7-day blocks ending now, oldest on the left, scaled to that product's best week. A **rose mark** under a bar means the product was out of stock for part of that week. Hovering a bar gives the dates, units and days out ("13–19 Nov: 54 sold, out 2.3 d"); a block is labelled by the 7 calendar days it ends on, so the last one ends today.
- **Where it shows:** in the decision rows, not only the drawer. On Products and Reorder, screens 1400 px and wider get a Trend cell (bars + % chip); narrower screens get small bars inside the product name cell (no extra column); phone cards show the bars at the right of the card header. The drawer shows the 8 weekly numbers under the bars, with the date each week starts.
- **% change** = sales per **in-stock** day in the last 14 days vs the 14 days before:

  > rate = units sold ÷ days in stock (in that 14-day half)
  > change = (recent rate − earlier rate) ÷ earlier rate

  The chip shows the product's own % change. Its **colour is read against the typical product** (below) **and the product's own sign**: green when it's rising (% > 0) and 10 points or more above the typical product's %, rose when it's falling (% < 0) and 10 or more below, grey otherwise (`trendCall` = up / down / flat). So a fall is never green and a rise never red: −20% when the typical product is −35% is grey, with "Falling, but less than the typical product" in the tooltip (critic UI-1: green −20% next to a red −₹1.87 L in Moving read as growing). With fewer than 5 products to take a median from, it's read against 0. The *Selling faster / slower* filters on Products use the same call. **New** = in stock for at least 7 days of the earlier half with no sales, and 3 or more sold since. **·** = too little to call: under 6 units over the 28 days, or under 3 in-stock days in either half.
- **Only time we have data for counts.** Days before a product's first record are "no data" (an empty bar), never "in stock, sold 0". Without this, a store with 20 days of history showed every product at +133%.
- **Typical-product baseline:** the **median** of all product trends (needs 5 or more). It sets the chip colour, and its value is in each chip's tooltip and the Trend column header's. It's the same measure as the product trend. An earlier version compared raw store units, which store-wide stock-outs dragged down; that made flat products look like they were outperforming.

- **₹ effect (Overview "Moving" card):** what the trend is worth, so the card ranks by money rather than by %:

  > ₹ effect = (recent rate − earlier rate) × average price paid × 30

  i.e. ₹ a month of sales at the new pace, with the rates as above (sales per in-stock day, last 14 days vs the 14 before). It's set only where there's a trend to call (a % or **New**; for New the earlier rate is 0). The card lists the top 3 up and the top 3 down by this number. A +200% on a ₹300 candle matters less than +20% on a ₹40,000 sofa; ranking by ₹ shows that.

**Why it's built this way (and what's wrong with plain week-on-week, as in the DAWBU sheet):**
- **Stock-outs aren't demand.** A product out for half of last week shows −50% week-on-week, though shoppers wanted it as much as ever. Dividing by in-stock days removes that. It's the same principle as section 3.
- **Two weeks against two weeks.** For a product selling a few a week, one week against one week swings wildly (2 → 1 = −50%). Doubling the window halves most of that noise, and the 6-unit minimum hides changes that are just noise.
- **Rolling weeks ending now,** not calendar weeks, so there's never a half-finished current week dragging the last bar down.
- **A ±10-point band,** wider than ±5, so normal week-to-week wobble stays grey.
- **Colour against the typical product, not against 0** (critic round 1). With a ±10% cut-off against 0, after a store-wide fall (typical −38% in the demo) about 70% of Reorder rows were red, which reads as "cut the orders" when most products were only following the season. Now red means "worse than the rest of the store", which is what a manager can act on. *Considered:* showing the gap in points as the chip text (another unit to learn) and a separate "Typical product −38%" chip in the toolbar (the earlier version; nobody read it).
- **The baseline separates season from product.** After a peak like Diwali almost everything falls. A product down 20% while the typical product is down 25% is holding up; one down 50% isn't.

**When it can be wrong:**
- **Promotions in either half** distort it, and so do price changes.
- **Gifting and decor seasons,** where the store baseline helps but doesn't remove the effect entirely.
- **₹ effect** assumes the new pace holds for a month and uses today's average price; read it as a size, not a forecast.

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
| Sells / day, Avg price | over the last 28 days (further back for a long stock-out, section 3), whatever period is selected, so the reorder maths doesn't change when you switch the view |
| % lost | the product's lost ÷ (its sold + its lost) |
| Outs | stock-outs touching the selected period |
| Category | the product type from Shopify (or the CSV/Flow `type` column) |
| Trend | weekly bars + % change (section 7d); its own column at 1400 px and wider, small bars in the name cell below that |

Tables are built to fit the screen without sideways scrolling: on laptops narrower than 1400px the lower-priority columns (Units, Outs, Units lost) step aside, and under 1180px Category and the SKU do too. Every column is still in the CSV, and hovering a column header explains it. Column edges can be dragged to resize, like a spreadsheet; widths are remembered in that browser, and double-clicking an edge resets them. **Optional columns are on by default** (show everything, ADR-0006 amendment 20 Nov); Columns… unticks one, remembered on that browser. When they don't all fit, optional columns **step aside**, the right-most first, until the table fits, and a note above it names them ("Not shown at this width: Sells / day, Times out"); a wider screen, or unticking others, brings them back. Only a column someone dragged wider can still make that one table scroll sideways inside its box, with a note ("More columns than fit: scroll the table sideways"); before, columns were cut off out of reach (critic r2 UI-2). The default columns fit every Reorder and Products tab from 1181 px up (tested at 1280 and 1400; Reorder → All keeps Sales lost on screen: its name column gives up ~60 px to Status, critic r2 UI-1), so the page itself never scrolls sideways.

## 9a. Group by: product, category, collection, tag (SW-022)

"View: Products ▾" on the Products page rolls the product rows (one per variant) up into groups. Code: `src/groups.js`, tests: `test/groups.test.js`.

| View | One row per | Key | Each variant is in |
|---|---|---|---|
| Parent products | Shopify product (its variants together) | product ID | exactly one group |
| Categories | Shopify product type (`productType`, or the CSV/Flow `type` column) | the type itself | exactly one group ("No category" if blank) |
| Collections | Shopify collection | collection ID | every collection its product is in ("Not in a collection" if none) |
| Tags | product tag | the tag, case-folded | every tag its product has ("No tag" if none) |

**Keys are IDs, never titles**, so two products or collections with the same name never merge, and a rename doesn't split a group. Category and tag have no ID in Shopify, so the value is the key; tags are case-folded because Shopify treats "Gold" and "gold" as one tag. A variant the catalog doesn't know yet (CSV/Flow data, or a product added since the last pull) is its own parent product, keyed by variant ID.

Each group row adds up its variants' rows, with the same rules as the Products page (section 9):

| Column | Rule |
|---|---|
| Products | variants in the group (the rows a click shows) |
| Need order | variants whose status is Order today (out now, 3 days or less left, or order now), "x of n" |
| Sold, Sales lost, Profit lost | sums over the selected period; Profit lost blank when no variant has a unit cost |
| Order ₹ | order value of the Need-order variants (the same "Order today ₹" as the Overview) |
| Overstock ₹ | cash beyond need, overstocked variants only (section 7c) |
| Trend: bars | the same 8 weekly blocks as a product (section 7d), each the **sum of the variants' units** that week; a week no variant has data for is "no data" (empty bar). **Rose mark** when one or more of the group's variants was out part of that week, as on a product row; the hover says how many ("12–18 Nov: 54 sold, 3 of 12 products out part of the week"). Shown like a product row: in the Trend cell with the % chip (always, the group table has room at 1280), and at the right of the phone card header (hidden at 380 px and below, as on product cards). SW-021, `groups.js` `weeks` |
| Trend: % | the variants' sales per in-stock day added up, last 14 days vs the 14 before (the halves of section 7d), from each variant's weekly blocks. A variant without data in both halves, or with under 3 in-stock days in either, is left out; under 6 units in all: no trend. **Colour** (critic r2 UI-3): the product rule of section 7d, against the same baseline (the typical product's trend, the median of product trends): green only when the group's own % rises and is 10+ points above it, red only when it falls and is 10+ points below; otherwise grey. The tooltip compares with the same typical product |

**Totals.** Parent products and categories add up to the report totals (sales, lost, order ₹, overstock ₹, profit lost; tested). Collections and tags overlap: a product with two tags counts in both rows, so there is **no grand total**: the headline shows only the number of groups ("13 tags"), and a footnote gives the distinct store total (each variant once). "Products" counts variants everywhere (the Products page rows); the parent-product lens says "parent products" for its groups.

**Catch-all collections are hidden by default.** A collection holding 80% or more of the products in the report ("All products", "Home page") tells you nothing and would top every list; a button shows them. Products only in hidden collections fall into "Not in any other collection".

**Why:** the client plans and sets targets by tag and collection (the DAWBU sheet), not by single variant. Summing variants keeps every number identical to the Products page, so a group can be checked by clicking it. **Considered:** recomputing each group as one big product (its own rate, its own stock-out hours); rejected because the group's lost would no longer equal the sum of its products' lost. **Can be wrong:** collection membership is up to 24 hours old (section 9b); tags and categories follow the last stock pull (15 minutes). The group trend counts a variant's first partial week as fully in stock. The bars' rose mark says "some product was out", so a big group (a category of 50) shows it under most weeks; the hover gives the count. *Considered:* rose only when the average product lost a day or more (hides a best seller's stock-out inside a big group); a share-of-days shade (another thing to learn).

## 9b. Where groups come from (catalog, read-only)

`src/catalog.js`:
- **Variant → product, category, tags:** from the store's catalog snapshot (SW-002, `store.json` → `catalog`, replaced by every stock pull; `STOCK_Q` reads `product { id tags productType }`). One source: the same snapshot gives the engine its stock now, so a group can't disagree with the rows it holds. A deleted variant keeps its last product and tags.
- **Same numbers as the report:** `/api/groups` runs the report with exactly the options `/api/report` uses (period, trial values, catalog snapshot, Mark ordered), so a parent-product or category total equals the report total; a product marked ordered leaves *Need order* as it leaves *Order today*.
- **Collections and their products** (kept in `DATA_DIR/catalog.json`): read once a day (24 h cache) with two read-only queries, `collections` and `collection.products`, through the same read-only guard as every Shopify call. Progress is saved after every page, so a restart carries on where it stopped instead of starting again; at most 400 pages per pull, the rest with the next pull. Smart and manual collections are read the same way (Shopify returns the current members of both).
- Needs only `read_products`, which the app already has.
- Demo data gets product IDs, tags and collections derived from the Sammsara catalog's product types and names (section 10).

---

## 10. Demo data (not real)

`src/demo.js` builds 60 days for a home-décor store on **Sammsara's public product list** (names, variants, prices from `sammsara.com/products.json`, saved in `src/demo-catalog.json`). **Every stock level, order and stock-out is invented.** The page shows "Demo data" whenever it's on. **Demo and real data never mix:** the first real row (Shopify, Flow, Sheet or CSV) deletes the demo before it's stored, together with everything done on it: "Mark ordered" records (section 6b) and slow-seller decisions (section 15d), so a demo purchase order never lowers a real order quantity and a demo "drop" never hides a real product (SW-007; one function, `store.endDemo()`, for every path). The CSV upload has no "remove the demo first" choice: it always does, and once a store has held real data the demo is never loaded again at start-up, not even after **Clear all data** or a new demo version (`everLive` in `store.json`). Loading it by hand from the Data page still works while Shopify isn't connected.

How it's generated, so the patterns look like a real store:
- **Popularity:** each product gets a demand rank. A few sell 5–10 a day; most sell under 1. Cheaper items sell more.
- **Time of day and week:** orders follow an evening-heavy day, and weekends are 15% busier.
- **Season:** gifting categories rise in the 18 days before Diwali (8 Nov 2026), peak around it, then dip for a week.
- **Baskets:** about 25% of orders include a second item.
- **Restocking habits** are assigned per product: proper restocks, late restocks, "a few pieces by hand" top-ups, overstocked slow movers, and a few never restocked.
- **Small extras:** damage write-offs and returns at a low rate.
- **Tags and collections (for Group by):** variants of one product share a product ID; tags say furniture or décor, finish (Gold, Brass, Marble, Glass…), motif (Animal motif, Floral), Diwali gifting and price band (Under 3000, Premium); ten collections are built on those, including an "All products" catch-all. Derived from the catalog's product types and names, not Sammsara's real tags.
- **Fixed seed:** the same seed gives the same demo every time.
- **Two demo stores** (no Shopify key, ADR-0015): **Sammsara (demo)** (seed 11, the full catalog) and **Second store (demo)** (seed 29, every third product left out, prices × 0.6, order numbers from #39001). Same rules; different numbers, so a mix-up between stores would show at once.

The demo exists to show the screens with realistic shape. Its numbers say nothing about Sammsara's real business.

---

## 11. Known limits, in one place

**Whatever the source:**
- ₹ lost is an estimate of demand, and an upper bound where substitutes exist (section 4).
- One lead time for all products; no supplier minimums or case packs (section 6).
- "Mark ordered" spots arrivals from stock increases, so returns after the mark count as received; one open order per variant (section 6b).
- Profit lost and excess at cost need a unit cost per product; without one they fall back to selling price or are left out (sections 7b, 7c).
- The rate follows the last 28 days, so it lags a sudden season or campaign (section 3). After a long stock-out it uses older sales, which over-orders if demand fell meanwhile.
- One time zone per store (§0a); a store selling across zones still sees its own clock only.
- Group by: collection membership can be up to 24 hours old; tag and collection rows overlap, so they have no grand total (section 9a).

**By source** (what counts as a sale is in section 1):

| | Shopify pull | Flow / Google Sheet / CSV |
|---|---|---|
| Stock-out timing | to within 15 minutes; a stock-out that starts and ends between two reads is missed | to the minute (Flow), or as precise as the file |
| Cancellations, refunds, removed items | netted: cancelled orders left out, units are Shopify's `currentQuantity`, later edits re-read | **not netted**: counted as sent; a later cancellation or refund isn't picked up |
| Discounts | price after line and order-level discounts | as sent |
| Test orders | left out | counted unless the Flow condition excludes them |

## 12. Differences in the Google Sheet version

`modules/stock-watch-sheets/StockWatch.gs` uses the same rules, settings and thresholds. Every difference is listed in one place, [`../stock-watch-sheets/LOGIC.md`](../stock-watch-sheets/LOGIC.md), so this section doesn't repeat them. `test/parity.test.js` runs the same fixtures through both and fails `npm test` on any difference that isn't on that list (same status and order quantity, ₹ lost within 2%).

## 13. Who can change what (view-only sign-in, settings change log)

Code: `src/access.js`, `src/audit.js` (SW-029, ADR-0011). Tests: `test/access.test.js`.

**Rule.**
- Two shared passwords. `ADMIN_PASSWORD` signs in as **admin** (sees and changes everything). `VIEW_PASSWORD` (optional) signs in as **view**: every number, page and CSV export is the same, but nothing can be changed.
- The server decides, not the page: any `POST`, `PUT`, `PATCH` or `DELETE` to `/api/…` from a view session (cookie or Basic auth) is refused with **403** before any route runs. That covers settings, Plan settings "Save as default", imports, sheet sync, Shopify "Pull now", demo, clear, "Mark ordered" (`/api/onorder`), and any write route added later. `GET /api/export/backup.json` (the whole store, ingest key and change log included) is admin-only too.
- A view session never receives the Flow ingest key (it would let them write through `/ingest`): not in `/api/settings`, and the `settings` echoed in `/api/report` and `/api/product/…` never carry it for any role. View sessions get an empty change log (it holds old and new sheet links; the log is on the Data page, which they don't have).
- The page hides what a viewer can't use (ADR-0006: role views only remove): no Data page, no "Save as default", no Mark-ordered ticks, bulk bar or drawer order form (the drawer still shows what is on order). Trying values in Plan settings still works (it changes nothing stored); Reset is kept.
- The role is inside the signed session cookie, with a fingerprint of `VIEW_PASSWORD`: a view cookie can't be edited into admin, and changing or removing `VIEW_PASSWORD` signs all view sessions out. Admin cookies keep their old form, so existing sign-ins stay valid.
- The server refuses to start when `VIEW_PASSWORD` is set without `ADMIN_PASSWORD` (nobody would need to sign in) or equals it.
- **Change log:** every settings save writes one entry per setting whose value actually changed: `{ at, by, key, old, new }`. Morning digest settings (section 17) go to the same log: `digest.hour`, `digest.roles` (the ticked roles, "founder, ops"), `digest.paused`; and `digest.webhook` when the webhook set on the server changes (hosts only, never the URL, by "server (env)", noticed on the next digest call or scheduler minute; the first look only records it). `by` is the role (`admin`), with "(script)" when the change came with Basic auth instead of a sign-in. Numbers are compared as numbers (14 and "14" are the same). The ingest key is never logged: it shows as "(old key) → (new key)". Newest first, last 200 kept in `store.json` (`settingsLog`).
- **Shown:** the latest change to lead time, stock should last or buffer under Plan settings ("Last changed … by … · old → new"), for every role; the last 50 changes under Data → Settings → "Advanced: change log" (admin only; view sessions get `changes: []`).

**Why.** RACI: CEO and finance view, they don't change assumptions or data. A page that only hides buttons can be bypassed with one `curl`, so the check sits on the server. The log answers "who changed cover days and when" when a reorder number moves.

**Considered.** Named users (needs a user store or Performity SSO, later ADR). Per-route checks (easy to forget on a new route; one gate before every write is safer).

**Limits.** Two shared passwords, so "who" is a role, not a person. The log covers settings only, not data actions (import, clear). Wrong-password limits are shared by both passwords. A viewer sees the "Sync issue" pill without its link (no Data page), so the error text is only its hover tooltip, which phones don't show.

## 14. Sync progress and run history

Code: `src/runs.js`, counts from `syncShopify` / `syncSheet` in `server.js` (SW-030). Tests: `test/runs.test.js`.

**Rule.**
- A **run** is one Shopify pull (every 15 minutes, or "Pull from Shopify now") or one Google Sheet sync. Skipped syncs (nothing set up) are not runs.
- **While a Shopify pull runs**, the top-right pill reads "Syncing · stock" while stock is read, then "Syncing · 2,340 orders": the number of orders read so far in this pull (each page of 40 adds to it). The page asks again every 3 seconds until the pull ends, then reloads every number once. On a phone the pill is a dot; the same text is its tooltip and shows in the Data status card.
- **When a run ends** (finished or failed), one line is kept: start time, how long it took, stock changes stored, order lines read, orders read (Shopify), the error if it failed, and notes. A failed run keeps what it had counted before the error.
- **Notes** name what the stock pull leaves out on purpose: variants of archived or draft products, and variants whose stock isn't tracked (the stock pull reads only active products with tracked stock: `diffStock` in `src/shopify.js`). The numbers come from the same filter, so they can't drift from it.
- The last **20** runs are kept in `store.json` (`syncRuns`), newest first, and are not wiped by "Clear all data". Shown on Data, inside the status card, folded: "Last 20 syncs · latest 19 Nov 16:00, 8 s, OK".

**Why.** "Is it stuck or still loading?" on a first 60-day pull, and "when did it last fail, and why?" without reading server logs.

**Considered.** A percentage bar: Shopify doesn't say how many orders are left, so any % would be a guess. Logging every page: too much; one line per run is enough to spot a pattern.

**Limits.** Order lines "read" count lines re-read when an order changed (refunds, edits) as well as new ones. Progress lives in memory: after a restart mid-pull the pill shows nothing until the next pull starts.

## 15. Decision helpers (Sprint 2: SW-024, SW-025, SW-026, SW-032)

All in `src/helpers.js` (pure functions, tested in `test/helpers.test.js`). They add fields to the report; none of them changes a number from sections 1–7. Dates are in the store's time zone (setting *Time zone*).

### 15a. Why cell, order-by date, still-out cost per day (SW-024)

One plain sentence per row, the same text in the Reorder table, the phone card and the product drawer (and for the morning digest, SW-028, via `helpers.why()`):

| Row | Sentence | Rule |
|---|---|---|
| Out of stock | "Out 3 d · lost ₹18.7k this stock-out" | time since the open stock-out began (hours under a day, else days, rounded); ₹ lost = this stock-out's ₹ lost inside the selected period (section 4), not the row's whole-period Sales lost (hence "this stock-out"). No open stock-out found → just "Out" (the Sales lost column already has the period's ₹) |
| Has stock and sells | "Runs out Fri 22 Nov · order by today · supplier takes 7 d" | **runs out** = now + days left; **order by** = runs out − (lead time + buffer) days, then set by the status: *Order today* rows → today; any other row → tomorrow (store time) at the earliest; "supplier takes" = lead time. The Reorder **table** leaves the "· supplier takes N d" tail to the cell's tooltip (it's the same on most rows and in Plan settings), and caps the cell at 260 px up to 1440 px wide, so *In stock* stays on screen on a laptop (final critic UI-3) |
| Marked ordered (SW-012) | "Ordered · lands 25 Nov" | the order's ETA |
| No sales in the window | "No sales lately" | no rate, so no date |
| More than a year of stock | "Over a year of stock" | a date that far out means nothing |

**Why order by = runs out − (lead + buffer):** that is the day the status turns *Order now* (section 6). The status decides the edge cases so the date and the status always agree: *Out now*/*Critical*/*Order now* rows say "order by today" (a Critical row with a short lead time too); every other row says tomorrow or later. Example: 10.04 days left, lead + buffer 10 → still *Order this week*, and the raw date (in an hour) is today; it shows tomorrow, and the row moves to *Order today* when the status turns *Order now* later today. Ordering then uses up to a day of the buffer.

**Status column:** on the Reorder tabs *Order today* and *This week* every row has the same status, so the column is replaced by the Why cell. *All* keeps both.

**Still-out cost per day** (Stock-outs headline, every screen size: "17 still out, costing ₹16,599/day", with "N products ran out M times · ₹ sales lost · ₹ profit lost" under it; final r2 SIMP-B: desktop used to put all five numbers in one line) = Σ over products at 0 stock of sales per day × average price paid. It is the sales rate each empty shelf is missing right now; tomorrow's ₹ lost grows by about this much if nothing is refilled.

**When it can be wrong:** dates assume the rate holds (section 3); one lead time for the store (section 6); a product out for the whole demand window has rate 0 (section 3) and adds nothing to the per-day cost.

### 15b. Reorder CSV as a purchase order (SW-025)

`GET /api/export/reorder.csv?filter=today|week|ordered|all&q=…` gives the same rows the Reorder tab shows (tab + search on name and SKU), grouped by vendor A–Z (unknown vendor last), otherwise in page order. Columns: Vendor, Product, SKU, Variant ID, Order qty, Unit cost, Order value, Status (the page's labels: Order today / This week / Ordered), Why, Order by (date), Stock now, Sells per day, Days left, Sales lost (₹). The file name date is the store's date.

- **Vendor** = Shopify `product.vendor`, read with the stock pull (newest stock row that has one; the catalog's when there is one). Blank for CSV, Sheet, Flow and demo data. Like type and cost, it updates when the variant's stock next changes (until the catalog snapshot, SW-002, is in).
- **Unit cost** is blank when unknown; Order value then uses the average price paid (section 6), so check those lines.
- Text cells starting with `= + - @`, tab or CR get a leading `'` so a spreadsheet never runs them.

### 15c. Pause / Push lists for marketing (SW-026)

Two chips on Products, each with a count line, **Copy SKUs** (one per line; variant ID when there's no SKU) and **CSV**:

| List | Rule | Order | Count line |
|---|---|---|---|
| **Pause promotion** | stock ≤ 0, or days left < lead time (it can't be refilled before it runs out) | out now first, then fewest days left, then most ₹ a day | "42 to reorder · 14 slow": on the list with an order quantity / slow sellers |
| **Push these** | overstocked (section 7c) | most ₹ stuck first | "₹2.60 L stuck" |

Archived/untracked and no-stock-data rows are on neither. **Back in stock** on the Pause list = the marked order's ETA (SW-012), "Late · was due …" past it, a slow seller with no order quantity "Slow seller · not reordered" (it is off the reorder list, section 7, so an earliest date means nothing), else "Not ordered · earliest <today + lead time>". Push replaces the old *Overstock* chip (same products) and is the only overstock list: the Overview's overstock tile opens it, and More… no longer has an *Overstock* duplicate (critic r2 S1; an old `over` filter opens Push these).

**Headline leads with the decision** (critic r2 M1, ADR-0006): on Pause promotion the page title is "Pause promotion on N products", on Push these "Push N overstocked products" (N = the rows shown); other filters keep "Products". Pause promotion cards on the phone show **Back in stock** in the badge place, not the reorder status (the buyer's decision, not marketing's).

**Why days left < lead time (not ≤ lead + buffer):** promotion spend should stop only when the shelf will empty before any new stock can land; the buffer is for ordering, not for ads.

### 15d. Slow-seller "Decide" bucket (SW-032)

Products → More… → *Slow sellers to decide*: every **Slow seller** (section 7) with stock data, biggest ₹ first. It is the only slow-seller filter (critic r2 S1: a separate *Slow sellers* option listed the same rows without the Decide column); its count leaves out decided items, which are listed under the table.

| Case | Shows | ₹ |
|---|---|---|
| slow + out of stock | "Don't reorder? ₹X lost" (just "Don't reorder?" when ₹X is 0) | ₹ lost in the period |
| slow + has stock | "Clear ₹X at cost" | stock × unit cost (price when no cost) |

One click stores **Keep**, **Drop** or **Clear** (out-of-stock rows: Keep / Drop) in `DATA_DIR/decisions.json` with the product's sales per day at that moment (`base`, taken from the server's report, not the page). The item is hidden until **|rate now − base| > 50% × max(base, 0.1/day)**; then it comes back showing the earlier decision. The 0.1/day floor stops one stray sale on a product that sold nothing from bringing it back (it needs about 2 sales in 4 weeks). Decided items are listed under the table with **Undo**. `decisions.json` is kept and backed up like `onorder.json` (§6b). Decisions don't change any number or status; Clear all data, loading demo data and replacing demo data with an import wipe them (they belong to the data they were made on).

**Saved settings only:** the base and the hide check both use the sales rate on the **saved** settings. Trial values (the what-if fields, e.g. a different *Sales history to use* window) change the report but never hide or bring back a decided item.

**When it can be wrong:** saving a different *Sales history to use* window moves rates and can bring items back.

## 16. Role home views (SW-020, `public/roles.js`)

No number changes with a role: a role view only **removes** parts of today's default screen (ADR-0006) and picks the page you land on. No role chosen = **All** (the default): every page, every panel, every column. Reorder opens on its **All** tab unless a role lands elsewhere; there its headline states the scope, "Order ₹X today across N products · ₹Z more this week (M)", so the list, the CSV and *Tick all* add up to the headline (₹X + ₹Z = the whole list's order cost; final critic SIMP-2). The *Order today* tab's headline is today only.

| Role | Lands on | Removed (everything else stays) |
|---|---|---|
| CEO | Overview (2 tiles + daily chart) | Reorder in the menu; "Order ₹X today" in the headline (it leads with sales lost); tiles "more to order this week" and "best sellers at risk"; both lists; Mark ordered (ticks, bulk bar, drawer form) and the Ordered tab |
| Founder / COO | Overview | daily chart |
| Ops / inventory | Reorder → Order today | Stock-outs in the menu; the "each order covers…" line; daily chart |
| Buyer | Reorder → Order today | Overview and Stock-outs in the menu; plan settings; explainer; Sales lost column; Pause / Push chips |
| Marketing | Products → Pause promotion (§15c: out, or runs out before a reorder could land: don't promote) | Reorder and Stock-outs in the menu; "Order ₹X today" in the Overview headline; "more to order this week" tile, Order today list; Order column; Mark ordered and the Ordered tab |
| Finance | Overview | Stock-outs in the menu; tiles "profit lost" and "best sellers at risk"; Biggest losses list; daily chart; Mark ordered; Pause chip |
| Warehouse | Reorder → Ordered (SW-012: every open order, late first; headline "N on order · M due this week · K late", §6b) | Overview, Stock-outs, Products in the menu; period picker; plan settings; explainer; Order cost and Sales lost columns; Mark ordered |

- Chosen from the store menu (top left; on phones the store bar under the top bar, which also shows the role: final critic M1, a view-only sign-in has no Data page), **Show me** on Data & settings, or a link `/?role=ceo` (`?role=all` = All, the default). Remembered per browser.
- **Landing:** a role opens on its home page and tab when the address has no `#page` or has `#<its home>` (digest links: `/?role=marketing#products` → Products → Pause promotion). Any other `#page` opens as asked. `landing()` in `public/roles.js`, tested.
- **Mark ordered** (SW-012) follows RACI "Place the PO": founder (A), buyer (R) and ops (C, "also sees Mark ordered") keep the ticks, bulk bar and drawer form; the others lose them (the drawer still shows what is on order). The Ordered tab shows whenever it is the open tab, even with nothing ordered, so the warehouse never lands on a missing tab. Pause / Push chips go for roles that are "–" on ads (buyer, finance: Pause; warehouse has no Products page).
- RACI "the A's number first": a role that drops the "more to order this week" tile also drops "Order ₹X today" from the Overview headline, so it starts with "₹Y sales lost".
- Data & settings is never removed: it holds the switch back. Removing a page from the menu doesn't lock it (view-only access is SW-029).
- Why: each role has one decision (docs/RACI.md); the rest is noise for that person. Considered: per-role pages. Rejected: they'd add screens for everyone and drift from the default.
- Checked: `test/roles.test.js` (every role removes something on its home page, never Data); `test/smoke/roles-smoke.js` counts visible pieces per role against the default at 1280/1440/1920/390.

## 17. Morning digest (SW-028, `src/digest.js`, `src/digest-service.js`)

A few plain-language lines per role and per store, with a link that opens that store and role's view (`/?store=<id>&role=ops#reorder`). The title names the store (`Stock-out Watch · <store> · 20 Nov`); each store has its own hour, roles, pause and send log, and stores are checked one after the other. At most 6 lines including the title; the link comes after. Same rules and numbers as the page: order today, overstock and best sellers come from the default 30-day report; "yesterday" is §5a.

| Role | When | Lines |
|---|---|---|
| CEO | Mondays | sales lost last 7 days (₹, % of demand) **vs the 7 days before**; profit lost; cash in overstock; best sellers at risk |
| Founder / COO (and "Everyone") | daily | order today ₹ and products; still out + cost per day; yesterday; overstock |
| Ops / inventory | daily | order today lines + ₹; top 3 lines (qty, days left); yesterday ran out / back |
| Marketing | daily | pause promotion count + top 3; push (overstock ₹) + top 3 |
| Finance | Mondays | cash to order today + more due this week; overstock; sales lost last 7 days |
| Buyer, Warehouse | not pushed (RACI "–") | buyer: order today; top 3 by order cost. Warehouse: what lands, not what to order (critic SIMP-1): "On order: N lines, X pcs to come · M due this week · K late", then the first 3 of the Ordered tab (late first) with pieces and date. Available from Share and `GET /api/digest?role=` |

- **Still out, cost per day** = the Stock-outs headline number (§15a): Σ over products at 0 stock: in-stock rate (§3) × average price paid. What a day of the current stock-outs costs in sales, at today's rates.
- **Pause promotion** (marketing) = the Products → Pause promotion list (§15c, same code: `helpers.mktList` / `mktSort`): out of stock, or fewer days left than the lead time (a reorder placed today can't land in time); out now first, then fewest days left. Integration change: the branch had its own rule (sellers only, biggest ₹ sold first), so the digest count could differ from the chip. **Push these** = overstocked products (§7c), most ₹ stuck first.
- **Vs the 7 days before** (CEO): the same 7-day report worked out from the rows as they stood 7 days ago (nothing recorded after then), so it shows what the page showed that day. Of today's catalog it gets only the inactive flags of variants already inactive by then (`period.catalogAsOf`: status and since when, no stock or price; an inactive spell that ended by then is passed as a spell, one still running then as inactive since its start): a variant archived while out of stock gets no more rows from Shopify, so without the flag its stock-out would run on and the week before would count sales the page never showed (critic r2 L1).
- **More due this week** (finance) = order value of everything on the reorder list − order value for today.
- **When it's sent:** every minute the server checks: not paused, the role has a webhook URL, it is less than 3 hours after the set hour [9] in store time (a restart doesn't lose the morning's send; wraps past midnight, so 23:00 is caught up until 02:00 and counts for the day it was set for), and the role hasn't had one for that day (weekly roles: Mondays only). Then it pulls fresh data for that store (sheet, Shopify) and POSTs each due role's digest as JSON `{app, kind, at, store, storeId, role, roleName, title, lines, link, text, note?}`. One try per role per day; a failure is logged, not retried all morning ("Send now" retries by hand). A failed pull still sends, with `note` saying the numbers are from the last good pull.
- **Every send is logged** (last 50 kept, last 5 shown under Data & settings → Morning digest): time, role, scheduled or by hand, HTTP status or error.
- **Webhook URLs are env only** (they often carry a token; secrets stay out of `store.json` on the data volume): `DIGEST_WEBHOOK_URL` for every role, `DIGEST_WEBHOOK_URL_<ROLE>` (e.g. `DIGEST_WEBHOOK_URL_CEO`) for a role's own recipient. The page can't set one (PUT with `webhookUrl` → 400); it shows only the host, never the URL; never logged. https only (http only to this machine, for testing).
- **No webhook:** Overview → Share → Copy morning digest, or Send digest on WhatsApp (`wa.me/?text=`, opens WhatsApp with the text ready; no account or key on our side).
- Why a webhook and not email: no email provider, keys or dependencies; Zapier / Make / Slack / a WhatsApp Business tool turn one POST into email, chat or WhatsApp per recipient. Considered: an email API (needs a provider account and key in env); left for when a client asks.
- **Links:** `PUBLIC_URL`, else `RAILWAY_PUBLIC_DOMAIN`, else the address of the last signed-in request (Host / X-Forwarded-Host). Set `PUBLIC_URL` when a proxy in front can pass a wrong host.
- When it can be wrong: the CEO comparison counts a stock-out still open 7 days ago up to that day only; one role, one recipient (a webhook): more people per role means the receiving tool fans out; without `PUBLIC_URL` / Railway domain, scheduled links use the last signed-in address.

## 18. Several stores (ADR-0015, `src/stores.js`, `src/scope.js`)

No number changes with the store count: every rule above runs on **one store's rows only**. Stores never add up into one figure, and no total on any page spans two stores.

- **Which stores:** Performity → every brand our key may use (`GET …/brands`), id = `brand_id`, name = `brand_name` (`PERFORMITY_BRAND_ID`, when set, keeps only that brand). Key Vault → `STORES` (else `SHOPIFY_STORE`); Railway variables → `SHOPIFY_STORE`; no key → the two demo stores (§10). The list is read again every 10 minutes; when Performity can't be reached, the last good list stays (its pulls fail and say why).
- **Which store a page shows:** `?store=<id>` in the address; else the store last chosen on this browser (`sw_store` cookie); else the first in the list. An id not in the list is "Unknown store" (404).
- **Store name** = the name set under Data & settings, else the brand name (Performity), the store handle (Key Vault / variables) or the demo label. Shown in the store pill, the browser tab title, the digest title, alert messages and the PO CSV file name.
- **The picker** (`public/stores.js`): the store pill in the top bar opens a menu of every store, each with its status dot and a line ("Synced 5 min ago", "Sync problem: …", "Demo data"), above the role list. On phones (≤ 760 px, where the pill is hidden) a store bar under the top bar does the same, 44 px tall. Choosing a store puts `?store=<id>` in the address, remembers it on this browser (`localStorage` `sw-store` + the `sw_store` cookie, a year) and reloads on the same page. Keyboard: Enter / Space opens, focus starts on the current store, ↑ ↓ move, Enter picks, Esc closes. The menu never runs past the bottom of the window (it scrolls inside itself), and a long store name ends in "…" on the pill (full name on hover); on a narrow laptop the store name gives way before the period buttons or the view name. The list and its dots are read again every minute, so a dot and its line ("Synced 5 min ago") follow the stale banner without a reload. With several stores the product drawer names the store too. **One store:** the pill is the plain name (no dot, no store list); on phones the store bar shows the name and opens the role list only. The phone store bar always carries the role (· Marketing) and the role list (final critic M1). Every call the page makes carries `?store=` itself, so two tabs on two stores never cross; an address with an unknown id opens the default store instead.
- **Status dot** in the picker, per store: **red (error)** when its last Shopify pull or Sheet sync failed; else **amber (stale)** when Shopify is connected and its last good pull is more than 45 minutes old (§1 "Is the data fresh?", the same rule as the stale banner); else **green (ok)**. Demo stores are green.
- **What is per store:** rows, catalog, settings (plan settings, time zone, Sheet links, Flow key), Mark ordered (§6b), Decide (§15d), the settings change log (§13), run history (§14), digest settings and log (§17), backups. **For every store:** the admin and view passwords and roles (view-only is read-only on every store).
- **Pulls:** one store at a time, in list order, every 15 minutes; "Pull now" waits its turn. Why: Performity allows 30 calls a minute per IP and 10 token calls a minute per brand, and the Shopify app's limit is shared with Performity's own pulls. Calls to Performity are spaced at least 2.1 s apart, token calls for one brand at least 6.1 s.
- **`/status`** (uptime monitor): stale or failing when **any** store is; `ageMin` is the oldest store's; row counts and sizes are summed. No store names or ids.
- Why one folder per store and not a store id on every row: a missed filter would mix two brands' numbers; a folder can't be mixed by a missed filter. Considered: one deployment per store (no picker, N passwords). Kept as the fallback for a store that outgrows ADR-0003.
- When it can be wrong: with many brands a full round of pulls can take longer than 15 minutes, so the last store's data is older than the first's (its dot turns amber past 45 minutes). Renaming a brand in Performity changes the name here only if no name was set under Data & settings.
