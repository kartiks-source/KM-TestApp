# Dev log

Newest first. Date · module · what changed and why · anything open.
Shared copy for the team: https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq

## 2026-11-20 · Sprint 3 · A-money
stock-watch, branch `sprint3/A-money` (not merged, not deployed). SW-040 + SW-041, ADR-0016.
- SW-040 suppliers: `suppliers.json` per store (side file, in backups/restore), `src/supplier-rules.js` (pure) + `src/suppliers.js` (store + routes `/api/suppliers`, `/map`, `/import`, `/api/export/suppliers.csv`; writes admin + same-site, logged). Engine: supplier lead time replaces the store's; qty up to MOQ then case pack, `packExtra` / `packExtraValue` (LOGIC §6c). Demo: invented vendors by product type + terms (demo VERSION sammsara-7). Reorder CSV `?supplier=` = one PO draft.
- SW-041 budget: `src/budget.js` profit kept per ₹ on reorder rows, one cut line (LOGIC §6d, worked example); CSV `?budget=`.
- UI (`public/money.js`, own script tag; small hooks in app.js): Reorder bar = Budget ₹ (per store, this browser) + List / By supplier + round-up ₹; cut line row, rows over budget dimmed, *Profit kept / ₹* column while a budget is on; By supplier = PO per supplier (terms, lines, pcs, ₹, Copy text, CSV); Data → Suppliers (terms, add supplier, set a SKU's supplier, CSV in/out). Mark ordered lands at today + the supplier's lead time.
- Tests: `suppliers.test.js` (rules, store, routes incl. view 403 + cross-site 403), `budget.test.js` (rule, worked example, cut, `?budget=` route), `ui-money.test.js` (1440 + 390: cut line, dimmed rows, CSV link, Clear = same rows, PO drafts, 44 px targets, Data → Suppliers, no sideways scroll).
- Checked: `npm test` green; ui-money 4/4 with Chrome. Open: `test/ui-money.test.js` to add to root `test:ui` (left out to avoid a package.json merge clash); budget not shared across the team.

## 2026-11-20 · final critic round 2 fixes
stock-watch 1.0.0-rc.1, on `main` (0e1b893 L1, 15e2897 X1, UI + mobile commit, this entry; not pushed, not deployed).
- L1 (P1): `planWithOrder` keeps the row's own status unless the PO covers the need (Ordered): 5/day, 10 in stock, 50 on order stayed Critical (was This week, off Order today). LOGIC §6b; onorder.test (fails on the old code).
- X1 (P1): `.railway/railway.ts` `preserve()` for every variable in `.env.example` / SECURITY.md (omit=delete would have wiped the Performity key/URL, webhooks on apply); RUNBOOK: read the plan for variable deletions. docs.test checks the list. Not run: `railway config plan` (no SDK here).
- UI-1 / SIMP-A (P1): daily chart drawn at the box's real width (`fitChart`, on render + resize), 200 px tall, unscaled 12.5 px labels: Overview ends at 864 px at 1280/1440/1920 × 900. 1280×800 (all roles): chart panel ends at 841, its title and most of the bars above the fold (SIMP-A's no-scroll at 800 would need a ~110 px chart; not done).
- UI-2 (P1): `.tr.up`/`.mv-v.up` #15803D (5.0:1), `--ok` #0B7A71 (4.65:1 on ok-soft), `#n-stockouts` #6B7385 (4.76:1).
- SIMP-B (P1): Stock-outs h1 "N still out, costing ₹X/day" on desktop too; sub-line "… sales lost · ₹ profit lost". LOGIC §still-out.
- Phones (≤760 only, desktop untouched): M1 chips snap to whole chips; the active chip's least scroll is rounded up to a chip start (end padding when it's the last), fade only on a side with more chips (`chipEdges`, first 6 px of the left fade clear); supersedes round-1 M3 "least scroll" (test updated). M2 toast above the bulk bar. M3 sticky ×. M4 `.mq small` 12.5 px, order cost 600. M5 Products cards (sorted by ₹ lost: not Pause/Push/Slow, no other sort) put ₹ lost top-right, status in the facts. M6 `.chart text` 12.5 px, daily chart unscaled, R 22 and phone ticks counted back from today (last date was cut). M7 role ellipsis, "N stores" hidden with a role. M8 Plan settings one line; `.msort` moved beside Search (`.tq`, Reorder + Stock-outs; select gets `aria-label`): first card y 343 at 360 (was ~403). M9 panel link and ⋯ 44 px wide.
- Tests: ui-helpers +2 (desktop UI-1/UI-2/SIMP-B at 1280/1440/1920; phones M1–M6, M8, M9 at 390 + 360), ui-stores +1 (M7); 4 fail on the old public/ code.
- Checked: `npm test` 257 pass / 23 skip (283/283 with Playwright); `test:ui` 26/26; `test:smoke` 30/30 + roles all pass (`PLAYWRIGHT_CHANNEL=chrome`).
- Not done: Drawer charts (Stock level, Units sold) still scale with their viewBox (~11.2 px labels at 360); Products keeps Sort on its own row (its Search shares the View row). Open: shared dev log page row not added; critics not re-run.

