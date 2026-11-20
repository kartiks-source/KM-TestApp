# 0018. Supplier terms per store; budget cut is one line by profit kept per ₹

- Status: Accepted
- Date: 2026-11-20
- Deciders: builder (Sprint 3 A-money), product

## Context

Order quantities used one store-wide lead time and ignored minimum orders and case packs, so every PO was fixed by hand (SW-040). When cash can't cover the whole reorder list, the page gave no order of priority (SW-041). The app is read-only on Shopify (ADR-0001): Shopify has a product vendor but no supplier terms, and most stores have no purchase-order API. Options for terms: Shopify metafields (needs write access or manual setup per product), a sheet column, or our own per-store file. Options for the budget: knapsack (best total profit, but rows jump around and a buyer can't follow it), or rank by profit kept per ₹ and cut once.

## Decision

We will keep supplier terms (lead time, MOQ, case pack) and a SKU → supplier map in our own `DATA_DIR/stores/<id>/suppliers.json` (a side file like `onorder.json`, in backups), editable by admins on Data → Suppliers and by CSV. A product's supplier is the mapped one, else its Shopify vendor. Order qty is the §6 quantity rounded **up** to the MOQ and then to whole case packs; a supplier's lead time replaces the store's for that product.

We will rank Reorder rows by profit kept per ₹ (profit lost over lead time + days to last without the order ÷ order cost) and draw **one** cut line: the first row that doesn't fit and all rows below it are over budget. The budget is a per-browser setting; the CSV takes it as `?budget=` so the file matches the page.

## Consequences

- POs are ready to send per supplier; the cash added by rounding is shown, never hidden.
- Terms live outside Shopify: a supplier change in Shopify (vendor rename) shows as a new supplier without terms until mapped.
- The cut can leave cash unused when a big row sits just below the line; a buyer can still tick it. Revisit if users ask for "fill the rest".
- The budget isn't shared across the team (no server storage); revisit if a buyer and an owner need the same number (store it in settings, admin-only).
