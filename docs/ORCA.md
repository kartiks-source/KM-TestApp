# Running several agents at once with Orca

Code from Orca rather than from one tool's own app, so you can switch tools (Claude Code, Codex, others) at any point. The context is in the repo's Markdown files, not in any one tool's memory.

## The idea

One task, one agent, one worktree. A worktree is a separate checkout of this repo on its own branch, so parallel agents never edit the same files.

## Start parallel agents

From the Orca app: open the Stock-Watch project and create a workspace per task. Or from a terminal:

```bash
# one worktree + agent per task, each on its own branch from main
orca worktree create --repo name:Stock-Watch --name sw-alerts \
  --agent claude --prompt "Read AGENTS.md and modules/stock-watch/AGENTS.md. Task: alert when a Shopify pull fails or data is stale. Add tests, update the module AGENTS.md and docs/DEVLOG.md."

orca worktree create --repo name:Stock-Watch --name sw-postgres \
  --agent codex --prompt "Read AGENTS.md and modules/stock-watch/AGENTS.md. Task: plan moving src/store.js to Postgres; write the plan into the module AGENTS.md under Next. No code yet."

orca worktree ps          # what every worktree/agent is doing
orca agent list           # open agents with their session IDs
orca agent read <id>      # what an agent said
```

`orca agent installed` lists the agent IDs you can pass to `--agent`.

## Good tasks to run in parallel

- Different modules, or different files in one module (UI vs engine vs Shopify pull).
- One agent builds, another reviews the diff, a third writes tests.

Keep tasks touching the same file in one agent.

## The three critics (every dev cycle)

Every change gets three reviews from agents that didn't write it. Point them at the diff and the rules, not at the builder's explanation, so their read isn't anchored. Run them in parallel, each in its own worktree:

```bash
# 1. Logic critic: the numbers
orca worktree create --repo name:Stock-Watch --name critic-logic --agent codex \
  --prompt "You are the logic critic. Read AGENTS.md and modules/<module>/LOGIC.md, then the diff (git log -p -3). Run npm test and load src/engine.js in node to check numbers. Report, most serious first, CONFIRMED vs SUSPECTED with file:line: formulas that don't match LOGIC.md, wrong windows, cost vs price mix-ups, NaN/edge cases, anything that would mislead a decision. Don't fix anything."

# 2. UI critic: the running app
orca worktree create --repo name:Stock-Watch --name critic-ui --agent claude \
  --prompt "You are the UI critic. Run the app (cd modules/stock-watch && DATA_DIR=\$(mktemp -d) PORT=4640 node server.js). Screenshot every page at 1280, 1440, 1920 and 390x844 (playwright cli). Report: wasted space, sideways scroll, unclear labels, decision number not prominent, Performity inconsistency, touch targets, accessibility. Page + viewport + fix for each. Don't fix anything."

# 3. Cross-module critic: same rule, same answer
orca worktree create --repo name:Stock-Watch --name critic-modules --agent codex \
  --prompt "You are the cross-module critic. Compare every business rule across modules/* (and LOGIC.md files, DECISIONS.md), and against the client's existing tools where known. Report rule differences, undocumented ones, doc/code drift, and what should become shared code so modules don't fork. file:line both sides. Don't fix anything."
```

The builder fixes what holds up and notes anything rejected (and why) in `docs/DEVLOG.md`.

## Finishing

1. Each agent runs `npm test` and updates the module `AGENTS.md` and `docs/DEVLOG.md`.
2. Review the diff in Orca, merge to `main`, push. Railway deploys `main`.
3. Remove the worktree: `orca worktree rm <name>`.
