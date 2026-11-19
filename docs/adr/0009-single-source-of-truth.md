# 0009. One authoritative data source per store

- Status: Proposed (implement in SW-006)
- Date: 2026-11-19
- Deciders: builder, architect; founder to accept

## Context

Shopify pull, Flow webhooks, Sheet CSV sync and manual import all append to the same arrays. Shopify rows dedupe on `order|line`, others on `order|variant|qty`, so one sale stored both ways counts twice. Sheet sync keeps running after Shopify is connected. Inflated sales inflate reorder cash.

## Decision

Each row records `src`. A store has one live source: when Shopify is connected, Flow ingest, Sheet sync and CSV import are refused with 409 and a plain message. Without Shopify, Flow + Sheet + CSV may coexist (they share one key format). Clear and import return 409 while a pull runs. Demo data is never mixed with live rows (SW-007).

## Consequences

- No double counting; the Data page shows one active source.
- Minute-exact Flow stock timing can't be combined with the pull until a later ADR defines merge rules for stock rows only.
