# Module: stock-watch-sheets (Google Sheet version)

Read the root `AGENTS.md` first.

## What it does

Stock-out Watch with no server and no API key. The store's Shopify Flow writes every stock change and order line into a Google Sheet, and `StockWatch.gs` (Apps Script inside the sheet) works out reorders and ₹ lost every 15 minutes.

## Files

| File | Role |
|---|---|
| `StockWatch.gs` | paste into the sheet: Extensions → Apps Script |
| `SETUP.md` | 15-minute setup for a brand: sheet, two Flow workflows, settings |

## Relation to the web app

The web app (`modules/stock-watch`) can read this sheet's two tabs as published CSV links, so a brand can start here and move to the web app without losing history. Keep the column formats the same in both modules (see `modules/stock-watch/src/rows.js`).

## Status

Done; not deployed anywhere by us. Each brand runs its own copy.
