# Changelog

All notable changes to sekimori are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once published to npm.

## [Unreleased]

### Added — v0.3 "agent-ready"
- `AGENTS.md`: operations manual for coding agents operating sekimori on
  behalf of a non-expert owner (deterministic commands, expected outputs,
  owner-report template, hard rules), plus agent-operator positioning in
  both READMEs, a new "agents are first-class operators" design principle,
  and the round-2 sustainability review (`docs/history/06`)
- `sekimori init` per-setting flags and `--help` (issue #13): `--port`,
  `--upstream-url`, `--model name=in,out` (repeatable, replaces the
  default model list), `--monthly-usd`, `--daily-usd`, `--rate-limit`,
  `--store`, `--store-path`, `--cors-origin` (repeatable), and
  `--pinned-system`, each validated up front and fed through the same
  `validateConfig` path the wizard already uses (fail-closed: invalid
  values write nothing); `--yes` plus flags is now a fully non-interactive,
  fully customized config, and in interactive mode a flagged setting is
  pre-answered instead of prompted. `sekimori init --help`, `sekimori
  --help`, and `sekimori help` print usage and exit 0. `AGENTS.md` now
  ships in the npm tarball (`files` in `package.json`), closing the last
  checkbox of issue #12.

### Added — v0.2 "distribution-ready"
- `sekimori init [path] [--force] [--yes]`: interactive config generator
  (issue #7), zero new dependencies (`node:readline/promises`). Prompts for
  every setting with defaults shown in `[brackets]`, validates answers as
  you go, and runs the generated config through the real `validateConfig`
  before writing so it can never produce a config that startup would
  reject; refuses to overwrite an existing file without `--force`; requires
  `--yes` when stdin is not a TTY so it never hangs in pipes/CI.
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
- CI (issue #8): `.github/workflows/ci.yml` runs on push and pull_request
  across Node 20/22 (`ubuntu-latest` only) — `npm ci`, typecheck, tests, the
  offline `examples/demo.sh` scenario, and `npm run test:pack`; fully
  offline, no secrets, 10-minute timeout, concurrent runs on the same ref
  cancelled.

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
