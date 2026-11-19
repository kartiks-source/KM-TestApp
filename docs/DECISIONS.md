# Decisions

Newest first. Each one: date, decision, who decided, why.

## 2026-11-19: Shopify access for standalone apps
- **Decided (founder):** no connection to the dev team's database; the app's data never flows through their Azure DB. Each app pulls from Shopify into its own storage.
- **Key source:** a separate Azure Key Vault holding copies of the store tokens (secret `shopify-<store>`), read-only access for our Azure login. Fallback: our own read-only Shopify app. Last resort: one-time secret link into a Railway variable, rotated later. Not a Google Sheet.
- **Read-only** is enforced in our code (only GraphQL queries pass), because a shared token may carry write permissions.
- Full write-up: Shopify Access Options page (claude.ai artifact WtFwqSrSGTDzvPxm13RoG6).

## 2026-11-19: Hosting
- Standalone modules run on Railway, separate from the live dashboard (which stays on Coolify).
- One repo (`kartiks-source/KM-TestApp`), one folder per module, context in Markdown.

## Open
- Align with Performity's stack and conventions where it speeds up production; keep separate where it doesn't. Waiting for repo access.
