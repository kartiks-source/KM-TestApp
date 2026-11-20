# Decisions

Newest first. Each one: date, decision, who decided, why.

## 2026-11-20: Several stores in one app (ADR-0015)
- **Decided (owner, spec 19–20 Nov):** every Performity brand our key may use is a store in one app, switched from the store pill. Data per store in `DATA_DIR/stores/<id>/` (the old single-store files, unchanged); passwords for every store; pulls one store at a time. No key → two labelled demo stores.
- Why a folder per store and not a store id on every row: a missed filter would mix brands; a folder can't. Old single-store data moves into its store (`SHOPIFY_STORE` / `PERFORMITY_BRAND_ID`, else the first) on the first start, once per DATA_DIR (copy, check, then delete).

## 2026-11-19: Shopify credentials are client ID + secret
- Shopify apps from the Dev Dashboard give a **client ID + client secret**, not a permanent `shpat_` token. We swap them for a 24-hour token (client credentials grant: POST `https://{store}.myshopify.com/admin/oauth/access_token`, `grant_type=client_credentials`) and request a new one before expiry; there's no refresh token. Source: Shopify docs, "Client credentials grant".
- **Constraint:** the grant only works when the app and the store are in the same Shopify organisation. For a brand's store, the brand creates the app in its Dev Dashboard, installs it with read scopes only, and shares the ID + secret (via Key Vault: `shopify-<store>-client-id`, `shopify-<store>-client-secret`). Our own org's app can't reach a client store this way (`shop_not_permitted`).
- Legacy `shpat_` tokens still work if a brand only has one.

## 2026-11-19: Look and feel follows Performity
- Modules use the Performity app's visual language so they can sit beside it: Inter, brand blue #0978BE, pale blue page #EEF3F8, white cards, icon rail, top bar with store picker + Data Sync pill. Source: product screenshots on the Performity marketing site (catalysAnalyst/performity-site). Tokens live in `modules/stock-watch/public/styles.css`.
- Code conventions not aligned yet: the Performity app repo isn't shared with us.

## 2026-11-19: Shopify access for standalone apps
- **Decided (founder):** no connection to the dev team's database; the app's data never flows through their Azure DB. Each app pulls from Shopify into its own storage.
- **Key source:** a separate Azure Key Vault holding each store's app client ID + secret (see the credentials decision above), read-only access for our Azure login. Fallback: our own read-only Shopify app. Last resort: one-time secret link into a Railway variable, rotated later. Not a Google Sheet.
- **Read-only** is enforced in our code (only GraphQL queries pass), because a shared token may carry write permissions.
- Full write-up: Shopify Access Options page (claude.ai artifact WtFwqSrSGTDzvPxm13RoG6).

## 2026-11-19: Hosting
- Standalone modules run on Railway, separate from the live dashboard (which stays on Coolify).
- One repo (`kartiks-source/KM-TestApp`), one folder per module, context in Markdown.

## Open
- **Shared packages for multi-module logic** (proposed by the cross-module critic, 19 Nov): `packages/shopify-read` (keys + read-only guard + pulls), `packages/rows` (row formats + FORMATS.md), `packages/stock-rules` (episodes, in-stock rate, plan, trend, sale definition) with their tests and LOGIC sections; modules keep their reports. A build step copies stock-rules into the Sheet's `SW` block, and a parity test runs the same data through both. npm workspaces; Dockerfile copies `packages/`. Do this before a second module reuses the logic.
- Align with Performity's code stack and conventions where it speeds up production; keep separate where it doesn't. Waiting for access to the app repo (only the marketing site is visible).
