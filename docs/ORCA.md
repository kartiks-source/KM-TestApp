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

## The five critics (every dev cycle)

Every change gets five reviews from agents that didn't write it (AGENTS.md rule 10). Point them at the diff and the rules, not at the builder's explanation, so their read isn't anchored. Run them in parallel, each in its own worktree.

Give each critic only the diff of the paths it judges, from where the branch left `main`, not `git log -p` (which pulls in unrelated history and costs tens of thousands of tokens):

```bash
BASE=$(git merge-base main HEAD)
git diff $BASE..HEAD -- <role paths>
```

| Critic | Role paths |
|---|---|
| Logic | `modules/*/src modules/*/LOGIC.md modules/stock-watch-sheets/StockWatch.gs` |
| UI | `modules/stock-watch/public` |
| Cross-module | `modules docs/DECISIONS.md docs/adr` |
| Simplicity | `modules/stock-watch/public` |
| Mobile | `modules/stock-watch/public` |

**1. Logic critic: the numbers**

```bash
orca worktree create --repo name:Stock-Watch --name critic-logic --agent codex \
  --prompt "You are the logic critic. Read AGENTS.md and modules/<module>/LOGIC.md, then the diff: BASE=\$(git merge-base main HEAD); git diff \$BASE..HEAD -- modules/*/src modules/*/LOGIC.md modules/stock-watch-sheets/StockWatch.gs. Run npm test and load src/engine.js in node to check numbers. Report, most serious first, CONFIRMED vs SUSPECTED with file:line: formulas that don't match LOGIC.md, wrong windows, cost vs price mix-ups, NaN/edge cases, anything that would mislead a decision. Don't fix anything."
```

**2. UI critic: the running app**

```bash
orca worktree create --repo name:Stock-Watch --name critic-ui --agent claude \
  --prompt "You are the UI critic. Read the diff: BASE=\$(git merge-base main HEAD); git diff \$BASE..HEAD -- modules/stock-watch/public. Run the app (cd modules/stock-watch && DATA_DIR=\$(mktemp -d) PORT=4640 node server.js). Screenshot every page at 1280, 1440, 1920 and 390x844 (playwright cli; node modules/stock-watch/test/smoke/smoke.js covers the basics). Report: wasted space, sideways scroll, unclear labels, decision number not prominent, Performity inconsistency, touch targets, accessibility. Page + viewport + fix for each. Don't fix anything."
```

**3. Cross-module critic: same rule, same answer**

```bash
orca worktree create --repo name:Stock-Watch --name critic-modules --agent codex \
  --prompt "You are the cross-module critic. Read the diff: BASE=\$(git merge-base main HEAD); git diff \$BASE..HEAD -- modules docs/DECISIONS.md docs/adr. Compare every business rule across modules/* (and LOGIC.md files, DECISIONS.md), and against the client's existing tools where known. modules/stock-watch/test/parity.test.js checks the Sheet against the web app; the differences allowed are listed in modules/stock-watch-sheets/LOGIC.md. Report rule differences, undocumented ones, doc/code drift, and what should become shared code so modules don't fork. file:line both sides. Don't fix anything."
```

**4. Simplicity critic: is it easy for anyone?**

```bash
orca worktree create --repo name:Stock-Watch --name critic-simple --agent claude \
  --prompt "You are the simplicity critic. Read the diff: BASE=\$(git merge-base main HEAD); git diff \$BASE..HEAD -- modules/stock-watch/public. Run the app and look at every screen. For each: its one job, the number that should dominate, what competes with it, concepts a user must learn, jargon. Propose what to cut, merge or hide behind More, with plain wording, and a default-vs-detailed spec per screen. Don't fix anything."
```

**5. Mobile critic and fixer: works in its own worktree, the builder merges**

```bash
orca worktree create --repo name:Stock-Watch --name mobile-fix --agent claude \
  --prompt "You are the mobile critic and fixer. Read the diff: BASE=\$(git merge-base main HEAD); git diff \$BASE..HEAD -- modules/stock-watch/public. Run the app at 390x844 (and 360x740). Find what's hard on a phone: decision not first, tiny touch targets (<44px), crowded rows, sideways scroll, long lists, text that needs zooming. Fix them in this worktree (public/app.js, public/styles.css), keep desktop unchanged (check 1280 and 1440 still have no sideways scroll), run npm test, commit on this branch with a summary of each fix."
```

The builder fixes what holds up and notes anything rejected (and why) in `docs/DEVLOG.md`.

## Finishing

1. Each agent runs `npm test` and updates the module `AGENTS.md` and `docs/DEVLOG.md`.
2. Review the diff in Orca, merge to `main`, push, and wait for CI (GitHub Actions "test") to go green.
3. Deploy is manual (ADR-0012): from a clean, green `main`, run `railway up` at the repo root, then check `/health` and record the SHA in `docs/DEVLOG.md`. Steps and rollback: `docs/RUNBOOK.md`. Pushing to `main` does not deploy.
4. Remove the worktree: `orca worktree rm <name>`.
