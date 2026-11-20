# 0012. Single instance on Railway, deploy from a clean main

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder, ops

## Context

Standalone modules run on Railway, separate from the Coolify-hosted dashboard. The store is a file on one volume (ADR-0003), so two instances would overwrite each other. Deploys today are a local `railway up`, which can ship uncommitted files; GitHub auto-deploy waits on app access.

## Decision

One replica, volume at `/data`, `/health` as the Railway health check. Until GitHub auto-deploy with "wait for CI" is on, deploy only with `railway up` from a clean, pushed, green `main`, and record the SHA in DEVLOG. Rollback = redeploy the previous Railway deployment. Each deploy has a few seconds of downtime; deploy outside India's evening peak.

## Consequences

- No horizontal scale; acceptable for one store per deploy.
- Graceful shutdown (SW-004) and backups (SW-005) are required, not optional.
- Revisit with ADR-0003's Postgres trigger or a second store.

## Update 2026-11-20 (SW-055)

One replica is now also enforced in code: `DATA_DIR/instance.lock` (heartbeat 30 s, stale after 2 min). A second copy on the same volume serves reads and refuses writes with 503 and the reason, and takes over when the first stops or goes quiet. Chosen over refusing to start, so a slow-stopping old deployment can't crash-loop the new one.
