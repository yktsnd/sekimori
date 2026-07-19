# Design principles & decisions

This is the current-truth record of sekimori's design constraints and the
fail-closed decisions made where the original spec was silent. The *history*
of how these emerged is in [docs/history/](history/).

## Principles (load-bearing, defended)

1. **Fail-closed.** Wherever a judgment call exists, sekimori blocks rather
   than allows: unknown models are rejected, missing usage data is billed at
   worst-case, a broken store blocks all traffic, prices must be declared
   explicitly. When in doubt in a PR review, this is the tie-breaker.
2. **Single process, bounded scope.** Rate limiting and active-request state
   live in one process, and the file store is not a distributed coordination
   mechanism. Horizontal scaling is explicitly unsupported. The boundary is
   kept small enough to audit and operate without a database or control plane.
3. **Minimal dependencies.** Runtime dependencies are `hono` (+
   `@hono/node-server`) only. Tests use `node:test`. Every new dependency is
   a maintenance liability and a supply-chain surface; the default answer to
   adding one is no.
4. **Protocol-preserving where possible.** Anthropic-direct text requests are
   relayed with server-built headers and only the configured system-prompt
   replacement; SSE payload bytes are not rewritten. The Bedrock path is an
   explicit, isolated adapter for `InvokeModel`, not a claim of arbitrary
   provider compatibility. This minimizes coupling to upstream evolution.
5. **Prices are the operator's declaration.** sekimori never fetches or
   guesses prices. Shipped example prices are reference values; the config is
   the source of truth. Stale-price risk is pushed to the one place it can be
   verified — the operator.
6. **Privacy by default.** With `logBodies: false` (default), no request or
   response bodies are ever logged — only counts, token usage, cost, status,
   and latency.
7. **Agents are first-class operators.** sekimori is routinely installed and
   run by a coding agent on behalf of an owner who cannot audit the result.
   Every operation must therefore work without a TTY, without interactive
   prompts, and with machine-checkable outcomes (exit codes, JSON, stable
   `error.type` values); [AGENTS.md](../AGENTS.md) is the contract for that
   reader and ships in the npm package.

The trust boundaries and the assumptions behind these principles are stated
separately in [security-model.md](security-model.md).

## Decisions where the spec was silent (fail-closed choices)

- **Scope of 503 on store failure**: once the store reports unhealthy,
  **all** endpoints except `/healthz` return `503` — including `/admin/*`.
  Allowing token issuance/revocation against a broken store would be more
  dangerous than blocking it.
- **Model allowlist matching** uses `Object.hasOwn`, not the `in` operator,
  so model names like `toString` or `constructor` cannot slip through via
  prototype inheritance.
- **Invite-token usage privacy**: `GET /v1/usage` returns only the caller's
  daily usage and daily limit. The global monthly total/cap belongs to the
  operator and is available only through `GET /admin/usage`; exposing it to
  every invite token would reveal other users' activity and the owner's budget.
- **`logBodies: true` and streaming**: request bodies may be logged, but
  streaming response bodies are not buffered for logging. Non-streaming
  request/response bodies are logged only with this explicit opt-in.
- **Admin key comparison** uses `crypto.timingSafeEqual` (constant-time).
- **Config validation** rejects unknown fields and invalid security-relevant
  values at startup. Optional values receive documented defaults; missing
  models/prices, required secret environment variables, or unsafe combinations
  abort startup.
- **`DELETE /admin/tokens/:id` with an unknown id** returns `404` rather
  than silently succeeding.
- **Unallowed-Origin warning** is logged once per distinct origin, up to 100
  origins per process, with control characters removed. This keeps the
  diagnostic useful without making untrusted request headers a log/memory DoS.
- **Budget accounting**: precheck uses a conservative estimate (one reserved
  input token per UTF-8 request byte, a fixed provider-framing allowance, and
  `max_tokens` at the declared output price). Only a successful upstream
  response with complete valid usage replaces it after the fact. Missing
  usage, network error, timeout, unsafe response processing, or a non-success
  status keeps the reservation because whether it was billed is ambiguous.
  Daily/monthly windows are UTC. If reported usage exceeds the reservation,
  an accounting circuit breaker blocks further provider calls.
- **Numeric accounting precision**: configured USD prices and limits are
  positive and capped at $1,000,000,000. After arithmetic, a positive debit
  must make the stored total increase; if JavaScript number precision would
  erase that increment, accounting fails closed instead of silently allowing
  zero change.
- **Bounded response accounting**: non-streaming upstream bodies are capped at
  4 MiB before they enter memory or optional body logging. An over-limit body
  is treated as ambiguous and returns `502` with its worst-case reservation
  intact. SSE relay bytes stay transparent; the bounded incremental accounting
  parser abandons settlement (and keeps the reservation) after malformed or
  incomplete protocol state or a 256 KiB unterminated line.
- **File-store retention**: the next reservation in a new UTC month removes
  completed history from older months. It retains unresolved reservations (and
  only those amounts) so an in-flight call across a calendar boundary can
  still be settled without letting state files grow indefinitely. On process
  restart no request can return to settle a stored reservation id, so startup
  removes the orphan metadata while retaining its already-recorded worst-case
  debit.
- **File-store ownership and durability**: startup holds an exclusive adjacent
  lock for the process lifetime and refuses a second owner. Normal signals
  release it; after a hard crash, startup deliberately refuses the leftover
  lock until an operator confirms that no process owns the state and removes
  it. State replacement uses a same-directory temporary file requesting mode
  `0600` where supported, file sync, atomic rename, and directory sync. These
  are single-host crash-safety measures, not distributed locking or
  shared-storage support.

## Supported extension points

Contributions are easiest to accept where the seams already are:

- **`Store`** (`src/store.ts`) — the persistence interface behind tokens and
  accounting (`memory` and `file` ship today; Redis/SQLite/KV are plausible
  third-party implementations).
- **Upstream provider** — Anthropic Messages API and non-streaming Amazon
  Bedrock `InvokeModel` ship today as separate forwarding branches. A new
  provider requires a complete request/response and pricing model; the project
  does not advertise a generic provider abstraction yet.

Changes that touch the principles above (new runtime dependencies, DB
requirements, horizontal scaling, dashboards) are non-goals — see
[CONTRIBUTING.md](../CONTRIBUTING.md).
