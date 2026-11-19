# RACI: who decides what in Stock-out Watch

R = does the work, A = answerable (one per decision), C = consulted before, I = informed after.

## Decisions × roles

| Decision | CEO | Founder / COO | Ops / inventory exec | Buyer | Marketing | Finance | Warehouse |
|---|---|---|---|---|---|---|---|
| What to reorder (list + qty) | I | A | R | C | I | C | I |
| Place the PO (supplier, qty, ETA, mark ordered) | – | A | C | R | I | C | I |
| Overstock action (discount, bundle, stop buying, delist) | I | A | R | C | C | C | I |
| Pause / push ads on SKUs | I | C | I | – | A/R | – | – |
| Targets (lost %, overstock ₹, group targets) | C | A/R | C | C | C | C | – |
| Plan assumptions (lead, cover, safety) | – | A | R | C | – | C | – |
| Receive stock / confirm landed | – | I | A | I | I | – | R |

## What each role sees first, and how often

Role views (SW-020) only remove things from today's default screen.

| Role | Lands on | First number | Also sees | Cadence | Pushed to them (SW-028) |
|---|---|---|---|---|---|
| CEO | Overview, 3 tiles | Sales lost to stock-outs (₹, % of demand) vs last period and target | Cash in overstock; trend line | Weekly (Mon) | Monday digest, 5 lines |
| Founder / COO | Overview | Order today ₹ and still-out cost per day | Best sellers at risk, overstock ₹, targets behind, late POs | Daily | 9:00 digest |
| Ops / inventory exec | Reorder → Order today | Number of lines to order today + ₹ | Why cell, order-by date, Mark ordered, trend spark | Daily, several times | 9:00 digest with top lines |
| Buyer | Reorder grouped by supplier (SW-040; until then Order today) | PO total per supplier | Qty, unit cost, ETA, Reorder CSV | Per PO cycle (2–3×/week) | – |
| Marketing | Products → Pause / Push chips | Count of out-now or about-to-run-out items being promoted | Back-in-stock ETA, overstock to push, group-by collection/tag | Daily before ad changes | Pause list in digest |
| Finance | Overview cash view | Cash needed this week vs budget | Overstock ₹ at cost, order value by week | Weekly | Monday digest |
| Warehouse | Ordered list (SW-012) | Lines due to land this week | ETA, qty; late ETAs in red | Daily | – |

## Rules

- One "A" per decision. The app shows the A's number first on that role's home view.
- View-only roles (CEO, finance) use `VIEW_PASSWORD` (SW-029) and can't change assumptions or data.
- "Save as default" on assumptions is the founder's call; ops proposes, finance is consulted on cover days because cover drives cash.
