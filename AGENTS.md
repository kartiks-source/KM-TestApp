# Catalys modules: how to work in this repo

This repo holds small, standalone Catalys tools ("modules"). They're vibe-coded fast, but built so each can go to production without a rewrite. Every agent (Orca, Claude Code, Codex, anything else) reads this file first.

## Layout

```
AGENTS.md                 this file: rules for every module
CLAUDE.md                 imports this file for Claude Code
docs/DEVLOG.md            what changed, when, and why (newest first)
docs/DECISIONS.md         decisions that apply across modules
docs/ORCA.md              how to run several agents in parallel with Orca
modules/<name>/           one folder per module, with its own AGENTS.md
  AGENTS.md               the module's context: purpose, data flow, files, status, next steps
  LOGIC.md                how every number is worked out and why: rule, reason, alternatives, limits
  CLAUDE.md               imports AGENTS.md for Claude Code
Dockerfile                builds the module deployed on Railway (now: stock-watch)
```

| Module | What | Runs on |
|---|---|---|
| `modules/stock-watch` | Stock-out Watch web app: reorder list, ₹ lost to stock-outs, read-only Shopify pull | Railway |
| `modules/stock-watch-sheets` | The same idea as a Google Sheet + Apps Script, fed by Shopify Flow (no server) | Google Sheets |

## Rules

1. **Read the module's `AGENTS.md` before touching it**, and work inside that one folder. A task that spans modules is split into one task per module.
2. **Context lives in Markdown, in the repo.** When you change how a module works, update its `AGENTS.md` in the same commit: what it does, its files, its status, what's next. The next agent should never have to rediscover anything.
3. **Log every change** in `docs/DEVLOG.md`: date, module, what changed and why, and anything left open. Newest first, a few lines each. Add the same line to the shared dev log page, Catalys Modules: Dev Log (https://claude.ai/artifact/27Q6x8r3rpZHYaNzhjW2Zq), which the team reads.
4. **Explain the logic** in the module's `LOGIC.md`: every number the user sees, with its rule, why we chose it, what else we considered and when it can be wrong. Change it in the same commit as the rule, so anyone who questions a number can check it.
5. **Record decisions** that outlive one change (data access, hosting, security) in `docs/DECISIONS.md`, with the date and who decided.
6. **Tests before push:** `npm test` at the root runs every module's tests. Add a test for each new behaviour.
7. **No secrets in git, ever.** Keys go in Railway variables or Azure Key Vault. Never in code, Markdown, logs or Google Sheets.
8. **Shopify is read-only** in every module. Only GraphQL queries are allowed through; no mutations, and no webhooks registered under someone else's app.
9. **One agent, one worktree, one branch.** When several agents run at once in Orca, each gets its own worktree (see `docs/ORCA.md`). Merge to `main` only after tests pass.
10. **A critic reviews every dev cycle.** Before a change is called done, a separate reviewer agent that hasn't seen the builder's reasoning reads the diff, `LOGIC.md` and the running app. It looks for wrong numbers, rules that contradict `LOGIC.md`, edge cases, UX that slows a decision, and anything a demanding expert would send back. The builder fixes what holds up or records why not in `docs/DEVLOG.md`. In Orca, run the critic in its own worktree or agent (see `docs/ORCA.md`).
11. **Stay standalone.** No module reads another team's database. Data comes from Shopify (read-only) into the module's own storage.

## Deploy

- `main` deploys to Railway (project `stock-watch`, service `web`): https://web-production-6dd42b8d.up.railway.app
- Railway builds the root `Dockerfile`, which copies `modules/stock-watch`.
- Variables are listed in `modules/stock-watch/AGENTS.md`.

## Not yet aligned

The plan is to follow the main product's (Performity's) conventions where they help ship to production faster, and keep things separate where they don't. Its repo hasn't been shared with us yet; once it is, record what we adopt in `docs/DECISIONS.md`.
