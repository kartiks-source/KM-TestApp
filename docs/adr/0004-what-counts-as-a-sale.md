# 0004. What counts as a sale

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder, logic critic

## Context

The client already reads sales in the DAWBU dashboard. If our sales differ, every number derived from them (rate, ₹ lost, reorder qty) is distrusted. Shopify orders include cancellations, test orders, refunds, line and order-level discounts, and later edits.

## Decision

For the Shopify pull: cancelled orders (also when cancelled later) and test orders are left out; units are `currentQuantity` (refunds and removed items netted); price is `discountedUnitPriceAfterAllDiscountsSet` (line and order discounts); orders updated since the last run (30-min overlap) are re-read and replace their lines. Variants are keyed by ID, not title. Flow, Sheet and CSV rows are taken as sent. Full table in `modules/stock-watch/LOGIC.md` §1.

## Consequences

- Totals match DAWBU; per-product rows can differ where two products share a title (DAWBU merges by title; we don't).
- Flow/CSV sales are only as clean as the template; LOGIC §11 must say so per source (SW-015).
- Mixing sources double-counts unless ADR-0009 is applied.
