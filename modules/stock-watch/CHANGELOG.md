# Changelog: Stock-out Watch (web app)

User-facing changes, newest first. Semver: minor when a number's rule changes or a feature lands, patch for fixes. The version in `package.json` matches the top heading. Versions before 0.9.0 were reconstructed from `docs/DEVLOG.md` on 20 Nov 2026 (no tags existed); dates are the DEVLOG dates. Per DEVLOG, nothing from 0.6.0 on has been deployed yet; `/status` does not show a version yet (SW-056).

## 0.10.0 · 2026-11-20 · several stores, everything shown by default

- Added: several stores in one app (ADR-0015). Every brand the Performity key may use is a store (`PERFORMITY_BRAND_ID` limits it to one); Key Vault `STORES=a,b`; one store from Railway variables; no key → two labelled demo stores with different numbers. Each store's data is in its own folder; nothing is ever added up across stores.
- Added: the store pill is a picker with a green / amber / red dot per store (phones: a store bar under the top bar). The address carries `?store=<id>`; the choice is remembered on this browser. One store shows just its name (phones too). The dots refresh every minute; the menu scrolls instead of running off a short laptop screen; long brand names end in "…"; the product drawer names the store.
- Changed: settings, Mark ordered, Decide, the change log, run history, digest settings and backups are per store; passwords are for every store and view-only stays read-only on all of them. Alerts, digests, the PO CSV file name and the tab title name the store; `/status` totals every store.
- Changed: the old single-store data moves into its store (`SHOPIFY_STORE` / `PERFORMITY_BRAND_ID`, else the first) on the first start, once per data folder (checked copy, safe to interrupt). A later change to the store list never moves anything again.
- Changed: everything shows by default: no role chosen ("All"), Reorder opens on All, every optional column is on (untick in Columns…; on a narrow laptop the right-most ones step aside with a note, never a sideways scroll), Overview shows every panel.

## 0.9.0 · 2026-11-20 · pre-production

Not production-ready yet: see `docs/MODULE-STANDARD.md` §Declaring and the open items in `docs/BACKLOG.md`.

- Fixed: the CEO / finance digest's "vs the 7 days before" no longer counts lost sales on a variant archived while out of stock.
- Changed: best-seller rank (A/B/C) leaves out archived, draft and untracked variants, so the best-seller count, best sellers at risk and order value no longer move with the period buttons.
- Fixed: the reorder / PO CSV, report and Group by no longer fail on unusual variant IDs (such as `constructor`).
- Fixed: Group by trend chips follow the products' colour rule (a fall is never green) against the same baseline.
- Changed: Products filters lose the duplicate Overstock and Slow sellers options (Push these and Slow sellers to decide cover them); marketing's phone home leads with "Pause promotion on N products".
- Docs: `CHANGELOG.md`, `API.md`, `FORMATS.md`, a complete `.env.example`, and a refreshed root `SECURITY.md` and `docs/RUNBOOK.md` (uptime monitor, sidecar files in a restore).

## 0.8.0 · 2026-11-20 · Shopify through the Performity POC API

- Added: Shopify key source "option A" (ADR-0014): the app asks Performity's POC API for a fresh read-only token before each pull (`PERFORMITY_POC_API_URL`, `PERFORMITY_POC_API_KEY`, optional `PERFORMITY_BRAND_ID`). Errors are in plain words (IP not allowed, brand not allowed, store must reconnect); a wrong key pauses pulls 15 minutes.
- Added: `ALERT_WEBHOOK_URL`: one message when Shopify pulls start failing, a reminder every 6 hours, one when they work again.

## 0.7.0 · 2026-11-19 · Sprint 2: value for every role

- Added: role home views (CEO, founder, ops, buyer, marketing, finance, warehouse) that only remove UI; pick from the store menu or `/?role=` (SW-020).
- Added: Group by parent product, category, collection or tag on Products (SW-022).
- Added: a plain "why" sentence and an order-by date on every reorder row; still-out headline shows ₹ per day (SW-024).
- Changed: the reorder CSV works as a purchase order: follows the tab and search, adds vendor, unit cost and variant ID (SW-025).
- Added: Pause promotion / Push these lists for marketing (SW-026); "Yesterday" strip and "This month" period (SW-027).
- Added: morning digest per role, sent to a webhook at a set hour after a fresh pull, plus Share → Copy / WhatsApp (SW-028).
- Added: view-only password (`VIEW_PASSWORD`) and a settings change log (SW-029); sync progress pill and the last 20 runs (SW-030); slow-seller Decide bucket (SW-032).
- Changed: Mark ordered is a tick + bulk bar (one control per row), with an Ordered tab listing every open PO; trend chip colour follows the product's own sign.

## 0.6.0 · 2026-11-19 · Sprint 1: production-ready foundations

- Fixed: the report no longer fails past ~120k rows (SW-001).
- Changed: current stock comes from a catalog snapshot on every pull, so dead stock and archived items are counted right (SW-002).
- Changed: a best seller out of stock for weeks keeps its sales rate and its ₹ lost (SW-003); ABC ranks on demand, not the selected period (SW-031).
- Added: safe saves, a quarantined bad file instead of a blank store, graceful shutdown, `/health` 503 on save failures (SW-004); daily backups, before-wipe backups, restore on start and a backup download (SW-005).
- Changed: one data source per store, so no sale counts twice (SW-006); demo data never mixes with real data (SW-007).
- Security: login limiter on form and Basic auth, production refuses a short password, POST sign-out (SW-008); ingest key in the `X-Ingest-Key` header, 500 rows per request (SW-009); strict CSV import with skip reasons (SW-010); security headers and same-origin writes (SW-016); CSV formula guard (SW-017); bad input → 400 (SW-018).
- Fixed: plan bar Save as default / Reset (SW-011). Added: Mark ordered (SW-012); trend in the decision rows (SW-021); stale-data banner and `/status` (SW-019).
- Changed: the Google Sheet gives the same ₹ lost as the web app (SW-013).

## 0.5.0 · 2026-11-19 · critic fixes and simplicity pass

- Changed: what counts as a sale matches the client's sheet (cancelled and test orders out, refunds netted, price after discounts).
- Changed: three statuses people see (Order today, This week, OK); Overview headline "Order ₹X today · stock-outs cost ₹Y"; fewer default columns; plain labels.
- Fixed: new launches no longer look overstocked; trend ignores time before a product's data; a best seller is never a slow seller.

## 0.4.0 · 2026-11-19 · money view

- Added: best sellers (ABC), profit lost from unit cost, cash in overstock, cash to order now; live assumptions bar with Save as default / Reset.
- Added: trend column with weekly bars; Shopify client ID + secret as the main credential.

## 0.3.0 · 2026-11-19 · Products page and logic docs

- Added: Products page with status tabs, category filter and CSV; `LOGIC.md` for every number.
- Changed: tables fit the screen at 1280–1920 px; denser layout.

## 0.2.0 · 2026-11-19 · sign-in and look

- Added: sign-in page with a 30-day cookie (works in embedded browsers).
- Changed: Performity look; phone cards instead of wide tables.

## 0.1.0 · 2026-11-19 · first release

- Added: reorder list and ₹ lost to stock-outs from Shopify Flow, a Google Sheet or CSV; read-only Shopify pull (Key Vault or variables); Sammsara demo data. Deployed to Railway with a `/data` volume and a password.
