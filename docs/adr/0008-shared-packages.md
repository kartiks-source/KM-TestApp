# 0008. Shared packages for multi-module logic

- Status: Proposed
- Date: 2026-11-19
- Deciders: founder (pending), cross-module critic

## Context

Episodes, rate and plan are copied between `engine.js` and `StockWatch.gs` and have drifted (₹ lost 2× in one repro, no launch window, no A-override, different time zone handling). Status lists and CSV builders are repeated inside stock-watch. The Sheet runs only in Apps Script and never feeds the server.

## Decision

- Now: a parity test (SW-013) runs the same fixtures through both implementations, with an allowlist of intended differences. New drift fails `npm test`.
- When a second server-side module reuses the logic: create npm workspaces `packages/stock-rules`, `packages/rows`, `packages/shopify-read`, each with its tests and LOGIC section; a build step inlines `stock-rules` into the .gs; the Dockerfile copies `packages/`. Semver per package.

## Consequences

- No big refactor before production; drift is caught by a test instead of prevented by structure.
- Revisit as soon as a third copy of any rule appears.
