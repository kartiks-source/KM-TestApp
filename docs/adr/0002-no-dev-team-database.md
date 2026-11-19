# 0002. No connection to the dev team's database

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder

## Context

Performity's dev team runs its own Azure database with Shopify data. Reading it would be faster to start, but couples our release cycle, schema and security to theirs, and puts our load on their production DB.

## Decision

No module reads or writes another team's database. Each module pulls from Shopify (read-only, ADR-0001) or brand-run feeds (Flow, Sheet, CSV) into its own storage.

## Consequences

- Modules ship and deploy independently; their failures stay contained.
- We duplicate some ingestion work and keep our own history (stock changes are only seen by us, so backups matter: SW-005).
- Order history is limited to what `read_orders` returns (60 days) unless `read_all_orders` is granted.
- Revisit only by a new ADR with founder sign-off, e.g. if Performity exposes a read-only API.