## 2026-11-20 · release 1.0.0
stock-watch 1.0.0 (tag `v1.0.0`), deployed to the new Railway project (Limitless Pixel, Singapore).
- Final review: 6 critics × 2 rounds (wf finish-all-sprints), fixes 0e1b893, 15e2897, 2be1cf0, 4a5e9d6. Checked: `npm test` 257 pass, `test:ui` 26/26, smoke + roles smoke all pass (1280/1440/1920/390/360, 0px sideways).
- Old Railway service on the shivam account deleted by the user (URL 404). BACKLOG: SW-016 closed (CI runs the smoke); SW-005 left open only for Railway volume backups (dashboard).
- Next: Sprint 3 (SW-040..062 doable items); real brands when Performity moves us to production.

## 2026-11-20 · Performity connected (Origin header)
stock-watch, `main`. KD sent the real base URL (Azure App Service, dev API); Railway var updated by the user.
- Live calls gave `403 Origin not allowed`: Performity allows our key only from the domain we gave them, checked on `Origin` (not in the calling guide). `keys.pocCall` now sends `Origin: https://$RAILWAY_PUBLIC_DOMAIN` (or `PERFORMITY_ORIGIN`); clear error for that 403. Tests: 2 new (default/override/none; error text).
- Checked by hand (key and token never printed): brands → 1 (TATA Motors); fresh-token → 200, `new-test-store-glcl79bh.myshopify.com`, expiry ~1 h; read-only Shopify query → New Test Store, INR, Asia/Kolkata, 22 products, 11 orders. No IP allow-list hit, so no static IP needed yet.
- Open: compare a pull against Shopify admin; Performity's prod base URL when they move off dev; static IP only if they enable `EXTERNAL_POC_ALLOWED_IPS`.

