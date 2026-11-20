# Runbook: Stock-out Watch (web app)

What to do when something breaks, and how to get data back. For secrets and who can do what, see [`SECURITY.md`](../SECURITY.md). For why it runs this way, see ADR-0003 (JSON store) and ADR-0012 (one instance on Railway).

## Where things are

| What | Where |
|---|---|
| App | Railway project `stock-watch`, service `web`, one replica: https://web-production-6dd42b8d.up.railway.app |
| Data | Railway volume at `/data`: `store.json` (everything: rows, settings, ingest key, Shopify cursor) |
| App backups | `/data/backups/` (below) |
| Health | `GET /health` → `{"ok":true}` (no login) |
| Logs | Railway dashboard → service → Deployments → View logs (lines start `backup:`, `restore:`, `shopify:`) |

## Connect the first store (option A: Performity POC API)

1. Railway → service `web` → **Settings → Networking → Enable Static IPs** (Pro plan), then redeploy. Copy the IPv4 address(es) and send them to Performity for `EXTERNAL_POC_ALLOWED_IPS`.
2. Performity sends the base URL and our key (one-time link). Railway → service `web` → **Variables**: set `PERFORMITY_POC_API_URL`, `PERFORMITY_POC_API_KEY`, `ALERT_WEBHOOK_URL`; keep `ADMIN_PASSWORD` (12+ chars). If they allow more than one brand, also `PERFORMITY_BRAND_ID`. Saving redeploys. Do it after 22:00 IST: the first pull loads 60 days of orders on Performity's shared Shopify limit.
3. Data page shows "Connected to Shopify" with the store; demo data is cleared automatically. Railway → service → **Deployments → View logs**: `shopify: … stock changes, … order lines`. Errors are in plain words (IP not allowed, brand not allowed, store must reconnect…).
4. Next morning: compare 10 days of Sold and order counts with Shopify admin (Analytics → Net sales) and stock for 10 SKUs. Only then show numbers.
5. To stop at once: delete `PERFORMITY_POC_API_URL` in Variables. A wrong key is never retried in a loop (5 wrong keys block our IP for 15 minutes).

## Deploy and roll back

Deploys are a local `railway up` (no auto-deploy from GitHub yet; ADR-0012):

1. `git checkout main && git pull && git status` → clean, and CI green on that commit (GitHub Actions "test").
2. `npm test` locally.
3. `railway up` from the repo root. Railway builds the root `Dockerfile`.
4. Check `/health` is 200 and sign in once. Record the deployed SHA in `docs/DEVLOG.md`.

Roll back: Railway dashboard → Deployments → the previous deployment → Redeploy. The volume is not touched by a deploy or a rollback.

## Backups

**1. App backups (on the volume, automatic).** `src/backup.js` writes:

| File | When | Kept |
|---|---|---|
| `backups/store-YYYYMMDD.json` | once a day (store's local date), checked at start and every hour | newest 14 |
| `backups/store-YYYYMMDD-HHMMSS-before-clear.json` | just before Clear, demo → live, or an import that replaces demo data | newest 14 |
| `backups/store-YYYYMMDD-HHMMSS-before-demo.json` | just before demo data replaces real data | newest 14 |
| `backups/store-YYYYMMDD-HHMMSS-before-restore.json` | just before a restore (below) | newest 14 |

An empty store and demo data are never backed up (nothing to lose; demo reloads would push real snapshots out). Each file is a full copy of `store.json` **plus `sideFiles`: the Mark-ordered records (`onorder.json`) and slow-seller decisions (`decisions.json`)**, which live next to it on the volume (critic r2 X1: lost PO marks put ordered lines back in Order today, the duplicate PO SW-012 exists to stop). The export below carries them too. So 28 files × the store's size must fit on the volume: at 50 MB (ADR-0003's move trigger) that is 1.4 GB.

