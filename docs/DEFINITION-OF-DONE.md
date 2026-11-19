# Definition of Ready, Definition of Done, PR checklist

## Definition of Ready (before an agent starts)

A backlog item is ready when it has:

- [ ] The problem in the owner's terms: money saved, decision made faster, or profit.
- [ ] Acceptance criteria that can be tested: numbers, a screen state, or a status code.
- [ ] The module named; work across modules split into one item per module.
- [ ] The `LOGIC.md` sections it touches, if any.
- [ ] The data it needs (demo is enough, or a real store is needed).
- [ ] Size S/M/L and an owner role.
- [ ] No blocking dependency (e.g. Key Vault access), or the block is named.
- [ ] Critics that apply (all five by default; docs-only skips UI and mobile).

## Definition of Done (before merge)

- [ ] Every acceptance criterion passes and is covered by a test.
- [ ] `npm test` green locally and in CI; a new test for each new behaviour.
- [ ] `LOGIC.md` updated in the same commit as any rule change; §Known limits re-read.
- [ ] Module `AGENTS.md` updated: files, status, next.
- [ ] ADR added or superseded if the change alters hosting, data access, security, storage or a rule shared across modules.
- [ ] `API.md` / `FORMATS.md` updated if routes or row formats changed.
- [ ] `CHANGELOG.md` entry; version bumped if users see a change (minor when a number's rule changes).
- [ ] No secrets in the diff (`git diff | grep -E 'shpat_|secret|password='` clean).
- [ ] Shopify read-only guard untouched, or changed with tests.
- [ ] Five critics ran on the diff; each finding fixed or rejected with a reason (see PR checklist).
- [ ] UI checked: screenshots at 1280, 1440, 1920 and 390 px; no sideways scroll; default view not bigger than before.
- [ ] `docs/DEVLOG.md` entry: date, module, what and why, open items, commit SHA.
- [ ] Same line added to the shared dev log page (Catalys Modules: Dev Log).
- [ ] After deploy: live SHA recorded; `/health` 200; `/status` shows the new version.

## PR checklist (paste into the PR description)

```
Backlog: SW-___   Size: _   Module: _______
What changed and why (owner terms):

[ ] Acceptance criteria met; tests added: ________
[ ] npm test green (CI link)
[ ] LOGIC.md updated (§__) / not needed because ______
[ ] AGENTS.md status/files/next updated
[ ] ADR: ____ / not needed
[ ] API.md / FORMATS.md / CHANGELOG updated / not needed
[ ] No secrets; read-only guard untouched or tested
[ ] Critics (diff: git diff $BASE..HEAD -- <paths>):
    [ ] Logic        report: docs/reviews/<date>-<branch>/logic.md
    [ ] UI           report: .../ui.md
    [ ] Cross-module report: .../cross-module.md
    [ ] Simplicity   report: .../simplicity.md
    [ ] Mobile critic + fixer: branch ______ merged / nothing to fix
    Each finding: fixed in <sha> / rejected: <reason>
[ ] Screenshots: 1280 / 1440 / 1920 / 390 attached
[ ] DEVLOG entry with SHA + dev log page row added
```
