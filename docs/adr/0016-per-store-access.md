# 0016. Per-store access: people made by the owner, scrypt hashes in DATA_DIR/access.json

- Status: Accepted
- Date: 2026-11-20
- Deciders: owner (multi-store spec 20 Nov 2026, SW-062); builder (storage, session and route rules)

## Context

ADR-0015 put several brands in one app, but `ADMIN_PASSWORD` and `VIEW_PASSWORD` open every store. A brand's own people must see only their store, and the owner must be able to take one person's access away without changing everyone's password. There is no user database (ADR-0002), Performity SSO isn't available (SW-060), and the app runs as one instance with JSON files on a volume (ADR-0003, ADR-0012).

Options considered:
1. **One password per store** (env variables). No names in the change log, a leaver means a new password for everyone in that store, and every change needs a redeploy. Rejected.
2. **Performity SSO** (SW-060). Right long term; not offered yet.
3. **People made by the owner in the app**, each with a generated password stored as a hash in `DATA_DIR/access.json`. Chosen.

## Decision

- Only the owner (`ADMIN_PASSWORD`, signed in without a person) manages people, in Data → People and `/api/people`. A person = name, role `admin` or `view`, and one or more listed stores.
- Passwords are generated (`<8-char id>-<20 random base64url chars>`, 120 random bits), shown once, stored only as scrypt (N 16384, r 8, p 1, 16-byte salt). The id prefix picks the one hash to check, so a sign-in costs one scrypt whatever the number of people. Same sign-in form, Basic auth and wrong-password limiter as the main passwords.
- Session cookie `exp.p.<id>.<gen>.sig` with the existing session key. Every request looks the person up again: removed → signed out; new password bumps `gen` → old sessions end; role and store changes apply at once.
- Every store-scoped route goes through one pick: `?store=` outside the person's list → 403 (unknown ids too, so ids can't be probed); a remembered store that isn't theirs → their first store; `/api/stores` lists only theirs. Digest and exports are store routes, so the rule covers them. A `view` person gets the view-only gate (ADR-0011 / SW-029).
- The change log records the person's name. Logs carry the person id only (no names, never a password).
- `access.json` is written atomically with mode 600 and a `.bak` of the previous copy; a broken or newer file turns per-store sign-ins off and is never written over. It is not in the per-store backups (it is for every store).
- `ADMIN_PASSWORD` and `VIEW_PASSWORD` behave exactly as before.

## Consequences

- Easier: a brand's people get their own sign-in in a minute with no deploy; one person can be cut off alone; the change log says who.
- Harder: the owner hands out passwords by hand (no email, no self-service reset). One more file on the volume to keep (Railway volume backups cover it).
- Revisit when: Performity SSO arrives (SW-060): people would map to Performity users and their brands, and `access.json` would go.
