# 0011. Auth: one admin password, signed cookie, hardened

- Status: Accepted (hardening in SW-008, view role in SW-029)
- Date: 2026-11-19
- Deciders: founder, security

## Context

The app shows a brand's sales and cost and can wipe data. It uses one `ADMIN_PASSWORD`, a sign-in page and a 30-day signed cookie; Basic auth also works on `/api`. Review found unlimited Basic guessing, a spoofable lockout IP, fail-open when the password is unset, and the password as HMAC key.

## Decision

Keep one shared admin password for now, hardened: one limiter for form and Basic auth keyed on the trusted proxy hop plus a global cap; refuse to start in production without a ≥ 12-char password; HMAC keyed by a random secret in `/data/secret` plus a password fingerprint; POST logout. Next step: `VIEW_PASSWORD` for read-only sessions with server-side write rejection and a settings change log. Named users / Performity SSO is a later ADR.

## Consequences

- Simple to run; no user database.
- No per-person audit until named users exist; "by" on orders comes from a remembered name.
- Changing the password signs everyone out (documented in SECURITY.md).
