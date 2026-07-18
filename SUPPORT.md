# Support

sekimori is a small, self-hosted gateway maintained on a best-effort basis.
There is no paid support plan or response-time promise.

## Before opening anything

1. Run `sekimori doctor <config> --json` and check the failed check names.
2. Reproduce with the offline mock upstream where possible:
   `npm run demo` (or `bash examples/demo.sh` on a POSIX shell).
3. Read [README.md](README.md), [AGENTS.md](AGENTS.md),
   [docs/configuration.md](docs/configuration.md), and
   [docs/api.md](docs/api.md). Security-boundary questions are covered in
   [docs/security-model.md](docs/security-model.md).

If startup reports `<state>.lock`, do not delete it reflexively. First verify
whether another sekimori process uses that exact state path and stop that
process normally. Remove the lock only after confirming a hard crash left it
stale and no process owns the state; then restart once, not as a second replica.

## Where to ask

- **A reproducible defect:** use the Bug report template. Include the
  sekimori version/commit, Node.js version, OS, redacted config, and the
  smallest offline reproduction you can provide.
- **A question or setup problem:** use the Question / support template. Keep
  it public only if it contains no credentials, invite tokens, personal data,
  or private endpoint URLs.
- **A proposed change:** use the Feature request template only after checking
  [ROADMAP.md](ROADMAP.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
- **A security vulnerability:** follow [SECURITY.md](SECURITY.md). Do not
  disclose it in an issue.

Never paste an upstream API key, `SEKIMORI_ADMIN_KEY`, or an invite token into
an issue, pull request, log, screenshot, or chat transcript.

## Scope of help

We can help clarify documented behaviour and investigate reproducible defects
in sekimori. We cannot safely operate a user's host, account, billing setup,
or private credentials. Deployment recipes are intentionally withheld until
they have been executed and verified; see [ROADMAP.md](ROADMAP.md).
