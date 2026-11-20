# Stock Watch: Google Sheet version

Stock-out Watch with no server and no API key. The brand's own Shopify Flow writes every stock change and order line into a Google Sheet; `StockWatch.gs` (Apps Script inside the Sheet) works out what to reorder and how many ₹ each stock-out cost, every 15 minutes. The script never connects to Shopify.

## What you get

Tabs **🚨 Reorder now** (Out now, Critical, Order now, Order this week, with quantity and order value), **💸 Lost sales** (every stock-out with hours out and ₹ lost) and **📅 Daily** (30 days of ₹ sold and ₹ lost), plus an optional daily email.

## Set up

About 15 minutes, no keys shared: follow [`SETUP.md`](SETUP.md) (new Sheet → paste `StockWatch.gs` → **📦 Stock Watch → Set up (once)** → two Flow workflows → set lead time in **⚙️ Settings**).

## Files

| File | What |
|---|---|
| `StockWatch.gs` | the whole script: pure maths in `SW.compute()`, plus menu, setup, refresh and email |
| `SETUP.md` | step-by-step setup for a brand, including the two Flow row templates |
| `LOGIC.md` | the single list of how its numbers differ from the web app, and why |
| `AGENTS.md` | context for agents working on this module |

## Updating and testing

Each brand runs its own copy; to update, paste the new `StockWatch.gs` over the old one. There is nothing to deploy. The maths is checked against the web app's engine by `modules/stock-watch/test/parity.test.js`: run `npm test` at the repo root after any change.

## Moving to the web app

Publish the `Stock log` and `Order log` tabs as CSV (File → Share → Publish to web) and paste both links on the web app's Data page: the history comes along. Column formats are shared: `modules/stock-watch/FORMATS.md`.
