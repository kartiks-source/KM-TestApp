# 0013. Performity look and feel

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder

## Context

Modules will sit beside the Performity app, and users should feel they're in one product. Performity's code repo isn't shared yet; only its marketing site is visible.

## Decision

Use Performity's visual language: Inter, brand blue #0978BE, pale blue page #EEF3F8, white cards, icon rail, top bar with store picker and Data Sync pill. Tokens live in `modules/stock-watch/public/styles.css`. Code conventions follow Performity's later, by a new ADR, once the repo is shared.

## Consequences

- Visual consistency now without a shared component library.
- Tokens may need a rename once Performity's real design tokens are visible.