## 2026-11-20 · final critic round 1 fixes
stock-watch 1.0.0-rc.1, on `main` (ae2c6cd L1; the UI code landed inside 56f79b3, a concurrent Performity-Origin commit that staged the whole tree; this entry in its own commit; not pushed, not deployed).
- L1 (P1): catalog keeps `spells: [{from,to,status}]` when a variant turns active again (max 20, pruned 120 d after `to`); engine `cutBySpells` ends a stock-out at a spell's start and reopens it at its end if still 0; spell days are not in-stock days for the rate (`unsellable`); `period.catalogAsOf` passes spells. Repro (draft while out, reactivate on restock): ₹ lost and the 10 Nov bar stay put. LOGIC §1/§2/§3/§17, FORMATS, AGENTS. Tests: store.test.js (2).
- UI-1 `.range button:focus-visible{outline-offset:-2px}`. UI-2 Back in stock `nw` (Pause rows 34 px at 1280–1920). UI-3 table Why drops "· supplier takes N d" (tooltip keeps it), `.why` 260 px ≤1440: In stock back at 1280, Sells/day at 1440.
- SIMP-1: headline "Order ₹X today · ₹Y sales lost …"; tile 1 = profit lost · % of demand (no cost: % of demand lost · stock-outs), tile 2 = more to order this week (opens This week). Role hide keys unchanged. SIMP-2: Reorder All headline "· ₹Z more this week (M)" (today + week = orderValueAll = list); CSV / Tick all unchanged (they match the stated scope).
- Phones: M1 store bar always a menu (one store too): role name + role list `#role-menu-m` (`SW_ROLES.paint`), view-only can switch; M2 Pause card header wraps (`.bk` pill under the name); M3 chips scroll the least; M4 `.mcard h3{flex:1 1 auto}`; M5 closed fold = summary; M6 7d/14d/30d/60d (aria-label full), min-width 44; M7 12 / 11.5 px; M8 phone stock chart R 24; M9 login 16 px + 44 px ≤760; M10 Sort by nowrap (+ select `min-width:0`: smoke caught 3 px sideways at 360). Desktop untouched by M fixes.
- Tests: ui-helpers +3 (desktop UI-1..3; SIMP-1/2 sums; phones M1–M8, M10 at 390 + 360, M3 and M8 checked to fail on the old code), ui-stores one-store test now expects the role menu, server.test login CSS (M9).
- Not done: M3 when the active chip is the last one (All) the row still ends cut on the left: that is already the least scroll; no fade mask added (would also fade the first chip's edge). Critic SIMP-1 alt (drop tiles) rejected: role views and RACI hang on 4 tile slots.
- Checked: `npm test` 255 pass / 23 skip (browser); `test:ui` 23/23; `test:smoke` 30/30 + roles all pass (`PLAYWRIGHT_CHANNEL=chrome`).
- Open: shared dev log page row not added; critics not re-run on these fixes.

## 2026-11-20 · finish sprints · last gaps
stock-watch 1.0.0-rc.1, on `main` (cdcf303 + this entry; not pushed, not deployed).
- SW-056: `src/version.js`; `/health`, `/status`, `/api/report` `app`, footer `v1.0.0-rc.1 · <sha>` (`dev` unstamped). SHA from `RAILWAY_GIT_COMMIT_SHA`, `BUILD_SHA` env, or `BUILD_SHA` file (`npm run stamp` before `railway up`, then delete; not gitignored because `railway up` skips ignored files). Dockerfile copies it (glob next to package.json). Hex only.
- SW-047: `store.json` `schemaVersion: 1` on every save; `MIGRATIONS` (0 → 1 = add key); newer file → refuse to start, untouched; newer `restore.json` rejected.
- SW-021: `groups.js` `weeks` (summed units, avg out-days ≥ 0.1 when any variant out, `outProducts`); group Trend cell = spark + chip; phone group card spark.
- SW-007: `store.endDemo()` clears demo rows, catalog, Mark ordered, decisions; used by `goLive` (Flow, Sheet, CSV, Shopify orders) and `pullOne`. Import checkbox + CSS + smoke step removed.
- SW-029: digest PUT → change log `digest.hour/roles/paused` (who = role); env webhook host change → `digest.webhook` by `server (env)`, once, hosts only. Change log refreshes in place after digest save.
- Tests: version (4), store schema (4) + demo→live per path (3), backup newer-schema, digest log (2 + route), groups spark (2), ui-helpers 390+360 loops, group sparks 1280/1440/1920/390/360, footer + no checkbox; docs: CHANGELOG top = package version.
- Checked: `npm test` 250 pass / 20 skip (browser); `test:ui` 20/20 (`PLAYWRIGHT_CHANNEL=chrome`); `test:smoke` 30/30 + roles all pass.
- Open: five critics not run on this cycle; shared dev log page row not added; git tag `v1.0.0-rc.1` at deploy (SW-056); Dockerfile `BUILD_SHA*` glob not built locally (no docker here). Group rose mark shows under most weeks for big groups (LOGIC §9a limit).

## 2026-11-20 · multi-store critic round
stock-watch, branch `feature/multistore` (92e6c02, a32cf51, 82ebbfe + this entry; not pushed, not deployed).
- ISO-1 (P1): migration is once per `DATA_DIR` (a marker in any `stores/<id>/` = done for good) and goes to the store `SHOPIFY_STORE` / `PERFORMITY_BRAND_ID` names, else the first (`stores.home()`). A later top-level `restore.json` or a store-list change no longer moves files into another store or crash-loops the start.
- SEC-1 (P1): `stores.refresh()` and `keys.pocCall()` make no call unless `keys.status().ready` (https or localhost URL, key set): the brand list had sent `X-Api-Key` over plain http / empty.
- UI-1..UI-6: dot classes `s-*` (`.stale` banner clash); menu `max-height` + scroll; ellipsis on long names + pill title; range never shrinks, role name one line; phone store bar for one store, drawer names the store; picker re-reads `/api/stores` every minute. Smoke: sign-in waits for the first page (pre-existing flake: goto aborted its report call).
- Checked: `npm test` 233 pass / 13 skip; `test:ui` 18/18; `smoke.js` 30/30 ×3; `roles-smoke.js` all pass.

## 2026-11-20 · multi-store + show everything by default
stock-watch, branch `feature/multistore` (5ce0981, 6d5454d, e8f6fba merge of main, e6714bc, 0c27383, d3bfab1 + this entry; not pushed, not deployed). Resumed after the first builder was killed mid-UI.
- Kept from the killed run: server side (ADR-0015: registry, `scope.run`, per-store folders, crash-safe migration, `?store=` + `sw_store` cookie, 404 on bad ids, one pull queue, per-store alerts/digest/CSV names, `/status` totals) and the half-done UI (`public/stores.js`, app.js store calls). Fixed in it: a comment had swallowed `state.q` (every page threw on load); ARIA `menuitemradio` without a menu → plain buttons with `aria-current`; picker / store bar / dot CSS was missing; duplicate doc comment in `server.js` freshness.
- Store picker: pill menu with ok / stale / error dot + one status line per store, phone store bar (44 px) under the top bar, keyboard (Enter, arrows, Esc back to the pill), `?store=` + localStorage `sw-store` + cookie, reload on the same page; one store = plain name. Test `test/ui-stores.test.js` (in `test:ui`).
- Show everything by default (ADR-0006 amended): role All default, Reorder opens on All, optional columns on (`sw-cols-off` remembers unticks), the right-most optional columns step aside with a note when they don't fit (never a sideways scroll 1280–1920), every Overview panel. `ui-helpers` tests updated (Reorder default tab, columns test rewritten); `roles.test.js` ALL.
- Docs: LOGIC §9 table fit, §16 default, §18 picker; README; module AGENTS (files, status); API, FORMATS (browser keys), SECURITY (`sw_store` row), RUNBOOK (picker, local two-store check); CHANGELOG 0.10.0; BACKLOG SW-062 (per-store access).
- Checked: `npm test` 230 pass / 13 skip (browser); `test:ui` 13/13 (Playwright 1.65.1 from npx cache, `PLAYWRIGHT_CHANNEL=chrome`); `smoke.js` 30/30; `roles-smoke.js` all pass at 5 widths. Stand-in API with `STAND_IN_BRANDS=2`: two uuid stores, red dots with the reason ("no connected Shopify store"). Screenshots of the picker at 1440 and 390 (demo and stand-in) kept outside the repo.
- Open: five critics not run on this branch; shared dev log page row not added from this worktree; merge to `main` after critics. On Railway the first start moves today's demo data into `sammsara-demo`.

## 2026-11-20 · ops · Railway on the new account, as code
- Project `stock-watch` on the Limitless Pixel account (`web-production-d8d7a911.up.railway.app`). `.railway/railway.ts` replaces `railway.json` (Config as Code is retired on 1 Dec 2026): Singapore region, 1 replica, health check `/health`, volume `/data`; secrets `preserve()`d. Region moved from sfo with the volume (data kept). Static outbound IPs wait for the Pro plan.

## 2026-11-20 · finish sprints · W4-ci
stock-watch, branch `finish/W4-ci` (ede2ef7, 5ceb950, bbebac2; not pushed, not deployed). Closes SW-014 (browser tests never ran in CI) and the CI half of SW-023 (360×740, screenshots kept).
- Root `package.json`: devDependency `playwright` pinned to 1.65.1 + `package-lock.json` (dev tooling only; the Dockerfile copies `modules/stock-watch`, so the deployed app stays dependency-free). Scripts `test:ui` (fails instead of silently skipping when Playwright is missing) and `test:smoke` (smoke + roles smoke).
- `.github/workflows/test.yml`: job `test` unchanged (npm test, Node 20 + 22). New job `ui` (Node 22): `npm ci`, Chromium cached by lockfile hash (`playwright install --with-deps chromium`, or `install-deps` on a cache hit), then the 6 browser tests, `smoke.js` and `roles-smoke.js`; screenshots uploaded as artifact `screenshots` (14 days), also on failure.
- `test/smoke/smoke.js`: 360×740 next to 390×844 (viewports `desktop`, `phone390`, `phone360`); `SMOKE_OUT` created if missing. `roles-smoke.js`: 360×740 added (44 px period-button check runs there too), refuses a busy port, fails if the app never starts.
- Local (Playwright 1.65.1 from npx cache, `PLAYWRIGHT_CHANNEL=chrome` for test:ui): npm test 199 pass / 6 skip; test:ui 6/6; smoke 30/30; roles smoke all passed at 5 widths.
- Open: CI run itself not seen (never pushed). Docs that still say "CI has no browser" (`modules/stock-watch/AGENTS.md` test rows, RUNBOOK/ORCA if any) belong to the docs owner. Shared dev log page row not added from this worktree.



## 2026-11-20 · finish sprints · W1-docs
stock-watch + stock-watch-sheets docs, branch `finish/W1-docs` (c20b56a, 7a1fb2f, 1206843, d2a9561, 64e60e0, c33758d, b1987e0, 49d650e; not pushed, not deployed). Docs only, no code changed. `npm test` 199 pass, 6 skip (browser), 0 fail.
- SW-015: `SECURITY.md` adds `PERFORMITY_POC_API_URL/KEY/BRAND_ID`, `ALERT_WEBHOOK_URL`, `DIGEST_WEBHOOK_URL[_<ROLE>]`, `VIEW_PASSWORD`, `DATA_DIR/secret`; auth model brought up to SW-008/016/018; write routes `/api/onorder`, `/api/decide`, `/api/digest/settings`, `/api/digest/send` in the destructive table; Clear also wipes Mark ordered + decisions. Dropped `?replaceDemo=1` (server never reads it; the store clears demo itself).
- DoD files: `modules/stock-watch/CHANGELOG.md` (0.1.0–0.9.0 rebuilt from this log) + `package.json` 0.9.0 (pre-production); `API.md` (every route: auth, params, answer, errors); `FORMATS.md` (stock/order columns + aliases, Flow templates + JSON keys, PO/Pause/Push CSV columns, `store.json` and sidecar shapes, schema 1); `.env.example` lists every variable the code reads; `modules/stock-watch-sheets/README.md`.
- SW-019 / SW-005: `docs/RUNBOOK.md` uptime monitor on `/health` + `/status` (UptimeRobot / Better Stack), monthly Railway volume backup check, which sidecar files a restore needs (`onorder.json`, `decisions.json` yes; `catalog.json`, `secret` no) and a hand copy until W2 backs them up.
- `docs/BACKLOG.md`: a Status line per Sprint 1/2 item. SW-012 AC amended to tick + bulk bar, SW-021 to baseline in the Trend header/tooltip, both accepted departures; SW-020 (no first-open picker) and SW-005 (repo-level RUNBOOK) noted as departures too.
- Open: `store.json` has no `schemaVersion` (SW-047); `/status` shows no version (SW-056); onorder/decisions not in app backups (W2); Playwright smoke not in CI and no 360×740 / kept screenshots (SW-014, SW-023); uptime monitor and volume backups not yet set up by the owner; module `AGENTS.md` files table and root `AGENTS.md` layout don't list the new docs yet (outside this stream's files); shared dev log page row not added (no publishing from this step).

