# Security

How Catalys modules keep secrets and access safe. Covers `modules/stock-watch` (the web app on Railway) and `modules/stock-watch-sheets` (the Google Sheet). Rules that apply everywhere: AGENTS.md rules 7 (no secrets in git, ever) and 8 (Shopify is read-only). Decisions: ADR-0001 (Shopify keys in Key Vault, read-only), ADR-0011 (auth model). Operations: `docs/RUNBOOK.md`.

Found a problem? Tell the repo owner directly (not in a public issue or a shared channel), with steps to reproduce.

## Secrets: what, where, how to rotate

| Secret | What it unlocks | Lives in | Rotate |
|---|---|---|---|
| `ADMIN_PASSWORD` | the whole web app: every page, every `/api` route, Clear, the ingest key, exports | Railway variable (service `web`) | Change the variable and apply it (Railway redeploys). Every session is signed out (the cookie signature depends on it). Tell the team the new one by a private channel, never in chat history, a doc or a sheet |
| `VIEW_PASSWORD` (optional) | a view-only sign-in: every page, number and CSV; no write (`POST/PUT/PATCH/DELETE /api/*` → 403), no ingest key, no backup export | Railway variable (service `web`) | Change or remove the variable and apply it: every view session is signed out (a fingerprint of it is inside the signed view cookie). Must differ from `ADMIN_PASSWORD`; the app refuses to start with it set but no `ADMIN_PASSWORD` |
| Shopify client ID + client secret | read access to the store's products, inventory and orders (`read_products`, `read_inventory`, `read_orders`) | Azure Key Vault: `shopify-<store>-client-id` and `shopify-<store>-client-secret` (or one `shopify-<store>` JSON secret). Stop-gap: Railway variables `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | The brand rotates the secret in its Shopify Dev Dashboard → update the Key Vault secret (or variable) → restart the app (credentials are cached 30 minutes, the 24-hour Shopify token until near expiry). Check the Data page shows a good pull |
| Legacy `SHOPIFY_ACCESS_TOKEN` (`shpat_…`) | same as above | Railway variable | Revoke in Shopify admin (uninstall the custom app or regenerate), set the new one, restart. Prefer moving to client ID + secret |
| Azure service principal: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (+ `AZURE_KEY_VAULT_URL`) | reading Shopify secrets from the vault | Railway variables | Create a new client secret in Azure (Entra ID → App registrations → the app → Certificates & secrets), set the variable, restart, check a pull works, then delete the old secret. Give the principal **Get** on secrets only |
| Ingest key | posting stock and order rows to `/ingest/stock` and `/ingest/order` (Shopify Flow) | `store.json` on the `/data` volume (settings), shown on the Data page; also inside every backup and export | Data page → Shopify Flow → **New key**, then update the `X-Ingest-Key` header (or `?key=`) in both Flows straight away: rows sent with the old key are refused (401) |
| Session cookie `sw_session` | being signed in for 30 days (admin or view role) | the browser; signed with HMAC-SHA256 under a key made from the random secret in `DATA_DIR/secret` (mode 600, made on first start) plus a fingerprint of `ADMIN_PASSWORD` (`server.js` `keyOf`) | Change `ADMIN_PASSWORD` (signs everyone out), or delete `/data/secret` and restart (signs everyone out, a new secret is made). Never copy `secret` off the volume |
| `DATA_DIR/secret` | forging a session cookie, together with the password fingerprint | the `/data` volume only (not in backups or exports) | Delete it and restart: a new one is made and every session ends |
| Performity POC API key: `PERFORMITY_POC_API_KEY` (alias `TOKEN_API_KEY`), with `PERFORMITY_POC_API_URL` (alias `TOKEN_API_URL`) and optional `PERFORMITY_BRAND_ID` (ADR-0014) | asking Performity for a fresh Shopify token for the allowed brands, read-only, before each pull | Railway variables (service `web`); never on disk, in logs or the browser; the token it returns is kept in memory for one pull only | Ask the Performity team for a new key, set `PERFORMITY_POC_API_KEY`, apply (Railway redeploys), check the Data page shows a good pull, then ask them to revoke the old key. A wrong key pauses pulls 15 min (5 wrong keys in 15 min block our IP on their side). The URL and brand ID aren't secret but changing them changes which store is read |
| Morning digest webhooks: `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_URL_<ROLE>` (e.g. `_CEO`) | posting into the receiving chat / Zapier / Make flow; these URLs usually carry a token, and the digest carries sales numbers | Railway variables only (the page can't set one; it shows only the host; never logged, never in `store.json`; LOGIC.md §17) | Make a new incoming-webhook URL in the receiving tool, set the variable, apply, press **Send now** on Data → Morning digest to check, then delete the old webhook in that tool |
| Sync alert webhook: `ALERT_WEBHOOK_URL` | posting into the alert channel (no keys or tokens are ever in the message) | Railway variable only | Same as the digest webhooks: new URL in the tool, set the variable, apply, delete the old one |
| Google Sheet "Publish to web" CSV links | anyone with the link can read the Stock log / Order log tabs | Data page settings (`store.json`) and the brand's Google account | In the Sheet: File → Share → Publish to web → stop publishing, publish again, paste the new links on the Data page |
| Backups and exports (`/data/backups/*.json`, `GET /api/export/backup.json`) | all sales data, Mark-ordered records and decisions (`sideFiles`) **and the ingest key** | the volume; wherever someone saved a download | Treat a leaked export as a leaked ingest key: rotate it. Delete downloads when done; never commit, attach or paste them |

Never put any of these in code, Markdown, logs, commit messages, chat or a Google Sheet. Before every commit, run the secret check in `docs/DEFINITION-OF-DONE.md` on the staged diff and read every hit: a real value (not a variable name or a placeholder) means stop and remove it.

## Auth model (today)

- **One shared admin password** (`ADMIN_PASSWORD`, ADR-0011). The sign-in page (`POST /login`) sets an HttpOnly, SameSite=Lax cookie valid 30 days (`Secure` behind HTTPS), signed with a key made from the random `DATA_DIR/secret` plus a password fingerprint (SW-008), so changing the password signs everyone out. Scripts can use HTTP Basic auth with any user name. Sign out is `POST /logout` only (a link elsewhere can't sign you out).
- **Refuses to start** (exit 1, nothing served) with `NODE_ENV=production` and `ADMIN_PASSWORD` missing or under 12 characters; with Shopify connected and no `ADMIN_PASSWORD`; and with `VIEW_PASSWORD` set but no `ADMIN_PASSWORD`, or the two equal. Only a local run (not production, no Shopify) without `ADMIN_PASSWORD` is open, for development.
- **Login attempts:** one limiter covers the sign-in form and Basic auth (SW-008): 10 wrong passwords per IP per 15 minutes, then 429 without checking. The IP is the last `X-Forwarded-For` hop (the one Railway's proxy adds; earlier hops are whatever the client sent), else the socket. Across all IPs, 100 wrong passwords per 15 minutes switch every new attempt to "password still checked, a wrong one gets 429": the cap slows a spread-out guesser without letting a stranger lock the owner out (critic round 1, SEC-1).
- **`/health`** is open and returns `{"ok":true}`, or 503 with the save/load error. **`/status`** (uptime monitors) is open: freshness, row counts, store size; no names, keys or error text.
- **Writes from another site** are refused (403) before any route: `Sec-Fetch-Site` must be same-origin (or `Origin` must match the host) on every `POST/PUT/PATCH/DELETE` to `/api/*`, `/login`, `/logout` (SW-016). Security headers on every answer: CSP (`script-src 'self'`), `nosniff`, `no-referrer`, `frame-ancestors 'none'`, HSTS behind HTTPS.
- **Flow ingest** is not behind the login; it's protected by the ingest key alone, sent in the `X-Ingest-Key` header (`?key=` still accepted, warned in the log at most hourly: it ends up in proxy logs), at most 500 rows per request (SW-009). Bad input anywhere → 400 with a plain message, never a stack (SW-018). CSV downloads guard formula cells (SW-017).
- **Shopify is read-only in code:** `src/shopify.js` `assertReadOnly()` lets only GraphQL query documents through (no `mutation`, no `subscription`) and the app asks only for read scopes, because a shared key may carry write scopes. No webhooks are registered.
- **The Google Sheet** never talks to Shopify and holds no key: Shopify Flow writes rows into it with the brand's own Google connection.
- **View-only password** (`VIEW_PASSWORD`, SW-029, LOGIC.md §13): one gate right after sign-in refuses every write to `/api` with 403 before any route runs (Mark ordered, decisions, settings, import, clear, demo, pulls, digest settings and send-now included). `GET /api/export/backup.json` is admin-only. Same wrong-password limiter as admin.
- Next: named users / Performity SSO (SW-060).

## Endpoints that change or wipe data

All need the admin login except `/ingest/*` (a `VIEW_PASSWORD` session gets 403 on every one). Each wipe is backed up first (`docs/RUNBOOK.md`).

| Endpoint | Effect | Undo |
|---|---|---|
| `POST /api/clear` | deletes every stock change and order line, every Mark-ordered record and every slow-seller decision | restore the `…-before-clear.json` backup: it carries `onorder.json` and `decisions.json` too (`sideFiles`, RUNBOOK → Restore) |
| `POST /api/demo` | replaces all data with demo data (refused while Shopify is connected, and 409 while the store holds real data: Clear first; the page asks to confirm) | restore the `…-before-demo.json` backup |
| `POST /api/import?replaceDemo=1` | removes demo data, then adds the CSV rows | restore if it wasn't demo |
| `POST /api/import` | adds CSV rows (duplicates skipped) | restore a backup from before the import |
| `PUT /api/settings` | planning settings, store name, Sheet links; `newIngestKey: true` rotates the ingest key (breaks Flow until updated); every change logged (who, old → new; the key masked) | set the old values again; a rotated key can't be brought back |
| `POST /api/onorder` | Mark ordered: stores or removes (qty 0) PO records `{qty, eta, at, by}` in `onorder.json`, at most 500 per request; ordered lines leave Order today | mark again with the old quantity and date, or qty 0; restore a backup (`sideFiles`) |
| `POST /api/decide` | stores or removes (empty decision) a slow-seller decision (keep / drop / clear) in `decisions.json`; the item is hidden until its sales change | **Undo** under the table; restore a backup (`sideFiles`) |
| `PUT /api/digest/settings` | morning digest hour, roles, paused (webhook URLs are env only: a body with one → 400) | set the old values again |
| `POST /api/digest/send` | posts the digest (sales numbers) to the configured webhook now, logged | — (a sent message can't be recalled; check who the webhook reaches) |
| `POST /api/sync`, `POST /api/shopify/sync` | fetch new rows from the Sheet links / Shopify now | — |
| `POST /ingest/stock`, `POST /ingest/order` | add rows (ingest key, no login) | restore a backup; rotate the key if misused |
| `GET /api/export/backup.json`, `GET /api/export/reorder.csv` | read-only downloads (the backup includes the ingest key) | — |

