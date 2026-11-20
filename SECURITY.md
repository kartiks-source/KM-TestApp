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
| Session cookie `sw_session` | being signed in for 30 days | the browser; signed with an HMAC of the password | Changing `ADMIN_PASSWORD` signs everyone out. Hardening to a random key in `/data/secret` + password fingerprint is SW-008 |
| Google Sheet "Publish to web" CSV links | anyone with the link can read the Stock log / Order log tabs | Data page settings (`store.json`) and the brand's Google account | In the Sheet: File → Share → Publish to web → stop publishing, publish again, paste the new links on the Data page |
| Backups and exports (`/data/backups/*.json`, `GET /api/export/backup.json`) | all sales data **and the ingest key** | the volume; wherever someone saved a download | Treat a leaked export as a leaked ingest key: rotate it. Delete downloads when done; never commit, attach or paste them |

Never put any of these in code, Markdown, logs, commit messages, chat or a Google Sheet. Before every commit, run the secret check in `docs/DEFINITION-OF-DONE.md` on the staged diff and read every hit: a real value (not a variable name or a placeholder) means stop and remove it.

## Auth model (today)

- **One shared admin password** (`ADMIN_PASSWORD`). The sign-in page (`POST /login`) sets an HttpOnly, SameSite=Lax cookie valid 30 days (`Secure` behind HTTPS). Scripts can use HTTP Basic auth with any user name.
- **Without `ADMIN_PASSWORD` the app is open.** It refuses to start without one only when Shopify is connected. SW-008 makes it refuse in production (`NODE_ENV=production`) whenever the password is missing or under 12 characters.
- **Login attempts:** the form allows 10 wrong passwords per IP per 15 minutes, then 429. Known gaps fixed by SW-008: Basic auth isn't rate-limited, and the IP comes from a client-set `X-Forwarded-For`. Across all IPs, 100 wrong passwords per 15 minutes switch every new attempt to "password still checked, a wrong one gets 429": the cap slows a spread-out guesser without letting a stranger lock the owner out (critic round 1, SEC-1).
- **Flow ingest** is not behind the login; it's protected by the ingest key alone.
- **`/health`** is open and returns only `{"ok":true}`.
- **Shopify is read-only in code:** `src/shopify.js` `assertReadOnly()` lets only GraphQL query documents through (no `mutation`, no `subscription`) and the app asks only for read scopes, because a shared key may carry write scopes. No webhooks are registered.
- **The Google Sheet** never talks to Shopify and holds no key: Shopify Flow writes rows into it with the brand's own Google connection.
- **View-only password** (`VIEW_PASSWORD`, SW-029, LOGIC.md §13): one gate right after sign-in refuses every write to `/api` with 403 before any route runs (Sprint 1's Mark ordered, settings, import, clear, demo, pulls included; digest settings when they land). `GET /api/export/backup.json` is admin-only. Same wrong-password limiter as admin.
- Next: named users / Performity SSO (SW-060).

## Endpoints that change or wipe data

All need the admin login except `/ingest/*` (a `VIEW_PASSWORD` session gets 403 on every one). Each wipe is backed up first (`docs/RUNBOOK.md`).

| Endpoint | Effect | Undo |
|---|---|---|
| `POST /api/clear` | deletes every stock change and order line, every Mark-ordered record and every slow-seller decision | restore the `…-before-clear.json` backup: it carries `onorder.json` and `decisions.json` too (`sideFiles`, RUNBOOK → Restore) |
| `POST /api/demo` | replaces all data with demo data (refused while Shopify is connected, and 409 while the store holds real data: Clear first; the page asks to confirm) | restore the `…-before-demo.json` backup |
| `POST /api/import?replaceDemo=1` | removes demo data, then adds the CSV rows | restore if it wasn't demo |
| `POST /api/import` | adds CSV rows (duplicates skipped) | restore a backup from before the import |
| `PUT /api/settings` | planning settings, store name, Sheet links; `newIngestKey: true` rotates the ingest key (breaks Flow until updated) | set the old values again; a rotated key can't be brought back |
| `POST /api/sync`, `POST /api/shopify/sync` | fetch new rows from the Sheet links / Shopify now | — |
| `POST /ingest/stock`, `POST /ingest/order` | add rows (ingest key, no login) | restore a backup; rotate the key if misused |
| `GET /api/export/backup.json`, `GET /api/export/reorder.csv` | read-only downloads (the backup includes the ingest key) | — |

Planned hardening: SW-008 (login), SW-009 (ingest key out of URLs and logs, 500-row cap), SW-016 (security headers, same-origin check on writes), SW-017 (CSV formula injection), SW-018 (bad input → 400).
