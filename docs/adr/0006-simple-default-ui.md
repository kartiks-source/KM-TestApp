# 0006. Simple default UI, detail on demand, role views subtract

- Status: Accepted (amended 2026-11-20: show everything by default)
- Date: 2026-11-19
- Deciders: founder, simplicity critic

## Context

Users range from a CEO glancing on a phone to an ops exec placing POs. Early versions showed many statuses, columns and tabs; the simplicity critic found screens needing a manual. The owner wants a UI anyone can use, no wasted space, Performity look.

## Decision

- Each screen leads with its one decision number (e.g. "Order today ₹X"). Three user-facing statuses. Everything else sits behind the drawer, "More" or an optional column.
- Role views (SW-020) only remove: each role sees a subset of today's default, never extra pages for everyone. A new feature extends an existing control (e.g. "View: Products ▾" for group-by, a chip for Pause/Push) before it gets a tab.
- Every UI change is checked at 1280, 1440, 1920 and 390 px with no sideways scroll. The default columns always fit; only when someone adds optional columns that can't fit does that one table scroll inside its box, with a note (2026-11-20, critic r2 UI-2): a chosen column is never silently cut off.

### Amendment, 2026-11-20 (owner): show everything by default

The owner asked that nothing be hidden until someone chooses to hide it:

- **Role "All" is the default** (no role chosen = every page, every panel, every column). Roles stay optional and still only remove.
- **Reorder opens on the All tab**, not Order today (roles with a home tab still land on it: ops/buyer → Order today, warehouse → Ordered).
- **Optional columns are on by default.** Columns… now unticks (remembered per browser, `sw-cols-off`). On a screen too narrow for all of them, optional columns **step aside** (the right-most first) until the table fits, and a one-line note names them; the existing priority columns (`p2`–`p4`) still step aside by width. So the page never scrolls sideways at 1280–1920; only a column a person has dragged wider can still make one table scroll inside its box.
- **Overview shows every panel** (four tiles, Order today, Biggest losses, Moving, daily chart).

The decision number still leads every screen; "detail on demand" now means the drawer and folds, not hidden columns.

## Consequences

- Features cost more design thought; some power options stay one click deeper.
- The simplicity and mobile critics have a written rule to reject growth of the default view.