## 2026-11-20 · critic round 2 fixes
stock-watch, on `main` (not pushed, not deployed). Verified P1 findings from critic round 2 (`Stock-Watch-r2-findings.json`), each checked against the code first.
Fixed:
- L1: CEO digest "vs the 7 days before" counted lost sales on a variant archived while out. The past report now gets the catalog's inactive flags from before then (`period.catalogAsOf`, `server.js` digestCtx); no stock or price. LOGIC §17; test in `test/digest.test.js`.
- L2: ABC rank included inactive rows, so A count, best sellers at risk and order value moved with the period. Inactive rows are C and left out of the rank (`src/engine.js`). LOGIC §7a, §5a; engine test (7 / 30 / 60 / This month with 15 archived sellers).
- S1 (PO CSV 500): a variant ID `constructor` / `toString` / … read Object.prototype, so `vOf` returned a function and the CSV threw. Own-key lookups for vendors (`Object.create(null)` + `Object.hasOwn`), decisions, on-order, catalog, groups and `setCatalog` tombstones (`src/helpers.js`, `engine.js`, `store.js`, `groups.js`). Test: ingest 5 such IDs, every CSV tab + report + groups 200.
- UI-3: group-lens Trend was always grey and its tooltip contradicted the sign. `groups.build` now sets `trendCall` with the §7d rule against the typical product (`storeTrend(rows)`, same baseline as Products) and returns `storeTrendPct`; `trendChip` falls back to a sign-only verdict when a row has no call. Demo Categories at 1440: up / down / flat all used, 0 of 21 chips disagree with their sign. LOGIC §9a Trend row; test in `test/groups.test.js`.
- S1 (filters): More… had Overstock (= Push these) and Slow sellers (= Slow sellers to decide). Both duplicates gone: More… 8 → 6 options (Sprint 1 size); *Slow sellers to decide* carries the Decide column; the Overview overstock tile opens Push these; old `over` / `decide` filters map over (`public/app.js`, `roles.js` tile selector). LOGIC §15c/§15d; browser test.
- M1: marketing's phone home said "Products" and each card led with "Order today". h1 is now "Pause promotion on N products" / "Push N overstocked products"; Pause cards show Back in stock in the badge place (extra line dropped). 390 marketing: h1 "Pause promotion on 62 products", 0 px sideways. LOGIC §15c; browser test (`role=marketing`).
- UI-1: Reorder → All at 1181–1400 cut Sales lost off (the 420 px name rule ignored the Status column). Name width is now `min(420px, 100vw − 870px)`, and `min(360px, 100vw − 925px)` when Status shows (`styles.css`). Measured 1181–1920 (11 widths) × Reorder today/week/all + Products all/pause/push: every table fits its box, 0 px page scroll. Cost: Reorder → All at 1280 cuts 20/50 names (was 5/50 with Sales lost unreachable). Browser test at 1280/1400.
- UI-2: columns added from Columns… were clipped with no way to reach them. `fitTables()` (after every render, resize, column drag) gives a table wider than its box `overflow-x: auto` + a note "More columns than fit: scroll the table sideways →"; the header's sticky top is dropped in that table only. Default columns never trigger it. LOGIC §9 tables, ADR-0006; browser test at 1280/1440 with every optional column on.
- X1: `onorder.json` / `decisions.json` were read as empty when damaged (then overwritten by the next mark) and were in no backup, export or restore. New `src/sidefile.js`: missing → empty; bad → `.corrupt-<time>` copy, `.bak` used, none → throw (server refuses to start, nothing written); writes temp + fsync + rename, previous file kept as `.bak` (never the bad one). `backup.text()` adds `sideFiles` to daily, before-clear/demo and export; `restorePending` writes them back (older backups without them leave current files alone); before-restore copy carries them. RUNBOOK Backups/Restore/symptoms, SECURITY Clear undo, LOGIC §6b/§15d, module AGENTS. 5 tests in `test/sidefile.test.js` (corrupt not overwritten, .bak fallback, boot refusal, Clear → restore brings marks + decisions back, old backup).
- X2: SECURITY.md was stale (cookie "HMAC of the password", app open without a password, Basic auth not limited, client-set XFF, "planned hardening"). Auth model rewritten to the code (secret + fingerprint cookie key, start refusals, one limiter, last XFF hop, `/status`, cross-site write check, headers, ingest header + 500 rows); "Planned hardening" line removed. Secrets table adds `DATA_DIR/secret`, `PERFORMITY_POC_API_KEY`/`TOKEN_API_KEY` (+ URL, brand), `DIGEST_WEBHOOK_URL`/`_<ROLE>`, `ALERT_WEBHOOK_URL` with rotation steps; endpoints table adds `POST /api/onorder`, `POST /api/decide`, `PUT /api/digest/settings`, `POST /api/digest/send`. Test in `test/docs.test.js` scans the code for secret-like variables and checks each, the write routes and no stale phrases.
- Checked: `npm test` 199 → 205 pass (8 browser tests pass with `PLAYWRIGHT_PATH` + `PLAYWRIGHT_CHANNEL=chrome`, 4 new); `smoke.js` 20/20; `roles-smoke.js` all pass (8 roles, 390 px, 0 px sideways).
- After merging `finish/W1-docs` (c2eb220, merged by another agent while this ran): SECURITY.md checked against the code again; dropped the `POST /api/import?replaceDemo=1` row the merge brought back (the server never reads it; the store clears demo itself). RUNBOOK side-file text from both streams agrees.
Skipped: none (all 10 still reproduced in the code at 049175d). Open: Pause cards at 390 squeeze long names beside the "Not ordered · earliest …" badge (wraps to 3–4 lines); buyer role hides the Push chip, so with Overstock gone from More… the buyer has no overstock filter (RACI: push ads –); Reorder → All at 1280 cuts 20/50 names to make room for Status; critics not re-run on these fixes; shared dev log page row not added (no publishing from this step).

