# Dev log

Newest first. Date · module · what changed and why · anything open.
Shared copy for the team: https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq

## 2026-11-19 · Sprint 2 · D-helpers (review fixes)
Reviewer found 12 issues on `sprint2/D-helpers`; fixed:
- Order-by follows the status (LOGIC §13a): This week rows near the line said "order by today" (7 of 46 in demo) but weren't in Order today. Now Order today rows → today, others → tomorrow at the earliest. `src/helpers.js` why().
- Out-of-stock Why: "lost ₹X this stock-out" so it isn't read as the Sales lost column; no ₹ when no open stock-out (it would repeat the column).
- Pause list: slow sellers without an order qty say "Slow seller · not reordered" instead of "Not ordered · earliest …". Kept on the list (not dropped when ₹0 sold): a product out the whole demand window has rate 0, is "Slow seller" and sold ₹0, and could be a best seller still on ads.
- Decide: "Don't reorder?" without "₹0 lost". Hide check uses saved-settings rates even with trial values on (`rates` option to `enrich`); demo load and demo-replacing import now wipe decisions.json (was only Clear all data).
- Phone: `.btn.xs` 44 px at ≤760 px (SW-023); sort label names the list order on Pause / Push / Decide. Dead `.why.crit` now styled (red, as days-left ≤ 3).
- Tests: 47 (4 browser tests in `test/ui-helpers.test.js` for Status column per tab, Why vs tab, Pause count line + Copy SKUs, Decide Keep/Undo, 44 px buttons; skipped without Playwright).
- ADR-0006 exception, recorded: Products default chips 5 → 6 (Pause promotion + Push these; Push replaces Overstock, which moves to More…). SW-026 acceptance asks for two chips and ADR-0006 names "a chip for Pause/Push"; SW-020 role views should drop Pause/Push for non-marketing roles to get back to 5.
- Not done: CHANGELOG (none exists; SW-056 creates it, a new file here would clash); screenshots / PR checklist (no PR from this branch); five-critic review; wrapping app.js 366–410 long lines (reformatting adds conflict surface; SW-059 splits app.js).

## 2026-11-19 · Sprint 2 · D-helpers
Branch `sprint2/D-helpers` (base 995369f). Module stock-watch. Commits 5b1a1d6 (helpers + tests), 8029c40 (server), ca0ce77 (UI), this one (docs).
- SW-024: Why cell on Reorder ("Out 3 d · lost ₹18.7k" / "Runs out Fri 22 Nov · order by today · supplier takes 7 d"); replaces Status on Order today / This week tabs; same sentence on phone cards and in the drawer; Stock-outs headline adds "N still out, costing ₹X/day". LOGIC §13a.
- SW-025: reorder CSV = PO: honours tab + search (`?filter=&q=`), Vendor (Shopify `product.vendor`, now in the stock query), Variant ID, Unit cost, UI status labels, Why, Order by; grouped by vendor; store-date file name; formula guard. LOGIC §13b.
- SW-026: Products chips "Pause promotion" (out or days left < lead) and "Push these" (overstock by ₹ stuck; replaces the Overstock chip, which moves to More…); count line "42 to reorder · 14 slow", Copy SKUs, CSV; Back in stock uses the SW-012 ETA when present. LOGIC §13c.
- SW-032: More… → "Slow sellers to decide": slow + out → "Don't reorder? ₹ lost", slow + stock → "Clear ₹ at cost"; Keep/Clear/Drop stored in `DATA_DIR/decisions.json` (`/api/decide`), hidden until the rate moves > 50% (0.1/day floor); Undo list. LOGIC §13d.
- New files only for logic: `src/helpers.js`, `src/decide.js`, `test/helpers.test.js`, `test/helpers-server.test.js`; engine.js untouched. 42 tests green. UI checked at 1280/1440/1920/390 (no sideways scroll, no console errors).
- Merge notes (on top of Sprint 1): server.js report/product/CSV lines conflict with Sprint 1's `catalog`/`onOrder` args — keep Sprint 1's args, wrap with `helpers.enrich(...)`; use `rows.csvCell` or `helpers.csvCell` (same rule). helpers already reads `p.onOrder.eta/late` and status `Ordered`/`Inactive`; `vendorMap` reads `catalog[id].vendor` once SW-002's catalog stores vendor. app.js Reorder cols: add Why next to Sprint 1's trend/act columns.
- Open: per-item commits are by layer (helpers / server / UI) because items share files; five-critic review not run in this workstream. (Phone sort label: fixed in review fixes above.)

