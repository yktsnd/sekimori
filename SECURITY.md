# Security policy

sekimori is a security boundary: people deploy it specifically to keep an
API key private and to enforce budget/abuse limits. Bugs that weaken that
boundary matter more than anything else in this repo.

The guarantees, assumptions, trust boundaries, and deliberate limitations are
documented in [docs/security-model.md](docs/security-model.md). Read that model
before treating a deployment as a spending or credential safety boundary.

## What counts as a vulnerability

- Upstream API key exposure of any kind (logs, error messages, headers,
  responses)
- Auth bypass: using `/v1/*` without a valid invite token, or `/admin/*`
  without the admin key
- Budget or rate-limit bypass (including accounting that silently
  under-counts)
- Fail-**open** behavior where the design says fail-closed (e.g. requests
  succeeding while the store is unhealthy)
- Invite-token plaintext retained or emitted by sekimori anywhere other than
  its one-time `POST /admin/tokens` issuance response (for example in logs,
  persistent state, errors, list APIs, or unrelated responses)

## How to report

Please **do not open a public issue** for the items above. Use GitHub's
private vulnerability reporting at
[`/security/advisories/new`](https://github.com/yktsnd/sekimori/security/advisories/new).
Before the first public release, the maintainer must verify that this route is
enabled and working (see [RELEASING.md](RELEASING.md)). If it is unavailable,
ask the maintainer ([@yktsnd](https://github.com/yktsnd)) for a private
channel without putting vulnerability details in a public issue.

This is a single-maintainer project: expect an acknowledgment within a week,
not hours. Please leave reasonable time for a fix before public disclosure.

## Supported versions

There is no published supported version yet. Before the first tag, security
work targets the explicitly identified reviewed release-candidate commit; do
not assume an older default branch contains the candidate. After the first
public release, security fixes target the latest released version unless its
release notes say otherwise.

## Out of scope

- Volumetric/network/host denial of service. Per-token rate/active limits and
  the process-wide 256-active-message bound are partial resource controls, not
  a DDoS or availability guarantee
- Issues requiring a malicious config file or a compromised host
- The bundled `examples/` mock upstream and demo scripts (never meant for
  production exposure)
