# 0006. Simple default UI, detail on demand, role views subtract

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder, simplicity critic

## Context

Users range from a CEO glancing on a phone to an ops exec placing POs. Early versions showed many statuses, columns and tabs; the simplicity critic found screens needing a manual. The owner wants a UI anyone can use, no wasted space, Performity look.

## Decision

- Each screen leads with its one decision number (e.g. "Order today ₹X"). Three user-facing statuses. Everything else sits behind the drawer, "More" or an optional column.
- Role views (SW-020) only remove: each role sees a subset of today's default, never extra pages for everyone. A new feature extends an existing control (e.g. "View: Products ▾" for group-by, a chip for Pause/Push) before it gets a tab.
- Every UI change is checked at 1280, 1440, 1920 and 390 px with no sideways scroll.

## Consequences

- Features cost more design thought; some power options stay one click deeper.
- The simplicity and mobile critics have a written rule to reject growth of the default view.
