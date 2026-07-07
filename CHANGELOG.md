# Changelog

All notable changes to sekimori are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once published to npm.

## [Unreleased] — v0.2 "distribution-ready"

### Added
- Sustainability review, roadmap, and governance docs (CONTRIBUTING,
  SECURITY, issue/PR templates)
- Current-truth reference docs: `docs/configuration.md`, `docs/api.md`,
  `docs/design.md`
- npm packaging: `npm run build` compiles to `dist/` (ESM), a `sekimori`
  bin, package metadata (`files`, `engines`, `license`, `repository`,
  `prepublishOnly`), and `test/pack-smoke.sh` / `npm run test:pack` verifying
  `npm pack` -> install -> boot -> HTTP round trip against a packed tarball.
  Version is `0.2.0-dev.0`; the registry publish itself remains a v0.3
  human-gated step.

### Changed
- English is now the primary language (README landing + `README.ja.md`)
- Round records moved to `docs/history/` (frozen)

## [0.1.0] — 2026-07 (unpublished)

Initial MVP as extracted into the standalone `yktsnd/sekimori` repository.

### Added
- Self-hosted gateway for the Anthropic Messages API: key concealment,
  invite-token auth (SHA-256 at rest), per-token daily and global monthly
  budget caps (fail-closed), fixed-window rate limiting, model allowlist
  with operator-declared prices, server-pinned system prompt, SSE
  passthrough with usage accounting, CORS allowlist, privacy-default
  logging (`logBodies: false`)
- Memory and file stores behind the `Store` interface
- Offline test suite (`node:test`, no API key required) and typecheck
- `examples/`: mock upstream, one-command scenario demo/smoke test
  (`demo.sh`), reference chat client (`chat.html`)
- DX-review fixes: startup config summary, guided error when the config
  file is missing, `Retry-After` on both `429` variants, warning log on
  requests from unallowed origins
