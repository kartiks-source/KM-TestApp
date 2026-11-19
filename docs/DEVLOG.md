# Dev log

Newest first. Date · module · what changed and why · anything open.
Shared copy for the team: https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq

## 2026-11-19 · Sprint 2 · B-roles
stock-watch, branch `sprint2/B-roles` (base 995369f; not merged, not deployed). Commits: 4ef2150 SW-027, 261619e SW-020, 7f88c26 SW-028.
- SW-027: one line under the Overview headline, "Yesterday: ₹X sold · ₹Y lost · N ran out · M back" (yesterday's store-time day, same numbers as its chart bar), and "This month" in the period picker (from the 1st, store time; "Month" on phones). New `src/period.js`; engine takes `opts.from`. LOGIC.md §5a, `test/period.test.js`.
- SW-020: role home views that only remove UI (ADR-0006): 7 RACI roles in `public/roles.js`, each lands on its page/tab and hides menu items, tiles, lists, chart, plan bar or columns. Picked from the store menu (desktop), Data → Show me (phone) or `/?role=ceo`; remembered per browser; no role = today's view. Data is never hidden (switch back). LOGIC.md §13, `test/roles.test.js`, `test/smoke/roles-smoke.js` (every role shows fewer pieces than the default on its home page at 1280/1440/1920/390; no sideways scroll).
- SW-028: morning digest per role (≤ 6 lines + link): `src/digest.js` (text), `src/digest-service.js` (`GET /api/digest?role=`, `/api/digest.txt`, settings, send now, schedule at a store-time hour after a fresh pull, weekly roles Mondays, every send logged). Overview "Copy summary" became a Share menu (copy summary / copy digest / WhatsApp `wa.me` link); Data → Morning digest (webhook URL, hour, roles, pause, last sends). Webhook URL never shown back (host only); `DIGEST_WEBHOOK_URL` overrides. No email provider, no deps. LOGIC.md §14, `test/digest.test.js`.
- app.js touched in small hooks only (showCol, start, Show me field, Share menu, digest panel, period wording); new code in new files.
- Open: per-role webhook URLs (one URL, `role` in the body today); warehouse home → Ordered list after SW-012, marketing home → Pause/Push chips after SW-026; "This month" makes SW-031 visible (order value moves with the period because ABC does); first-open role prompt left out on purpose (it would grow the default view), roles are set by menu or link; five critics not run on this branch yet; shared dev log page row not added.

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