## 2026-11-20 · stock-watch · Performity POC API contract
- keys.js follows Performity's calling guide: `X-Api-Key`, `GET …/external/brands`, `POST …/external/fresh-token {brand_id}`, shop from `shop_domain` (must be *.myshopify.com), `expires_at` read as UTC (no zone; `null` = no expiry). Token asked before each pull (`beginPull`), reused only within the pull, re-asked on Shopify 401; never kept between pulls (fallback removed). Wrong key → 15-min local pause (never trips the 5-wrong-keys IP block); 429 waits; 500 retried once; 403 IP/brand, 404, 409 explained in plain words. Variables `PERFORMITY_POC_API_URL`, `PERFORMITY_POC_API_KEY`, `PERFORMITY_BRAND_ID` (aliases `TOKEN_API_URL/KEY`). Stand-in API rewritten to the contract. 8 tests.
- Railway static outbound IP is disabled (Pro plan needed) — required for Performity's allow-list.
## 2026-11-19 · stock-watch · token API key source (option A decided)
- `src/keys.js` source `tokenapi` (TOKEN_API_URL / TOKEN_API_KEY / SHOPIFY_STORE): current token from the main product's API, cached until 5 min before `expires_at`, never refreshed, re-asked once on a Shopify 401, kept while the API is briefly down, plain errors (key refused / IP not allow-listed / store not allow-listed / API down).
- `src/alert.js`: ALERT_WEBHOOK_URL gets one message when pulls start failing, a reminder every 6 h, one on recovery; tokens scrubbed.
- `scripts/stand-in-token-api.js` to test against the contract before the real API exists. ADR 0014; RUNBOOK "Connect the first store". 8 new tests.
## 2026-11-19 · Final integration · critic round 1 fixes
stock-watch, on `main` (994817b, 201245a, 6c3ac35, de95d24 + this docs commit; not pushed, not deployed). Tests 184 → 187 pass (+ 4 browser tests pass with `PLAYWRIGHT_PATH` + `PLAYWRIGHT_CHANNEL=chrome`); `smoke.js` 20/20 (was 16/20), `roles-smoke.js` all pass. Fixed:
- L1 (P1): Yesterday strip blank on the 1st in This month. `period.yesterdayFor` drops the page's `from`/`days` before the 2-day fallback (`src/period.js`). LOGIC §5a; test passes `{from: monthStart}`.
- L2 (P1): empty shelf with a part-filled PO went to Order now / This week and out of "out now". `planWithOrder` keeps **Out now** at stock ≤ 0 until the PO covers the need; qty = the extra only (`src/engine.js`). LOGIC §6b; tests for PO 10/25/80 at 2/day.
- UI-1 (P1): trend chip green on a fall. `trendCall` up/down only when the product's own sign agrees (fall never green, rise never red); tooltip says "Falling, but less than the typical product". 1440 Reorder+Products: 0 sign mismatches (green 13, red 31). LOGIC §7d; trend test.
- UI-2 (P1): Reorder name cell 420 px at 1181–1400 px (`styles.css`). 1280 Reorder names cut 48/50 → 3/50, Why column still uncut (max 348 px text); 1440/1920 unchanged.
- UI-3 (P1): Overview Order today / Biggest losses / Moving rows get `tabindex=0 role=button`; Enter/Space opens the drawer, focus returns to the row.
- X1 (P1): `smoke.js` checks `SMOKE_PORT` is free (else exit 1, never drives another app), watches the child (`exit` → reject with log), `stop()` resolves when already exited, clears before reloading the demo via `page.request` (no 409 console error), fails when no check ran.
- SIMP-1 (P1) + M6 (P2): Ordered tab = every open PO (part, late, landing too late), late first; columns Lands / On order (pcs) / Days left / In stock; headline "N on order · M due this week · K late"; empty "Nothing on order. Marked orders show here until they land."; tab CSV same rows; warehouse digest "On order: N lines, X pcs to come · M due this week · K late" + first 3. Tab-driven, not role-driven (ADR-0006). `helpers.onOrderRows` / `onOrderSummary`; LOGIC §6b/§16/§17; test.
- Phone M1–M5, M7–M10 (`styles.css` ≤760 / ≤380 only, `app.js` narrow-only branches): Share menu 10..380 (390) / 10..350 (360) for all roles; bulk bar fixed above the bottom bar (390: 686..774, Mark 44 px); active chip scrolled into view after render (marketing, warehouse, stock-outs, products, More… all fully visible at 390/360); 44 px search, View select, Plan steppers (aligned), Advanced summaries, checkbox labels, panel links, brand; Pause/Push CSV moved into ⋯ (toolbar 144 → 94 px); 3-tile roles: last tile spans on phones (`roles.css`, test); Yesterday + Share on one row; cards drop an all-zero spark, no spark ≤380 px; headline money nowrap; phone Stock-outs h1 = "N still out, costing ₹X/day", history in the sub-line.
- Checked: sideways scroll 0 for 8 roles × 5 pages at 360/390/1280/1440/1920; no console errors; desktop Share menu, tables and headlines unchanged except UI-2 and the Pause/Push CSV now in ⋯ (desktop too, one place for it).
Skipped: none. Open: the Ordered tab's CSV still has PO columns (order qty 0 for covered lines), a receiving-list CSV would suit the warehouse better; shared dev log page row not added (no publishing from this step); critics not re-run on these fixes.

