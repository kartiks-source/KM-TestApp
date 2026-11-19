# 0001. Read-only Shopify via client credentials + Key Vault

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder

## Context

Modules need orders and stock from brand stores. Dev Dashboard apps issue a client ID + secret, not a permanent `shpat_` token; the client credentials grant gives a 24-hour token with no refresh token, and only works when app and store are in the same Shopify organisation. Tokens shared with us may carry write scopes. Secrets must never sit in git, Markdown, logs or Sheets.

## Decision

- The brand creates the app in its own Dev Dashboard with `read_products`, `read_inventory`, `read_orders`, installs it, and stores ID + secret in a separate Azure Key Vault (`shopify-<store>-client-id`, `shopify-<store>-client-secret`). Our Azure login has read access only.
- `src/keys.js` swaps them for a 24-hour token and renews before expiry. Env vars are a stop-gap; legacy `shpat_` tokens still work.
- Read-only is enforced in code: `assertReadOnly` lets only GraphQL queries through. No mutations, no webhooks under someone else's app (no bulk operations, since they are mutations).

## Consequences

- A brand can't be connected without its own app; our org's app can't reach it (`shop_not_permitted`).
- The read-only promise rests on our guard. SW-051 hardens it (tokeniser, refuse tokens whose granted scopes include `write_*`).
- Rotation: secret changes in Key Vault are picked up within the key cache TTL or on the next 401 (see SECURITY.md).
- Revisit if Shopify changes the grant, or Performity provides a shared, read-only data feed.
