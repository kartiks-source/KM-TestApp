# 0014. Shopify access through the Performity POC API (option A)

- Status: Accepted (19 Nov 2026). Supersedes the key-source preference in 0001 (Key Vault and own-app stay as fallbacks).
- Source: "Shopify Access Options" page (https://claude.ai/artifact/WtFwqSrSGTDzvPxm13RoG6).

## Context
The main product's Shopify tokens expire every hour and are refreshed with its app keys; each refresh issues a new token and refresh token, so a second system refreshing would break the main product's daily pull. The founders want speed and no client approvals; the dev team wants its app keys private and its pull untouched.

## Decision

Contract as shipped by Performity ("Performity POC API: calling guide", 19 Nov 2026), which replaces the draft below: header `X-Api-Key`; `GET {base}/catalys/shopify/service/external/brands` → `[{brand_id, brand_name}]`; `POST {base}/catalys/shopify/service/external/fresh-token {brand_id}` → `{access_token, shop_domain, expires_at}` (UTC without zone; `null` = no expiry; at least 15 min left; same token within that time). Rules: ask right before each pull and don't store it; on a Shopify 401 ask again; never refresh or pass it on; read only; 30 calls/min per IP, 10 token calls/min per brand, 5 wrong keys in 15 min block the IP. Our IP goes into Performity's `EXTERNAL_POC_ALLOWED_IPS` (Railway static outbound IP).

Draft (superseded details):
The dev team exposes a small API: `GET /poc/shopify/stores` and `GET /poc/shopify/token?store=<domain>` → `{store, access_token, expires_at, scopes}`, HTTPS, a key only this app holds, our fixed outbound IP allow-listed, allow-listed stores, logged, rate-limited, revocable.
This app (`src/keys.js`, source `tokenapi`):
- never refreshes a token and never sees the app's keys or refresh token;
- keeps the token in memory only, until 5 minutes before `expires_at`; asks once more if Shopify rejects it;
- if the API is down, pauses pulls and alerts (`ALERT_WEBHOOK_URL`); the token is not kept between pulls (Performity's rule);
- only reads (read-only guard on every call), uses `read_products`, `read_inventory`, `read_orders`; no webhooks; no bulk operations (so it can't pick up the main product's bulk export).

## Consequences
- One narrow dependency: a valid token. Everything after it (pulls, storage on our Railway volume, pages) is ours.
- We share the main product's Shopify API rate limit for that app; our pulls are small and incremental and back off when less than half the cost budget is left. The first 60-day order load should start after 22:00 IST.
- Switching a store to its own read-only app (option B) later is a Railway variable change, not a rebuild.
