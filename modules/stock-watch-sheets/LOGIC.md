# Stock Watch (Google Sheet): logic

Same rules, settings and thresholds as the web app, explained in full in [`../stock-watch/LOGIC.md`](../stock-watch/LOGIC.md). Read that file for why each rule is what it is.

The differences:

- **The window is a fixed 30 days,** and a stock-out that started before it is counted in full. The web app counts only the hours inside the selected period.
- **₹ lost values every hour of a stock-out equally.** The web app weights each hour by how busy that hour usually is for the store (its section 4a). So a stock-out mostly overnight costs more here than in the web app, and one mostly in the evening costs less. A stock-out lasting whole days comes out the same in both.

Why: Apps Script runs every 15 minutes inside a Sheet with a time limit, and the hour-of-day pattern needs every order line of the last 60 days on each run. Keeping the Sheet simple was worth the small difference. If a brand moves to the web app, its numbers get slightly more precise, not different in kind.

If you change a rule in `StockWatch.gs`, change it in `modules/stock-watch/src/engine.js` too (or record the difference here), and update both LOGIC files.
