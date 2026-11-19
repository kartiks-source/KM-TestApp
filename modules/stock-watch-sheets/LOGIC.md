# Stock Watch (Google Sheet): logic

The core rules match the web app: stock-out episodes, sales per in-stock day, status thresholds, order quantity, small top-up, out again, slow-seller cutoff. They're explained in [`../stock-watch/LOGIC.md`](../stock-watch/LOGIC.md). The two versions were run side by side on the same data on 19 Nov 2026: statuses and order quantities matched on all 255 products.

The differences, all checked against the code:

- **No trend, best sellers (A/B/C), profit lost or overstock.** Those exist only in the web app.
- **Order value is at selling price.** The Sheet has no unit cost, so its "Order value" is roughly twice the web app's cash-at-cost figure for the same order.
- **The reorder list isn't sorted with best sellers first** within each status.
- **Repeated rows aren't dropped,** so pasting overlapping orders counts them twice (see SETUP.md).
- **What counts as a sale** depends on what the Flow sends: cancelled orders, test orders, refunds and order-level discounts are whatever the template writes. The web app's Shopify pull handles all four.
- **Day boundaries** follow the Sheet's time zone setting, and the daily split of a stock-out is hour by hour (up to an hour off at midnight).
- **Order lines with no variant** (custom items) are grouped as one blank product; the web app drops them.
- **Tabs count ₹ lost differently from each other:** Daily cuts stock-outs to the last 30 days, but the Lost sales and Reorder tabs count whole stock-outs that touch those 30 days. That's the next bullet.

- **The window is a fixed 30 days,** and a stock-out that started before it is counted in full. The web app counts only the hours inside the selected period.
- **₹ lost values every hour of a stock-out equally.** The web app weights each hour by how busy that hour usually is for the store (its section 4a). So a stock-out mostly overnight costs more here than in the web app, and one mostly in the evening costs less. A stock-out lasting whole days comes out the same in both.

Why: Apps Script runs every 15 minutes inside a Sheet with a time limit, and the hour-of-day pattern needs every order line of the last 60 days on each run. Keeping the Sheet simple was worth the small difference. If a brand moves to the web app, its numbers get slightly more precise, not different in kind.

If you change a rule in `StockWatch.gs`, change it in `modules/stock-watch/src/engine.js` too (or record the difference here), and update both LOGIC files.