## 2026-11-19 · Sprint 2 · integration on main
stock-watch, on `main` (merges 6b22541 C-access, 96bbc9d D-helpers, 29f8e8e A-groups, 6908094 B-roles, then the fix commit below; not pushed, not deployed). Kept both sprints' intent; tests 112 → 184 pass (4 browser tests skip without Playwright).
- Access (SW-029) on Sprint 1 auth: `auth()` now returns the role ('admin' | 'view'); the 403 gate runs before every route, so Sprint 1 writes (Mark ordered, settings, import, clear, demo, pulls) and Sprint 2 writes (`/api/decide`, digest settings and send) are refused for view sessions; `GET /api/export/backup.json` is admin-only. Viewers get no Mark-ordered ticks, bulk bar or drawer form, no Decide buttons; Sign out is a POST form. `ingestKeyAt` isn't logged as a separate change. SECURITY.md has the `VIEW_PASSWORD` row.
- One set of report options (`reportOpts()` in server.js): report, groups, product drawer, PO CSV and the digest's today report use the same period (days or "This month"), trial values, SW-002 catalog snapshot and Mark-ordered records. `/api/groups` totals now equal report totals (new test in `test/groups-api.test.js`: a marked order leaves Need order as it leaves Order today).
- Group-by catalog: variants come from the store snapshot (SW-002), not a second copy in `catalog.json` (collections still cached there); the `onVariants` pull hook is gone; vendor is stored in the snapshot (SW-025 vendors).
- Roles (SW-020) now cover Sprint 1/2 UI per RACI: Mark ordered only for founder, buyer, ops; warehouse lands on Reorder → Ordered (tab shown even when empty); marketing on Products → Pause promotion; Pause/Push chips off for buyer (both) and finance (Pause); one hidden Overview list leaves list + Moving side by side.
- Digest uses the page's own rules: Pause list = `helpers.mktList`/`mktSort` (§15c), still-out ₹/day = Stock-outs headline (§15a). Rule change from the B branch (sellers only, by ₹ sold).
- LOGIC sections renumbered after the merge: §13 access, §14 sync runs (C), §15 decision helpers (D), §16 role views, §17 digest (B).
- Fixes found by tests/UI: `decide.clear()` wrote on start-up and crashed a read-only DATA_DIR; Ordered tab showed "Ordered · lands" twice (Status column now only on All, as §15a says); test stubs/fixtures updated (runs stub has `catalog`, ui-helpers zero-lost drop check depends on the demo draw, smoke `ready()` waits for the headline).
- Checked on 5010 at 1280/1440/1920/390×844, admin and view-only: every page, Reorder tabs, Products Pause/Push/Decide/Overstock, all 4 lenses + opened group, 7 roles + default, periods incl. This month, drawer: 372 checks each, 0 JS errors, 0 px sideways. `roles-smoke.js` and `ui-helpers.test.js` pass.
- Open: `test/smoke/smoke.js` fails 5/20 (phone Reset/Save/drawer selectors, a 409 console line) on pre-merge main too, so not from this merge; five critics not run on the merged result; shared dev log page row not added (no publishing from this step).

