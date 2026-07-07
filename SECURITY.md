# Security policy

sekimori is a security boundary: people deploy it specifically to keep an
API key private and to enforce budget/abuse limits. Bugs that weaken that
boundary matter more than anything else in this repo.

## What counts as a vulnerability

- Upstream API key exposure of any kind (logs, error messages, headers,
  responses)
- Auth bypass: using `/v1/*` without a valid invite token, or `/admin/*`
  without the admin key
- Budget or rate-limit bypass (including accounting that silently
  under-counts)
- Fail-**open** behavior where the design says fail-closed (e.g. requests
  succeeding while the store is unhealthy)
- Invite-token plaintext appearing anywhere other than the single
  `POST /admin/tokens` response

## How to report

Please **do not open a public issue** for the items above. Use GitHub's
private vulnerability reporting ("Report a vulnerability" under the
Security tab of this repository). If that is unavailable to you, contact the
maintainer ([@yktsnd](https://github.com/yktsnd)) through a private channel.

This is a single-maintainer project: expect an acknowledgment within a week,
not hours. Please leave reasonable time for a fix before public disclosure.

## Out of scope

- Denial of service against your own sekimori instance by your own invited
  users beyond the configured rate limit (the rate limit *is* the mitigation)
- Issues requiring a malicious config file or a compromised host
- The bundled `examples/` mock upstream and demo scripts (never meant for
  production exposure)