## 2026-11-19 · stock-watch (simplicity pass)
Simplicity critic (12 findings), adopted except where noted:
- Three user-facing statuses: Order today (out / critical / order now), This week, OK; out of stock = red dot by the name; one "Order today" count everywhere (side menu, Overview, Reorder, Products). "OK" never shows an order quantity (engine sets it to 0).
- Overview: headline "Order ₹X today · stock-outs cost ₹Y", 4 tiles (sales + profit lost, cash to order today, best sellers at risk, overstock), Order today + Biggest losses lists, chart below; client paragraph → Copy summary button.
- Reorder: 6 default columns (Product, Status, Order, Order cost, Days left, Sales lost) + Columns picker; tabs Order today / This week / All; Plan settings collapsed with 3 plain-language fields; CSV in ⋯ menu.
- Stock-outs: one row per product (times out, days out, still out, pattern); individual stock-outs in the drawer; side-menu badge = still out (16), not 357.
- Products: 5 tabs + More…; 7 default columns + Columns picker (remembered); "Best seller" tag instead of "A"; Typical chip removed (kept in tooltip); trend sparkline only in the drawer.
- Data: status card first; four connection options folded; time zone drop-down; planning rules under Advanced; Danger zone; sign out once (phone only on this page).
- Plain labels everywhere ("Stock should last (days after delivery)", "Extra buffer", "Times out", "Refilled too little", "Ran out again", "Losses for").
- Rejected: dropping column resizing (the owner asked for it; it's invisible until hover).

## 2026-11-19 · stock-watch (cross-module + UI critic fixes)
Cross-module critic (14 findings):
- What counts as a sale now matches DAWBU: Shopify pull leaves out cancelled and test orders, nets refunds/removals (`currentQuantity`), uses price after line + order-level discounts (`discountedUnitPriceAfterAllDiscountsSet`, checked in Shopify's docs), and re-reads orders updated since the last run, replacing their lines (later cancellations/refunds picked up). Order lines keyed by Shopify line ID.
- Docs fixed: Flow + pull duplicates (stock-outs not double-counted; wording corrected), "Out for" = full length while ₹ lost and product-days use hours inside the period, Sheet LOGIC.md now lists every difference (order value at price, no A-first, no duplicate dropping, sale definition depends on Flow, tabs count ₹ lost differently), SETUP.md warns about pasting overlapping exports, stale comments and package description.
- Not done yet (next cycle): shared packages (`packages/shopify-read`, `packages/rows`, `packages/stock-rules`) with a parity test between engine.js and StockWatch.gs. Recorded in DECISIONS.md.
UI critic (16 findings):
- Typing in Assumptions reversed digits (number inputs lost the caret on redraw) → text inputs with decimal keypad; caret kept.
- Tables page by 50 (Show more / Show all); headers stay pinned under the top bar; keyboard: rows and headers focusable, Enter/Space opens or sorts, aria-sort, drawer focuses Close and returns focus to the row.
- Contrast: lost red #C8344F, faint grey #6B7385, amber text #9A5B0F; "This week" pill neutral; stock-outs rail count grey (history, not an alert).
- Drawer leads with the decision: order qty + value, days left, rate, sales + profit lost, and a readable trend.
- Stock-outs page headline totals sales and profit lost; column "Sales lost"; "Out again" wording consistent; "Order now" naming consistent.
- Bars animate only when a page opens, not on every keystroke; reduced motion respected for the Assumptions arrow.
- Phone: bigger touch targets, curated Sort-by (no meaningless options), Order now list above the chart, category not in code font.
- Gift cards removed from the demo catalog (not inventory).
- Open: Products 92px too wide at 1440 (left for the simplicity pass: fewer default columns).

## 2026-11-19 · stock-watch (logic critic fixes)
Logic critic found 12 confirmed + 1 suspected issues; all fixed except where noted:
- New launches: sales rate now starts at the product's first record (was diluted → false "Overstocked").
- Trend: time before a product's data is "no data", not zero sales (short history showed +133%); "New" needs 7 in-stock days before and 3+ sales since; baseline is now the median product trend (same measure), labelled "Typical".
- A best seller is never "Slow seller" (high-price items were hidden from reorder); no-demand products never "Out now" even at cutoff 0.
- Totals = sum of product rows; daily chart includes the partial first day (Overview and Products disagreed by ~2%).
- Overstock tooltip wording fixed (flag at 2× need, cash = beyond 1× need). Reorder text and days-left colours follow trial values.
- Assumption labels no longer act as the − button; inputs properly labelled. Save/Reset errors shown.
- Profit lost visible on all laptop widths; tile says "N/M costed" when costs are partial.
- Column widths stored per screen size, only for visible columns, scaled to fit; resize works with touch (pointer events). Keyboard resize: not done (rejected for now, low value vs effort).
- Blank trial value no longer read as 0.
- 7 regression tests added (27 total).

## 2026-11-19 · stock-watch (trend + Shopify credentials)
- Trend column (Reorder, Products, phone cards): 8 rolling weekly bars with stock-out marks, % change in sales per in-stock day (last 14 vs prior 14), store baseline; Rising / Falling tabs. LOGIC.md 7d, with why plain week-on-week (DAWBU sheet) misleads.
- Shopify credentials: client ID + secret is now the main path (Dev Dashboard apps, 24-hour token via client credentials grant, renewed automatically); clear error for `shop_not_permitted` (app and store must be in the same Shopify organisation). Key Vault reads `shopify-<store>-client-id` / `-client-secret`. Legacy `shpat_` still works. Tests with a fake Shopify.
- Critic rule added (AGENTS.md rule 10, docs/ORCA.md).

## 2026-11-19 · stock-watch (money view: best sellers, profit, overstock, live assumptions)
- Overview KPIs are now money-first: sold, sales lost (% of demand), profit lost, best sellers at risk, cash to order now, cash in overstock.
- Best sellers = ABC by revenue (A = first 80% of sales); A badge everywhere; A first within each reorder status; Products tabs "Best sellers", "Best at risk", "Overstock".
- Unit cost read from Shopify (inventoryItem.unitCost, read_inventory) or a CSV/Flow cost column → profit lost, margin, and order value at cost (cash to commit). Demo costs 38–55% of price.
- Excess stock: pieces beyond lead + cover + safety days of sales; overstocked when over twice that or not selling.
- Assumptions bar (Overview, Reorder, Products): change lead time, cover, safety, sales history, slow cutoff or small top-up and every number updates live via trial query values; Save as default / Reset.
- Columns resize by dragging header edges; widths remembered per browser; double-click resets.
- LOGIC.md sections 6a, 7a, 7b, 7c added.

## 2026-11-19 · stock-watch (fit the screen)
- Tables fit the screen with no sideways scroll at 1280–1920px (measured): short column labels with hover explanations, compact status pills, "This week" for "Order this week", refill as "30 · 2.7 d", Avg price moved to CSV only, low-priority columns hide below 1400px / 1180px (still in CSV). Products filter bar fits one line at 1280px.

## 2026-11-19 · stock-watch (Products page + logic docs)
- Products: status tabs with counts (All, Out now, Critical, Order now, This week, OK, Slow sellers, Lost sales), category filter, CSV of what's shown, new columns (category, days left, units, % lost, order qty). Category comes from the product type (Shopify `productType`, CSV/Flow `type`, demo catalog).
- Product column pinned while tables scroll sideways; long names/categories cut with … (full text on hover).
- Added `LOGIC.md` per module: every number's rule, reason, alternatives and limits, with a worked example. Rule added to AGENTS.md: change LOGIC.md with the rule.

## 2026-11-19 · stock-watch (density pass: no wasted space)
- Full-width content; compact KPI cards, panels and tables (rows about 37px, SKU beside the name).
- Overview: chart beside Order today (10 items); Biggest losses (10) beside a new "Out of stock right now" list and the client note.
- Phones: one-line top bar, KPI cards three across, method notes hidden, filters in one scrolling row, cards about half the height (decision line + one line of facts).

## 2026-11-19 · stock-watch (QA pass, every page on phone + desktop)
- Charts sized to the screen so labels are readable on phones; re-render when crossing the phone breakpoint.
- Details panel now closes when you change page (it stayed open over other pages).
- Stock-outs table: dates, durations and refill sizes no longer wrap.
- "Not selling" renamed "Slow seller" (under 0.2/day; they do sell) and shown grey, not green.
- Data page: buttons wrap instead of running off a phone screen; long variable lists wrap; tighter panel spacing.
- Overview summary: total out-of-stock time shown as product-days with a thousands separator.

## 2026-11-19 · stock-watch (phone layout)
- Under 760px wide, Reorder, Stock-outs and Products show cards instead of 9-column tables: the decision on top (status + order qty; ₹ lost), three key numbers below, a Sort by picker, tap for details. Desktop columns reordered so decision columns sit next to the product.

## 2026-11-19 · stock-watch (Performity look)
- Restyled to match the Performity app (from the screenshots in catalysAnalyst/performity-site; the app's code isn't shared with us): Inter, brand blue #0978BE, pale blue page, icon rail (bottom bar on phones), top bar with store picker and a Data Sync pill, white KPI cards, dense tables, "last synced" footer. Sold = brand blue, lost = rose #E0506E. Sign-in page and favicon recoloured to match.

## 2026-11-19 · stock-watch (login)
- Replaced the browser's Basic-auth pop-up with a sign-in page and a 30-day signed cookie. The pop-up never appears in embedded browsers (Orca, in-app, some phones), so the live link looked broken. 10 wrong tries lock an IP out for 15 min. Basic auth still works for scripts.

## 2026-11-19 · repo
- Restructured into `modules/<name>/` with an `AGENTS.md` per module (+ `CLAUDE.md` importing it) so any tool picks up the context. Root `Dockerfile` builds `modules/stock-watch` for Railway.
- Added `docs/ORCA.md` (parallel agents with Orca), `docs/DECISIONS.md`, this log.

## 2026-11-19 · stock-watch
- Demo data rebuilt on Sammsara's public catalog (255 variants, real names and prices; stock and sales invented): 60 days, about 77 orders a day, Diwali gifting peak and post-festive dip, baskets, long tail, five restocking habits. Servers holding the old demo rebuild it on start.
- Read-only Shopify pull: key from Azure Key Vault (`shopify-<store>`) or Railway variables; only GraphQL queries allowed; stock every 15 min, orders since last pull (60-day first load, saved per page); paced on Shopify's cost budget; refuses to start without a password once connected.
- Fixed "No data yet" badge stretching (a general `.empty` style hit it).
- Deployed to Railway with a `/data` volume and password.
- **Open:** Key Vault access from the dev team; Performity repo access; Railway auto-deploy on push (GitHub app access for `kartiks-source`).
