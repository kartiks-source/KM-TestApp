# Module standard

Every folder under `modules/<name>/` meets this checklist. "If" items apply only when the condition holds. A new module copies the structure of `modules/stock-watch` once it passes this list.

## Files

- [ ] `README.md`: what it does, how to run, how to deploy (for humans).
- [ ] `AGENTS.md`: purpose, data flow, files table, status (with date and owner), next steps. Agents read this first.
- [ ] `CLAUDE.md`: one line, `@AGENTS.md`.
- [ ] `LOGIC.md`: every number a user sees: rule, why, alternatives, when it's wrong; one "Known limits" section.
- [ ] `CHANGELOG.md`: user-facing changes, semver; version in `package.json` matches the latest heading.
- [ ] `test/` wired into the root `npm test`.
- [ ] `.env.example` lists every `process.env` the code reads, with no real values.
- [ ] If it serves HTTP: `API.md` (method, path, auth, request, response, errors; destructive routes marked) and `SECURITY.md` (or a section linking the root one).
- [ ] If we deploy it: `RUNBOOK.md` (deploy, rollback, backup, restore, alerts, symptom → action).
- [ ] If it reads or writes rows or a stored file: row and store formats in `FORMATS.md`, with a `schemaVersion`.
- [ ] Decisions that outlive one change are ADRs in `docs/adr/`.

## Tests

- [ ] Unit tests for every rule in `LOGIC.md` (one named test per rule).
- [ ] Parser tests: table-driven, including bad input (wrong headers, blank, locale numbers, bad dates).
- [ ] If HTTP: in-process route tests on a temp `DATA_DIR`: auth, 400/401/403/409/413/429 paths, every write route.
- [ ] Scale test at 10× the largest expected store (no crash, time budget asserted).
- [ ] If UI: Playwright smoke at 1440×900 and 390×844 (no console error, no sideways scroll, main flows).
- [ ] If the same rule exists in another module: a parity test with an allowlist of intended differences.
- [ ] CI runs `npm test` on every push and PR.

## Ops

- [ ] `/health` checks real state (store loaded, last save ok); returns 503 otherwise.
- [ ] `/status` (no secrets) shows version, commit, data age, last error; 503 when data is stale.
- [ ] Graceful shutdown on SIGTERM: stop timers, flush writes, close server. Runs under an init (tini or `--init`).
- [ ] Durable writes: temp file + fsync + rename; a bad read never becomes an empty store.
- [ ] Backups: daily, kept ≥ 7 days, plus before every destructive action; one restore drill done.
- [ ] An external uptime monitor watches `/health` and `/status`.
- [ ] Logs are one-line JSON, never contain secrets or query strings.

## Security baseline

- [ ] No secrets in git, Markdown, logs or Sheets; secrets in Key Vault or Railway variables.
- [ ] Shopify is read-only: only GraphQL queries pass the guard; tokens with write scopes are refused.
- [ ] Fails closed: refuses to start in production without auth configured.
- [ ] Login rate-limited on every path (form and Basic), keyed on the trusted proxy hop.
- [ ] Security headers (CSP, nosniff, HSTS, frame-ancestors none); non-GET routes require same origin.
- [ ] Input limits per route; bad input → 4xx, never 500.
- [ ] Exports guard against spreadsheet formula injection.
- [ ] Secrets never travel in URLs (headers only).
- [ ] No connection to any other team's database (ADR-0002).

## Declaring a module production-ready

A module is production-ready when all of these hold, and the founder signs it off in `docs/DECISIONS.md`:

1. Every checklist item above that applies is ticked, with links in the module `AGENTS.md` Status.
2. No open P0 or P1 in `docs/BACKLOG.md` for the module.
3. Five critics have run on the release with no unresolved CONFIRMED finding.
4. A real store has run for 7 days, and 10 SKUs' orders and stock match Shopify admin.
5. A backup restore drill has been done and logged in DEVLOG.
6. Deploy is from a clean, green `main`, and the live SHA and version are visible in `/status`.
