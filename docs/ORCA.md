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

## Finishing

1. Each agent runs `npm test` and updates the module `AGENTS.md` and `docs/DEVLOG.md`.
2. Review the diff in Orca, merge to `main`, push. Railway deploys `main`.
3. Remove the worktree: `orca worktree rm <name>`.