**2. Railway volume backups (whole volume, owner sets up once).** Railway dashboard → project `stock-watch` → service `web` → the `/data` volume → Backups → schedule **Daily**, keep **at least 7**. These survive a deleted or corrupted volume, which app backups (on the same volume) don't. Status: not yet confirmed on (see DEVLOG).

**3. Download now (any time, login needed).** `GET /api/export/backup.json` returns the whole store as a file:

```bash
curl -fsS -u "x:$ADMIN_PASSWORD" -o stock-watch-store.json https://web-production-6dd42b8d.up.railway.app/api/export/backup.json
```

Do this before anything risky (a big import, connecting Shopify for the first time, a storage change). The file holds the ingest key and sales data: keep it out of git, chat and shared drives.

## Restore

The app restores on start: if `/data/restore.json` exists and looks like a store (has `stock`, `orders`, `settings`), it keeps the current `store.json` (with the current side files) as `backups/…-before-restore.json`, puts `restore.json` in its place, writes `onorder.json` and `decisions.json` from its `sideFiles` (each current file kept as `<name>.bak`), and logs `restore: store.json replaced from restore.json (with onorder.json, decisions.json) …`. A backup from before 20 Nov 2026 has no `sideFiles`: the current Mark-ordered and decision files are left as they are. A file that isn't a store is renamed `restore.json.rejected-<time>` and the current store stays (log line `restore: … is not a Stock-out Watch store`).

**From an app backup (Railway):**

1. List backups: `railway ssh` (into service `web`), then `ls -l /data/backups`. Pick the newest file from before the problem (a `before-clear` file if someone pressed Clear).
2. `cp /data/backups/<file> /data/restore.json`
3. Restart the service right away (dashboard → service → ⋯ → Restart). Copying into `store.json` directly would be overwritten by the running app's next save; `restore.json` is only read at start.
4. Check the logs for `restore: store.json replaced`, sign in, and check the Data page row counts and the last stock/order times.
5. If the store had Shopify connected, the next pull (within 15 minutes) fills in orders since the backup. Stock-out history between the backup and now can't be recovered.

**From a downloaded export or a Railway volume backup:** restore the Railway volume backup from the dashboard (it replaces the whole volume; then restart), or copy the exported file to `/data/restore.json` and restart as above.

**Locally:** stop the app, `cp <backup> $DATA_DIR/restore.json`, start it.

**Drill:** do one restore on a local copy each sprint and log it in `docs/DEVLOG.md` (last: 19 Nov 2026, SW-005).

## When something is wrong

| Symptom | Check | Fix |
|---|---|---|
| Page down / 502 | `/health`; Railway logs for a crash on start | `Refusing to start: … ADMIN_PASSWORD` → set the variable. Otherwise roll back to the last good deployment |
| "Login needed" everywhere | `ADMIN_PASSWORD` changed? | Sign in again (changing it signs everyone out) |
| Numbers look empty after a deploy | Data page row counts; `ls -l /data` | Volume not attached at `/data`, or Clear was pressed: restore (above) |
| Shopify data stale | Data page: last pull, last error; logs `shopify pull failed:` | Key expired or scopes missing: see SECURITY.md (rotate Shopify key). Press Sync now on the Data page |
| Flow rows not arriving | Flow run history in Shopify; Data page last row time | Ingest key rotated → update the `X-Ingest-Key` header in both Flows |
| Disk full | Railway volume usage; `du -sh /data/*` | Delete old `restore.json.rejected-*` files; grow the volume; review ADR-0003 triggers |
| `Refusing to start: onorder.json can't be read` (or `decisions.json`) | `ls -l /data` for `onorder.json.corrupt-*` | The file is damaged and there is no good `.bak`. Nothing was overwritten. Restore the newest backup (above: its `sideFiles` bring the marks back), or move the bad file aside (`mv /data/onorder.json /data/onorder.json.bad`) to start with no marks, then re-mark open POs |
| Restore did nothing | Logs for `restore:` lines; `ls /data` | File named wrong (must be `/data/restore.json`) or rejected (`restore.json.rejected-*`): check it's a store export |
