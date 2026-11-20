# 0016. /api/v1 is the stable contract for other tools

- Status: Accepted
- Date: 2026-11-20
- Deciders: builder (Sprint 3 E-data), architect review A11 / process F10

## Context

Other Catalys tools want Stock-out Watch's numbers (₹ lost, what to order). Until now the only API was the page's own `/api/*`, which changes whenever the page needs it (API.md said "may change between minor versions"). `/api/report` is also large (every product row, the daily chart), too big for a dashboard tile that wants five numbers, and has no paging for a tool that wants every row. Options: a separate API server; copying each route under a new prefix; one path rewrite in front of the existing routes.

## Decision

We will answer every `/api/<x>` route also at `/api/v1/<x>` by rewriting the path before routing (`src/apiv1.js` `rewrite`), after the cross-site check, so auth, store pick, view-only gate and handler are exactly the same; the old paths stay for the page. Within v1 we only add routes and fields; a breaking change goes to `/api/v2/` with v1 kept alongside for at least one minor version. Two routes exist only under v1: `GET /api/v1/summary` (headline numbers, the report's `totals`) and `GET /api/v1/rows` (one view, paged by a cursor in variant-ID order, max 500 a page). API.md §v1 is the contract.

## Consequences

- Other tools get a small summary and pageable rows without a second server or a second copy of any rule; a test checks v1 answers equal the old paths and that summary numbers equal `totals`.
- Every change to an `/api/*` answer is now a v1 change too: rename or remove nothing; add fields only. Reviewers check API.md §v1 on every route change.
- Rows are in ID order, not ₹ order: callers sort themselves. A walk sees each row once, but rows added behind the cursor wait for the next walk.
- Auth is still the shared password (ADR-0011): a tool holds the view password. Per-tool keys come with SW-060 (named users / SSO).
