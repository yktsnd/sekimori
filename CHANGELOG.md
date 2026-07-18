# Changelog

All notable changes to sekimori are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) once published to npm.

## [Unreleased]

## [0.2.0] - 2026-07-18

### Changed — public-release hardening
- Public-facing docs now distinguish the public source repository from an
  unpublished software release; `RELEASING.md` records the completed
  visibility/history checks and the remaining externally controlled gates
  (default-branch merge, private-reporting route tests,
  social-preview upload, real HTTPS deployment, npm publish and tag).
  `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `GOVERNANCE.md`, a support
  issue template, and Dependabot configuration make the participation model
  explicit. The package tarball now includes every README-linked policy and
  release document, verified by pack smoke. The README landing pages now lead
  with an offline proof, support matrix, complete PowerShell/POSIX walkthrough,
  server-side Anthropic TypeScript SDK example with explicit retry behavior,
  and release status; `docs/security-model.md` records trust boundaries,
  assumptions, failure behavior, and non-goals.
- The default listener is now loopback-only (`listenHost: "127.0.0.1"`);
  public binding requires an explicit config/`init --listen-host` opt-in.
  Public upstream/CORS URLs require HTTPS (plain HTTP is loopback-only),
  upstream redirects are refused, and provider/admin secrets must be distinct
  visible ASCII values; the admin key is at least 32 characters. Unknown
  config fields fail startup. Accounting config values are capped at
  $1,000,000,000 and floating-point increments that cannot change a stored
  total fail closed. `upstream.timeoutMs` separately
  bounds response headers and a complete non-streaming body (120 s by default).
  Any timeout or non-success upstream response retains the worst-case budget
  reservation because billability is ambiguous.
- The supported Messages subset is now validated locally before reservation:
  non-empty user/assistant text messages, text-only system, boolean stream,
  bounded metadata/stop/sampling fields, and no unknown/provider-priced
  features. Reservations include provider-framing margin; usage above that
  conservative bound records actual cost and opens a fail-closed accounting
  circuit breaker. Provider non-success responses are normalized to a local
  `502` rather than leaking/confusing provider auth/rate errors.
- Rate limiting now uses a rolling minute and an active-request cap per invite.
  Configured requests/minute is bounded at 10,000, and a process-wide limit
  rejects message call 257 while 256 are active across all invites.
  SSE accounting uses one backpressure-aware bounded relay/parser, treats
  truncation/cancellation/protocol anomalies conservatively, keeps its idle
  timeout live until the stream settles, and emits
  `Cache-Control: no-cache, no-store, no-transform`. All routes use
  `Cache-Control: no-store` and structured not-found/errors.
- File-store snapshots use a temporary file requesting mode `0600`, file sync,
  atomic rename, and directory sync. A lifetime `<state>.lock` refuses a second live
  process and is released on graceful signals. Hard-crash stale locks fail
  closed until an operator verifies no state owner and removes the lock.
  Existing valid POSIX snapshots are tightened to `0600` during startup;
  permission-migration failure blocks startup instead of silently continuing.
  Startup finalizes orphan reservation metadata at its already-debited
  worst-case amount; historical settled usage is compacted later.
- Non-streaming upstream bodies have a 4 MiB memory limit; oversized bodies
  and unsafe SSE accounting retain the reservation rather than creating an
  unbounded-memory path. Both demo entry points are now unconditionally
  offline (the legacy real-provider environment-variable path was removed).
  The installed CLI runs its packaged 18-step demo, and pack smoke verifies
  that command, `doctor --json`, startup, admin token issuance, and a Messages
  round trip from a fresh tarball.
- Invite-token `/v1/usage` no longer reveals global monthly budget/usage;
  those values remain admin-only. Browser CORS exposes `Retry-After`, SSE
  includes cache/transformation protections, and malformed or unknown admin
  token fields can no longer accidentally issue a default-cap token. An empty
  CORS allowlist now emits no CORS headers at all; preflight applies only to
  real routes and cannot bypass a fail-closed storage/accounting gate.
- The reference chat gained a new-conversation action, shared-device token
  warning, accessible live regions/labels/focus states, and recovery wording
  for every sekimori error type. The offline demo is now available as
  cross-platform `npm run demo` (Node 20+). The tarball acceptance test is
  also now Node-only and runs a fresh install plus HTTP round trip on Windows
  CI as well as Linux.
- CI covers the declared Node.js 20 minimum, Node.js 22, Linux, macOS, and
  Windows; Node.js 24 is covered on Linux and the legacy POSIX demo is
  exercised there. Production dependency auditing runs in the current-Node
  CI job. Workflow actions use their Node.js 24 runtime, are pinned to
  immutable full commit SHAs, and are tracked by Dependabot. GitHub CodeQL
  Extended scans JavaScript/TypeScript weekly, and GitHub Releases are
  immutable once published.
- Owner and Bedrock guidance no longer promises impossible billing outcomes;
  it directs operators to current Anthropic billing and AWS key/model-access
  guidance and describes static Bedrock API keys as prototype-only.
- The package `start` script now uses the shipped `dist/main.js` instead of
  unpublished source/dev dependencies. Pack acceptance executes the installed
  bin shim, verifies release metadata, and asserts that source, tests, GitHub
  internals, archived design history, local config, state, and secrets are not
  shipped. The standalone mock upstream is loopback-only and rejects bodies
  above 64 KiB.
- Publishing is manual through a protected GitHub Environment. A dependency-
  free preflight blocks prerelease versions, non-`main` refs, dirty trees,
  metadata drift, missing changelog entries, and mismatched confirmations;
  the workflow supports a one-time bootstrap token and then stage-only npm
  Trusted Publishing with provenance and explicit maintainer 2FA approval.

### Added — owner-ready capability set
- Amazon Bedrock upstream (`upstream.type: "bedrock"`, issue #17):
  Bearer-authenticated, non-streaming requests to Bedrock's `InvokeModel`
  endpoint (`POST {baseUrl}/model/{model}/invoke`) with the documented body
  transform (drops `model`/`stream`, adds `"anthropic_version":
  "bedrock-2023-05-31"`); everything else (model allowlist, budget
  accounting, rate limiting, pinned system prompt) behaves exactly as with
  the Anthropic-direct upstream, and the Anthropic path is byte-for-byte
  unchanged. `"stream": true` against a bedrock upstream is rejected with
  `400 invalid_request_error` at the same body-validation stage as
  `max_tokens`, before any budget is consumed (fail-closed; eventstream →
  SSE transcoding is a ROADMAP "Later" item). `sekimori init
  --upstream-type anthropic|bedrock` (plus the matching interactive
  prompt) writes the Bedrock defaults (`bedrock-runtime` endpoint,
  `AWS_BEARER_TOKEN_BEDROCK`, a Bedrock-style inference-profile model id)
  and next-steps text; `examples/chat.html` gained a `CONFIG.stream` toggle
  so the reference client can talk to a Bedrock upstream non-streaming.
  Zero new dependencies.
- Owner guide (`docs/owner-guide.md` / `docs/owner-guide.ja.md`): the
  first document addressed to the app's owner rather than a developer or
  agent — explains from zero what an API key and hosting are, how to get
  them (Anthropic direct or Amazon Bedrock to use existing AWS credits),
  cost ballparks, safe key handover, and the protection summary to expect;
  linked from both READMEs and AGENTS.md, plus the round-3 review
  (`docs/history/07`)

### Added — agent-ready capability set
- `sekimori doctor [config] [--json]` (issue #14): non-interactive,
  no-TTY, no-network self-check of a concrete installation — config file
  present/valid, required env vars set (never prints their values), the
  configured store is writable (without ever touching an existing state
  file), and whether body logging is on. Stable snake_case check names
  (`config_file`, `config_valid`, `upstream_key_env`, `admin_key_env`,
  `store_writable`, `logging`) with `status: "ok" | "warn" | "fail"` for
  agents to key on; `--json` prints `{ ok, checks }` and nothing else.
  Human output ends with a plain-language "Protection summary" (allowed
  models, budget caps, rate limit, CORS, logging, store persistence) meant
  to be pasted into an owner report. Exit 0 only when no check fails
  (warnings, e.g. a memory store or `logBodies: true`, do not fail it).
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

### Added — distribution-ready capability set
- `sekimori init [path] [--force] [--yes]`: interactive config generator
  (issue #7), zero new dependencies (`node:readline/promises`). Prompts for
  every setting with defaults shown in `[brackets]`, validates answers as
  you go, and runs the generated config through the real `validateConfig`
  before writing so it cannot produce a structurally invalid config; refuses
  to overwrite an existing file without `--force`; requires
  `--yes` when stdin is not a TTY so it never hangs in pipes/CI.
- Sustainability review, roadmap, and governance docs (CONTRIBUTING,
  SECURITY, issue/PR templates)
- Current-truth reference docs: `docs/configuration.md`, `docs/api.md`,
  `docs/design.md`
- npm packaging: `npm run build` compiles to `dist/` (ESM), a `sekimori`
  bin, package metadata (`files`, `engines`, `license`, `repository`,
  `prepublishOnly`), and `test/pack-smoke.sh` / `npm run test:pack` verifying
  `npm pack` -> install -> boot -> HTTP round trip against a packed tarball.
  The manifest is set to `0.2.0` after explicit maintainer approval; registry
  publication remains a separate human-authorized step.
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
