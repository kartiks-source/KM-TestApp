# Stock Watch (Google Sheet): logic

The core rules match the web app: stock-out episodes (a blank *Stock before* = the previous row's *Stock now*), sales per in-stock day (a new product measured from its first record; a long stock-out, under 7 in-stock days in the window, looks back over the last 120 days of the logs, then to the 28 days before the stock-out), status thresholds, order quantity, small top-up, out again, slow-seller cutoff, and ₹ lost counting only the part of a stock-out inside the last 30 days. They're explained in [`../stock-watch/LOGIC.md`](../stock-watch/LOGIC.md).

**This file is the single list of differences.** `modules/stock-watch/test/parity.test.js` loads `StockWatch.gs` in a sandbox and runs eight fixtures through `SW.compute()` and the web app's `engine.js`: same status and order quantity on every reorder row, ₹ lost within 2%, same 30-day sold and lost totals. A difference that's intended goes in that test's `ALLOW` list with its reason, and here. Anything else fails `npm test`.

The differences, all checked against the code:
- **No trend, best sellers (A/B/C), profit lost or overstock.** Those exist only in the web app.
- **Order value is at selling price.** The Sheet has no unit cost, so its "Order value" is roughly twice the web app's cash-at-cost figure for the same order.
- **The reorder list isn't sorted with best sellers first** within each status.
- **Repeated rows aren't dropped,** so pasting overlapping orders counts them twice (see SETUP.md).
- **What counts as a sale** depends on what the Flow sends: cancelled orders, test orders, refunds and order-level discounts are whatever the template writes. The web app's Shopify pull handles all four.
- **Day boundaries** follow the Sheet's time zone setting, and the daily split of a stock-out is hour by hour (up to an hour off at midnight).
- **Order lines with no variant** (custom items) are grouped as one blank product; the web app drops them.
- **No best sellers, so no best-seller exception to the slow-seller cutoff.** A ₹90,000 item selling one every 8 days is a slow seller here and left off the reorder list; the web app keeps it (its section 7). Allowlisted in the parity test.
- **The window is a fixed 30 days.** The web app's period can be 7 to 90 days. Within the 30 days both count only the hours of a stock-out inside the window; "Hours out" on the Lost sales tab still shows the whole stock-out, like the web app's "Out for".
- **₹ lost values every hour of a stock-out equally.** The web app weights each hour by how busy that hour usually is for the store (its section 4a). So a stock-out mostly overnight costs more here than in the web app, and one mostly in the evening costs less. A stock-out lasting whole days comes out the same in both.

Why: Apps Script runs every 15 minutes inside a Sheet with a time limit, and the hour-of-day pattern needs every order line of the last 60 days on each run. Keeping the Sheet simple was worth the small difference. If a brand moves to the web app, its numbers get slightly more precise, not different in kind.

If you change a rule in `StockWatch.gs`, change it in `modules/stock-watch/src/engine.js` too (or record the difference here and in the parity test's `ALLOW` list), and update both LOGIC files.

## Changes

- 19 Nov 2026 (critic round 1, X1): the Sheet now has the web app's long-stock-out rate (SW-003). It used to divide by in-stock days in the window only, so a best seller out for 30 days had a rate of 0: ₹0 lost and off the Reorder tab, against ₹1.5 L lost, *Out now*, order 200 in the web app. The logs are kept forever, so the look-back is capped at 120 days to match the web app. Parity fixtures added: out for the last 30 days, and 3 in-stock days in the window. A blank *Stock before* is read as the previous row's *Stock now*, as in the web app (F1).

- 19 Nov 2026 (SW-013): the Lost sales and Reorder tabs counted a whole stock-out that touched the last 30 days (2× the web app in one repro); now clipped to max(start, now − 30 d). A new product's rate starts at its first record, as in the web app. A product with no sales is never on the reorder list. The Daily tab includes the partial first day, so its total equals the web app's 30-day total. The maths moved into `SW.compute()` so it can be tested.
