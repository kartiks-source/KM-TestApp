# 0009. One authoritative data source per store

- Status: Accepted (implemented in SW-006, 2026-11-19; founder sign-off still to record)
- Date: 2026-11-19
- Deciders: builder, architect; founder to accept

## Context

Shopify pull, Flow webhooks, Sheet CSV sync and manual import all append to the same arrays. Shopify rows dedupe on `order|line`, others on `order|variant|qty`, so one sale stored both ways counts twice. Sheet sync keeps running after Shopify is connected. Inflated sales inflate reorder cash.

## Decision

Each row records `src`. A store has one live source: when Shopify is connected, Flow ingest, Sheet sync and CSV import are refused with 409 and a plain message. Without Shopify, Flow + Sheet + CSV may coexist (they share one key format). Clear and import return 409 while a pull runs. Demo data is never mixed with live rows (SW-007).

## Consequences

- No double counting; the Data page shows one active source.
- Implementation: rows carry `src` (`shopify`, `flow`, `sheet`, `csv`, `demo`). Rows stored before Shopify was connected stay; the pull replaces every line of each order it reads by order name, so a Flow/CSV copy of an order inside the 60-day backfill is replaced, not doubled.
- Minute-exact Flow stock timing can't be combined with the pull until a later ADR defines merge rules for stock rows only.
