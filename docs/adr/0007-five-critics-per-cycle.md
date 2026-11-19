# 0007. Five critics every dev cycle

- Status: Accepted
- Date: 2026-11-19
- Deciders: founder

## Context

Modules are built fast by agents. Self-review misses wrong numbers, cluttered screens, phone breakage and drift between modules. Reviewers who see the builder's reasoning anchor on it.

## Decision

Before a change is done, five separate agents review the diff only: logic, UI, cross-module, simplicity, and mobile critic + fixer (the only one that edits, in its own branch; the builder merges). Each reports ranked findings with file:line, CONFIRMED or SUSPECTED. The builder fixes what holds up and records rejections with reasons. Critics get `git diff $BASE..HEAD -- <role paths>`, not a fixed `git log -p -3`. Prompts live in `docs/ORCA.md`; reports are saved under `docs/reviews/` (SW-058).

## Consequences

- Higher token cost per cycle; mitigated by path-limited diffs, compressed reports and a shared prompt prefix.
- Docs-only changes may skip the UI and mobile critics (stated in the PR).
