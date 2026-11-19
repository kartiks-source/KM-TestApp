# Module: stock-watch (Stock-out Watch web app)

Read the root `AGENTS.md` first. This file is this module's working memory: keep it current.

## What it does

Shows a D2C brand which products to reorder before they run out, and how many ₹ every stock-out cost in sales. The user is the brand or its agency. The question it answers: "was a bad sales day the ads, or an empty shelf?"

Live: https://web-production-6dd42b8d.up.railway.app. Opens a sign-in page; the password is the Railway variable `ADMIN_PASSWORD`. A signed cookie keeps you in for 30 days; Sign out is a POST to `/logout`. Scripts can still use Basic auth (any user name; the password may contain `:`).

Login hardening (ADR-0011, SW-008): one limiter for the form and Basic auth, 10 wrong passwords per IP (last `X-Forwarded-For` hop, else the socket) and 100 across all IPs per 15 minutes → 429. With `NODE_ENV=production` (set in the Dockerfile) the app refuses to start unless `ADMIN_PASSWORD` is at least 12 characters. Cookies are signed with a random secret in `DATA_DIR/secret` (mode 600) plus a password fingerprint: changing the password signs everyone out; deleting the file does too.

## How data flows

```
Shopify (read-only GraphQL) ─┐
Shopify Flow → /ingest/*  ───┼─→ rows (stock changes, order lines) → store.json → engine → page
Google Sheet CSV / upload ───┘
```

- **Stock row:** `{ t, variantId, sku, product, variant, before, now, price }`, one per stock change.
- **Order row:** `{ t, order, variantId, sku, qty, price }`, one per order line.
- **Engine** (`src/engine.js`, pure functions): stock-out episodes, in-stock sales rate, ₹ lost (weighted by the store's hour-of-day sales pattern), reorder status and quantity.

## Files

| File | Role |
|---|---|
| `LOGIC.md` | how every number is worked out and why; read it before changing `src/engine.js` |
| `server.js` | HTTP server, API, Flow ingest, sheet sync, Shopify pull every 15 min, demo loader |
| `src/engine.js` | all the maths (tested) |
| `src/rows.js` | CSV / sheet / webhook → rows; refuses files without the required header columns, skips bad rows with a reason (LOGIC.md §1a); `csvCell` guards exports against formulas |
| `src/store.js` | JSON-file storage on the `/data` volume, de-duplication, 120-day retention |
| `src/keys.js` | where the Shopify key comes from: Azure Key Vault or Railway variables |
| `src/shopify.js` | read-only guard, stock and order pulls, paced by Shopify's cost budget |
| `src/demo.js` + `src/demo-catalog.json` | 60-day demo on Sammsara's public catalog (255 variants); stock and sales invented |
| `public/` | the page (plain JS, no build step), styled like the Performity app: tokens at the top of `styles.css` |
| `test/` | `node --test`: `engine`, `shopify`, `rows` (parsing, table-driven), `server` (spawns the real server on a free port + temp DATA_DIR: auth, limiter, headers, ingest, 400s) |

## Shopify access (decided 19 Nov 2026)

- Pull straight from Shopify into our own storage. **No connection to the dev team's database.**
- Shopify credentials are the app's **client ID + client secret** (Dev Dashboard app, same Shopify organisation as the store); `src/keys.js` swaps them for a 24-hour token (client credentials grant) and renews it. A legacy `shpat_` token still works.
- Key source 1: **Azure Key Vault**, secrets `shopify-<store>-client-id` and `shopify-<store>-client-secret` (or one `shopify-<store>` JSON secret). Variables: `AZURE_KEY_VAULT_URL`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SHOPIFY_STORE`.
- Key source 2 (stop-gap): `SHOPIFY_STORE` + `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.
- Fallback if tokens can't be shared: our own read-only Shopify app (not built).
- Scopes needed: `read_products`, `read_inventory`, `read_orders`.
- Once a key source is set, the app refuses to start without `ADMIN_PASSWORD`, and demo data is turned off.

## Railway variables now

`ADMIN_PASSWORD`, `RAILWAY_RUN_UID=0` (so the app can write to the volume), with a volume at `/data`. No Shopify variables yet, so it shows the demo.

## Commands

```bash
npm start          # http://localhost:4400 (demo data on first run)
npm test
ADMIN_PASSWORD=x SHOPIFY_STORE=brand SHOPIFY_CLIENT_ID=… SHOPIFY_CLIENT_SECRET=… npm start
```

## Status

- Done: engine, page, Flow/Sheet/CSV ingest, read-only Shopify pull with Key Vault, Railway deploy, Sammsara demo.
- Sprint 1 security (SW-008/009/010/016/017/018): login limiter + prod password check, session secret in `DATA_DIR/secret`, POST logout, ingest key in the `X-Ingest-Key` header only (≤ 500 rows/request), strict CSV import, security headers + same-origin writes, CSV formula guard, 400s for bad input.
- Before the next deploy: Railway `ADMIN_PASSWORD` must be ≥ 12 characters (the Dockerfile sets `NODE_ENV=production`, so a shorter one stops the app starting). Flow workflows using `?key=` keep working but should move to the header.
- Waiting on: Key Vault access from the dev team (vault URL, tenant, app ID, secret, token format), and Performity's repo to align conventions.

## Next

1. Connect the first real store via Key Vault; compare 10 days of orders and stock for 10 SKUs against Shopify admin.
2. Alert when a pull fails or data is older than expected.
3. Move storage to Postgres when there's more than one store, or more than a few months of data.
4. Push stock changes through Shopify Flow too, so stock-outs are timed to the minute rather than to 15 minutes.
