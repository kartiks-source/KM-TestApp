# 0010. Current-stock snapshot separate from change history

- Status: Accepted (implemented in SW-002, 2026-11-19)
- Date: 2026-11-19
- Deciders: builder, architect

## Context

The pull writes a stock row only when quantity changes, and the 120-day prune deletes old rows, so an item that hasn't moved in 120 days loses its only row and vanishes from Overstock. Archived items keep stale rows; cost and price only update on a stock move.

## Decision

Keep `db.catalog` (variant → product ID, attributes, tags, price, cost, status, current stock, seenAt), replaced on every pull. Stock rows are change history only. Retention: change history 120 days, but prune always keeps the newest row per variant and the opening row of any open stock-out. Inactive variants are flagged and excluded from reorder and overstock.

## Consequences

- Dead stock and current cost are always present; profit maths uses today's cost.
- Catalog also carries product ID and tags, which group-by (SW-022) needs.
- Implementation notes: the catalog lives in `store.json` as `catalog` and is written only after a complete stock pull. Inactive = product not ACTIVE, inventory untracked, or missing from the pull (kept as `DELETED` for 120 days). `inactiveSince` = first pull that saw it inactive; an open stock-out ends there.
- One more structure to back up and migrate (schemaVersion, SW-047).
