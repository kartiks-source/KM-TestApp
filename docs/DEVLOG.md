# Dev log

Newest first. Date · module · what changed and why · anything open.
Shared copy for the team: https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq

## 2026-11-19 · Sprint 2 · A-groups
stock-watch · SW-022 group by product / category / collection / tag (branch `sprint2/A-groups`, base 995369f):
- `src/groups.js` (new): rollups of the Products rows by parent product, category, collection or tag; keys are IDs (product / collection ID; tag case-folded; category = productType, which has no ID). Parent-product and category lenses sum to the report totals (tested); tag/collection overlap, so only a distinct store total. Catch-all collections (≥ 80% of products) hidden by default. Group trend = summed sales per in-stock day, 14 vs 14 days.
- `src/catalog.js` (new): `STOCK_Q` now reads `product { id tags }` (same line as Sprint 1 B-data); `pullStock` hands variant nodes over (`onVariants`); collections + members via two read-only queries through `gql`, cached 24 h, saved per page so a restart resumes, 400 pages per run. Own file `DATA_DIR/catalog.json`.
- Demo: product IDs, tags (Furniture/Decor, finish, motif, Diwali gifting, price band) and 10 collections incl. an "All products" catch-all, derived from the Sammsara catalog types and names.
- UI: "View: Products ▾" replaces the Category select (one control, no tab). Group rows: Products · Need order (x of n) · Sold · Sales lost · Profit lost · Order ₹ · Overstock ₹ · Trend; click / Enter → Products filtered with a removable chip. Checked at 1280 / 1440 / 1920 / 390×844, no sideways scroll.
- `GET /api/groups?lens=…` (new route). LOGIC.md §9a, §9b, §10, §11. Tests: `test/groups.test.js`, `test/catalog.test.js`, `test/groups-api.test.js` (route: lens list, 400 on unknown lens, all=1, login, click ids = Products rows).
- Review fixes: tag/collection headline shows only the count ("13 tags"), store total only in the footnote; parent-product lens says "parent products" ("Products" = variant rows everywhere else); phone card "x of n to order". Commits e2664e3..cc738a5 + review-fix commit.
- Open: five critics not run on this branch (one reviewer pass done, findings fixed); touch targets 36 px on phone for View select and chips, app-wide 36 px chip rule, left to SW-023; merge with Sprint 1: `server.js` syncShopify line (pullStock call) will conflict with B-data's `setCatalog` line, keep both; then point `catalog.current()` variants at `store.catalog`. Shared dev log page not updated (no publishing from this workstream).
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
## 2026-11-19 · Sprint 2 · C-access
Branch `sprint2/C-access` (base 995369f, before the Sprint 1 merges). Module stock-watch.
- SW-029 (771b471): `VIEW_PASSWORD` = view-only sign-in. Role signed into the session cookie with a `VIEW_PASSWORD` fingerprint (can't be edited into admin; changing the password signs viewers out; admin cookies unchanged). One gate in `api()` refuses every POST/PUT/PATCH/DELETE to `/api` from a view session with 403 before any route runs (settings, import, sync, Shopify pull, demo, clear, and future routes such as Mark ordered). Viewers never get the ingest key. Page: no Data link, no "Save as default"; trial values + Reset still work; phone gets a Sign out button at the bottom. Refuses to start with `VIEW_PASSWORD` but no `ADMIN_PASSWORD`, or both equal. New `src/access.js`.
- SW-029: settings change log `{at, by, key, old, new}` in new `src/audit.js` (store.json `settingsLog`, newest first, 200 kept; only real changes; ingest key masked; `by` = role, "(script)" for Basic auth). Last Plan change under Plan settings; last 50 in Data → Settings → "Advanced: change log". LOGIC.md §13.
- SW-030 (ff8fbd1): pill shows "Syncing · stock" then "Syncing · 2,340 orders" (orders read so far), polled every 3 s while a pull runs; same text in the Data status card. Last 20 runs (Shopify pulls and sheet syncs) kept in store.json `syncRuns`: start, time taken, stock changes, order lines, orders, error, notes (archived/draft and untracked variants left out, counted by `diffStock`). Shown folded in the Data status card. New `src/runs.js`. LOGIC.md §14.
- Tests: `test/access.test.js` (roles, cookie tamper/expiry/rotation, 403 on 8 write routes with cookie and Basic, change log via routes, start refusal), `test/runs.test.js` (history cap, notes, real `syncShopify` with stubbed reads: live progress then stored run, failed run keeps its error). 38 pass.
- Checked at 1280/1440/1920/390: no sideways scroll; admin default views unchanged in size.
- Merge notes (onto Sprint 1): `server.js` auth was rewritten in SW-008 (`auth()` returns 'ok'|'none'|'bad'|'limited'). Port the role: `sessionRole()` via `access.cookieRole`, Basic → `access.roleForPassword`, login → `access.cookieValue`; put the `access.refused` 403 gate right after auth and BEFORE `backup.route` and `onorder.handle`. Main's `GET /api/export/backup.json` includes settings: strip `ingestKey` for view sessions there too (or refuse it). Sprint 1 `syncShopify` adds `store.setCatalog`; keep the run hooks around it.
- Open: "by" is a role, not a person (shared passwords, ADR-0011). Data actions (import, clear) not in the change log. Five critics not run on this branch.
## 2026-11-19 · Sprint 1 · critic round 1 fixes
stock-watch + stock-watch-sheets, on `main` (afa2336, 965e965, c9a7437; not pushed, not deployed). Fixed:
- F1 (P0): a blank *Stock before* read as 0. Now = previous row's *Stock now* (engine `episodes`, `onOrderNow`; Sheet `episodes`); first row still 0. CSV with no before column, 10/0 ×3: outs 1 → 3, Still out 0 → 1. Shopify variant reactivated at 0 opens a stock-out. 30 → 27 after a PO no longer counts 27 received. Kept a present *Stock before* (always using the previous row broke the on-order fixture, which skips rows). LOGIC §2, §6b; 3 tests.
- X1 (P1): Sheet `SW.rate` now `SW.demandRate` (window → latest in-stock days within 120 d → before-out), price from the same lines. SW-003 case (5/day ₹1,000, out 30 d): Sheet Rs 0 / off Reorder → Out now, 200, ≈ ₹1.5 L, same as web. Parity fixtures 6 → 8 (out last 30 d; 3 in-stock days). Sheets LOGIC/AGENTS.
- S1 (P1): chip colour = engine `trendCall` (10+ points vs median trend; vs 0 when < 5 trends); *Selling faster/slower* filters use it; Typical-product toolbar chip removed, value in the Trend header and chip tooltips. 1440 Reorder All: red 32/45 → 15/44. Kept the raw % as chip text (finding suggested tooltip only) so the number a manager sees is the product's own; arrows dropped since a green −20% with ▲ read wrong. LOGIC §7d; test.
- S2 (P1): per-row *Mark ordered* / *Edit order* / *Undo* buttons and the act column removed; tick + bulk bar (*Mark 1 ordered*), drawer for edit/remove. 1280: Best seller tags clipped 16/41 → 6/41 (Reorder), 7/40 → 5/40 (Products). LOGIC §6b, AGENTS.
- SEC-1 (P1): global cap (100/15 min) no longer hard-blocks: password still checked, right one passes, wrong one 429. Per-IP block unchanged. Test: 100 global fails, then Basic 200 + form 303, wrong 429. SECURITY.md, AGENTS.
- QA-1 (P1): `POST /api/demo` 409 while source is `live`; button hidden there, confirm before reload elsewhere. Allowed again after Clear. Test. SECURITY.md.
- Mobile M1–M9: ⋯/Columns menu spans the toolbar (360: R 381/473 → 350, sw 360); Reorder cards get a 44×44 tick (no drawer on tap), bulk bar works per card; 44 px targets (bar/Moving rows 44, All 48×45, Undo 60×45, fold summary 45, range/sync 44, top 56); fields 16 px (no iOS zoom); Columns desktop-only, ⋯ on the chips row (390 first card y 357 → 307); no status pill on Order today/This week cards (late/on-order tag kept); Moving rows drop the spark; toast bottom 770 < bar 782; Back closes the drawer and stays on the page, drawer `overscroll-behavior: contain`.
- Checked: headless Chrome, sideways scroll 0 at 360/390/1280/1440/1920 on all 5 pages, no console errors. `npm test` 112/112.
Skipped: none. Open: 6/41 Best seller tags still clipped at 1280 (name cell max 230 px, pre-existing); the shared Dev Log page row not added (publishing left to the integrator); critics not re-run on these fixes.

## 2026-11-19 · Sprint 1 · A-engine
stock-watch engine (branch `sprint1/A-engine`):
- SW-001 (d93edff): `minMax()` loop replaces every `Math.min/max(...arr)` in engine.js (threw past ~120k rows → Report, drawer, CSV 500). 300k order lines + 200k stock rows: report ~0.4 s, no NaN/Infinity. Guard test fails if a spread returns to `src/`.
- SW-003 (1504ce5): under 7 in-stock days in the 28-day window, the rate uses the latest 28 in-stock days within 120 days; if none, the 28 days before the stock-out. Rows carry `rateBasis` / `rateFrom`. 5/day at ₹1,000 out 30 days → Out now, order 200, lost ≈ ₹1.5 L. Demo (30 d): 5 products Slow seller → Out now; lost ₹9.77 L → ₹12.29 L. LOGIC.md §3/§9/§11, ADR-0005.
- SW-031 (61637d1): ABC ranked on ₹ demand a day (rate × avg price, demand window), not ₹ sold in the period. ABC, status, order qty and value now identical at 7/30/60 d; an out-of-stock best seller stays A. LOGIC.md §7/§7a.
- Open: `public/app.js` best-seller tooltip still says "top 80% of sales"; drawer could show `rateBasis` ("rate from earlier sales"); module AGENTS.md/CHANGELOG not touched (outside this stream's files); five critics not yet run on the diff.

## 2026-11-19 · Sprint 1 · B-data
stock-watch, branch `sprint1/B-data` (not merged, not deployed):
- SW-004 (a8d9147): only a missing store.json starts blank; a bad one is copied to `.corrupt-<ts>`, `.bak` (previous good save) used, else exit 1 with nothing written. fsync before rename; failed saves retried 5 s / 30 s / 2 min, `/health` 503 meanwhile. SIGTERM/SIGINT: stop timers, wait ≤ 25 s for a pull, save, exit. Dockerfile runs under tini; `railway.json` sets `healthcheckPath: /health`. New `test/store.test.js`.
- SW-007 (67e2345): first real row clears the demo; `everLive` persisted, so demo never reloads at boot on a store that held real data.
- SW-006 (e1da9e0): rows carry `src`; with Shopify connected, `/ingest/*`, `/api/sync`, `/api/import` → 409 and Sheet sync skips; clear/import → 409 during a pull. ADR-0009 accepted.
- SW-002 (54933ca): `db.catalog` from every stock pull (stock now, price, cost, type, tags, status); engine reads stock/attributes from it; prune keeps newest row per variant + opening row of open stock-outs; archived/draft/untracked/deleted variants out of reorder + overstock, open stock-outs end when they went inactive; Data page "Excluded: N archived/draft, X pcs". Demo report unchanged. ADR-0010 accepted.
- SW-019 (963233f): unauthed `/status` (503 when last pull > 45 min old or saves fail; size + row counts per ADR-0003); `/api/report.freshness` for the banner.
- Open: banner UI (stream E); uptime monitor on `/status` (ops); Railway volume backups (SW-005); `/api/import` `replaceDemo` checkbox in the UI is now a no-op (store clears demo itself); five critics not run on this branch yet; shared dev log page row not added.

## 2026-11-19 · Sprint 1 · C-security
stock-watch, branch `sprint1/C-security` (commits c57e775, b8802b4, 7a9f505, a28b1a6, fe783fb, 86a7f96):
- SW-010 CSV import: header row required for CSV/Sheet (missing Time / Variant ID / Stock now / Qty → 400 naming them); exact names beat aliases; `variant` no longer a Variant ID alias, `collection` no longer a type; `₹1,299` / commas / spaces parse; blank stock skips; day-first dates only (US 11/15/2026 refused), date-only = 00:00 store time (uses the Time zone setting, was fixed IST); bad/future time skipped (Flow only stamps now); `;` files read; skip reasons {badTime, badNumber, noId, tooOld} in response + toast. LOGIC.md §1a.
- SW-017: `= + - @ tab CR` text cells get a leading `'` in reorder.csv and the Products CSV.
- SW-008: one limiter (form + Basic; 10/IP, 100 global per 15 min; IP = last XFF hop; map swept, ≤ 10k); `:` in passwords; prod refuses to start without a ≥ 12-char `ADMIN_PASSWORD`; cookies signed with `DATA_DIR/secret` (600) + password fingerprint; logout is POST.
- SW-009: Flow setup shows URL + `X-Ingest-Key` header (masked, Show/Copy, last rotation time); `?key=` still accepted, logged as deprecated hourly without the key; > 500 rows → 413.
- SW-016: CSP, nosniff, Referrer-Policy, X-Frame-Options, HSTS on https; cross-site writes to /api, /login, /logout → 403.
- SW-018: bad JSON / null / bad URI → 400; settings body ≤ 64 KB; HMAC-based constant-time compare; static path check uses `PUBLIC + path.sep`.
- Tests: 28 → 46 (`test/rows.test.js`, new `test/server.test.js`). UI checked in headless Chromium at 1440 and 390 (no CSP errors, no sideways scroll, POST sign-out works); 1280/1920 screenshots and the five critics not run yet.
- Open: Railway `ADMIN_PASSWORD` must be ≥ 12 chars before deploying this. Origin check trusts `X-Forwarded-Host`/`Host` when the browser sends no Sec-Fetch-Site; confirm on Railway after deploy. SECURITY.md (SW-015) should list `DATA_DIR/secret` and the ingest key rotation. Dev log page row not added (no deploy).

## 2026-11-19 · Sprint 1 · D-ops-qa
Branch `sprint1/D-ops-qa`. Not deployed, not pushed.
- **SW-013 (1f15a3a)** stock-watch-sheets: ₹ lost clipped to max(start, now − 30 d) on Lost sales + Reorder tabs (repro: 40-day stock-out ending 10 d ago, Sheet ₹2,00,000 vs web ₹1,00,000; now equal). Maths in pure `SW.compute()`; launch window and no-sales rule aligned; Daily includes the partial first day. `test/parity.test.js`: 6 fixtures through both, same status + qty, ₹ lost ±2%, `ALLOW` = best seller below slow cutoff (Sheet has no ABC). Sheet LOGIC.md is the single list of differences. Brands on old copies need the new .gs pasted.
- **SW-005 (313cae3)** stock-watch: `src/backup.js` daily `backups/store-YYYYMMDD.json` + snapshot before every replaceAll, 14 each; restore via `/data/restore.json` + restart; authed `GET /api/export/backup.json`. `docs/RUNBOOK.md`. Restore drill (local, port 4804): imported 25 stock rows + 300 order lines (live, sold ₹1,49,700) → Clear (0/0, `before-clear` snapshot written) → stop → `cp backups/…-before-clear.json restore.json` → start → 25/300, sold ₹1,49,700, previous store kept as `before-restore`. Open: Railway volume backups (daily, keep ≥ 7) must be switched on by the owner in the dashboard; not done (no Railway access in this stream).
- **SW-014 (e037930)** CI: `.github/workflows/test.yml` runs `npm test` on Node 20 + 22, push and PR. `npm test` script → `node --test test/*.test.js` (old `test/` arg failed on Node 22, the Docker version). Playwright smoke `test/smoke/smoke.js` (on demand): 16/20 today; Reset and Save fail at 1440 + 390 (SW-011 bug), 20/20 with that bug patched locally. Open: `server.test.js`, `store.test.js`, `rows.test.js`, `engine-edge.test.js` left to the streams changing those files (SW-004/6/7/8/10, SW-001-003).
- **SW-015 (9921451)** docs: LOGIC §11 split by source, §12 → Sheet LOGIC.md; ORCA.md five critics, one fence each, `git diff $BASE..HEAD -- <role paths>`; real deploy (`railway up`, manual) in AGENTS.md + ORCA.md; `SECURITY.md`; `test/docs.test.js` fails on an unclosed fence (caught ORCA.md:60).
- Tests: 28 → 44, green on Node 20, 22, 26.

## 2026-11-19 · Sprint 1 · E-ui
Module stock-watch, branch `sprint1/E-ui`.
- SW-011: plan bar Save as default / Reset moved out of `<summary>` (they were dead). Playwright 1440: lead 10 → Reset → headline back (₹33.20 L / 74); lead 10 → Save → reload keeps 10. (2805329)
- SW-012: "Mark ordered". New `src/onorder.js` (`DATA_DIR/onorder.json`, `GET/POST /api/onorder`), engine `opts.onOrder`: units still to come count while not past ETA and landing before the shelf empties or by today + lead (+1 day). Covered → status "Ordered · lands 26 Nov", off Order today; too little → only the extra; past ETA → back in Order today with a red "Late" tag. Row button (Undo in toast), tick boxes + "Mark N ordered", Ordered tab, drawer form. LOGIC.md §6b, `test/onorder.test.js` (9). Demo: 4 marked → Order today 74 → 70, ₹33.20 L → ₹31.44 L. (84d78bd)
- SW-021: trend in the decision rows (Trend cell ≥ 1400 px, inline spark below, phone header), dated hover labels, baseline in Products toolbar, 8 weekly numbers in the drawer, Overview "Moving" by ₹ effect (rate change × avg price × 30). LOGIC.md §7d/§9, `test/trend.test.js`. (d0968d3)
- SW-019 (UI only): red "Data is X h old" banner when the Shopify pull is > 45 min old; reads `/status` if present, else the report. (1567912)
- Open: SW-021 group rows wait for SW-022; Playwright checks ran from a scratch script (repo smoke is SW-014); five-critic pass and shared dev log page row not done by this stream.

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
