# 0005. Sales rate = demand per in-stock day

- Status: Accepted (amended by SW-003)
- Date: 2026-11-19
- Deciders: founder, logic critic

## Context

Reorder qty, ₹ lost and trend all rest on "sales per day". Dividing by calendar days makes every stock-out shrink the next order, so the product runs out sooner next time. Windows of 7 days are too jumpy for slow sellers; 90 days reacts too slowly to seasons and campaigns.

## Decision

- Rate = units sold in the last 28 days ÷ days in stock in those 28 days (min 1). A product's window starts at its first record, so new launches aren't diluted.
- Amendment (SW-003): when the product had < 7 in-stock days in the window, use its most recent 28 in-stock days within KEEP_DAYS; if none, the rate before the stock-out began. Without this, a best seller out for a month shows rate 0, ₹0 lost and no reorder.
- Trend uses the same principle: 14 vs 14 in-stock days against a median-product baseline, not week-on-week.

## Consequences

- Stock-outs no longer feed a shrinking-order loop; long stock-outs stay on Reorder and in ₹ lost.
- The rate lags sudden peaks (e.g. right after Diwali); users can shorten the window.
- The Sheet must apply the same rule (parity test, SW-013).
