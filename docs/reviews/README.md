# Critic reports

Each dev cycle's critics (AGENTS.md rule 10, prompts in `docs/ORCA.md`) save their report here, so the next agent reads the findings instead of re-running a review.

- **File name:** `YYYY-MM-DD-<sprint or stream>-<critic>.md`, e.g. `2026-11-20-sprint3-D-ops-logic.md`. Critics: `logic`, `ui`, `cross-module`, `simplicity`, `mobile`.
- **Content:** the ranked findings as given (ID, severity, file:line, confirmed / suspected, one line each). No screenshots (they go in `SMOKE_OUT`, outside git).
- **After the fixes:** the builder adds one line under each finding: `fixed <sha>`, `rejected: <reason>`, or `open: SW-0xx`. The DEVLOG entry links the report instead of copying it.
- **Never** put secrets, tokens, customer data or personal details in a report.

Old reports stay as they are; they are history, not instructions.