## 2026-11-19 · Sprint 2 · B-roles
stock-watch, branch `sprint2/B-roles` (base 995369f; not merged, not deployed). Commits: 4ef2150 SW-027, 261619e SW-020, 7f88c26 SW-028.
- SW-027: one line under the Overview headline, "Yesterday: ₹X sold · ₹Y lost · N ran out · M back" (yesterday's store-time day, same numbers as its chart bar), and "This month" in the period picker (from the 1st, store time; "Month" on phones). New `src/period.js`; engine takes `opts.from`. LOGIC.md §5a, `test/period.test.js`.
- SW-020: role home views that only remove UI (ADR-0006): 7 RACI roles in `public/roles.js`, each lands on its page/tab and hides menu items, tiles, lists, chart, plan bar or columns. Picked from the store menu (desktop), Data → Show me (phone) or `/?role=ceo`; remembered per browser; no role = today's view. Data is never hidden (switch back). LOGIC.md §13, `test/roles.test.js`, `test/smoke/roles-smoke.js` (every role shows fewer pieces than the default on its home page at 1280/1440/1920/390; no sideways scroll).
- SW-028: morning digest per role (≤ 6 lines + link): `src/digest.js` (text), `src/digest-service.js` (`GET /api/digest?role=`, `/api/digest.txt`, settings, send now, schedule at a store-time hour after a fresh pull, weekly roles Mondays, every send logged). Overview "Copy summary" became a Share menu (copy summary / copy digest / WhatsApp `wa.me` link); Data → Morning digest (webhook URL, hour, roles, pause, last sends). Webhook URL never shown back (host only); `DIGEST_WEBHOOK_URL` overrides. No email provider, no deps. LOGIC.md §14, `test/digest.test.js`.
- app.js touched in small hooks only (showCol, start, Show me field, Share menu, digest panel, period wording); new code in new files.
- Review fixes: role links with `#<home>` (every digest link) now apply the role's tab (marketing → Products → Order today; was All); webhook URLs env only (`DIGEST_WEBHOOK_URL`, per-role `DIGEST_WEBHOOK_URL_<ROLE>`), never saved from the page or kept in store.json; digest catch-up wraps past midnight; CEO/marketing headline drops "Order ₹X today" (RACI: A's number first); RACI CEO row = 2 tiles + chart; LOGIC §5a no longer claims the plan ignores the period (SW-031); Share closes after Copy summary; 44 px period buttons on phones (SW-023); smoke compares like for like (same tab), checks the tab and the digest-link form, falls back to system Chrome.
- Open: warehouse home → Ordered list after SW-012, marketing home → Pause/Push chips after SW-026; SW-031 (order value moves with the period because ABC does); SW-020 AC is "picker on first open **or** `?role=` link": the link + store menu are built, a first-open prompt was left out (it would grow the default view; PO to confirm); five critics not run on this branch yet (incl. simplicity ruling on Data → Show me + Morning digest fold and Copy summary inside Share); shared dev log page row to add at merge; roles smoke not in `npm test` (needs a browser).
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
