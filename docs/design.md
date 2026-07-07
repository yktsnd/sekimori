# Design principles & decisions

This is the current-truth record of sekimori's design constraints and the
fail-closed decisions made where the original spec was silent. The *history*
of how these emerged is in [docs/history/](history/).

## Principles (load-bearing, defended)

1. **Fail-closed.** Wherever a judgment call exists, sekimori blocks rather
   than allows: unknown models are rejected, missing usage data is billed at
   worst-case, a broken store blocks all traffic, prices must be declared
   explicitly. When in doubt in a PR review, this is the tie-breaker.
2. **Single process, in-memory scale.** sekimori targets "an individual
   sharing a prototype with tens to thousands of requests per day". Rate
   limiting and the memory store live in process memory; horizontal scaling
   is explicitly unsupported. This keeps the whole system reviewable in an
   afternoon.
3. **Minimal dependencies.** Runtime dependencies are `hono` (+
   `@hono/node-server`) only. Tests use `node:test`. Every new dependency is
   a maintenance liability and a supply-chain surface; the default answer to
   adding one is no.
4. **Passthrough, not translation.** Requests and SSE bytes are relayed
   as-is (headers are rebuilt server-side; bodies are not rewritten beyond
   the pinned system prompt). This minimizes coupling to upstream API
   evolution.
5. **Prices are the operator's declaration.** sekimori never fetches or
   guesses prices. Shipped example prices are reference values; the config is
   the source of truth. Stale-price risk is pushed to the one place it can be
   verified — the operator.
6. **Privacy by default.** With `logBodies: false` (default), no request or
   response bodies are ever logged — only counts, token usage, cost, status,
   and latency.

## Decisions where the spec was silent (fail-closed choices)

- **Scope of 503 on store failure**: once the store reports unhealthy,
  **all** endpoints except `/healthz` return `503` — including `/admin/*`.
  Allowing token issuance/revocation against a broken store would be more
  dangerous than blocking it.
- **Model allowlist matching** uses `Object.hasOwn`, not the `in` operator,
  so model names like `toString` or `constructor` cannot slip through via
  prototype inheritance.
- **`monthUsd` in usage responses** is the all-tokens total for the current
  month, because `budget.monthlyUsd` is a global kill switch. A per-token
  monthly cap does not exist.
- **`logBodies: true` and streaming**: request bodies are logged, but
  streaming response bodies are not (double-buffering the SSE tee was judged
  not worth the complexity). Non-streaming logs both.
- **Admin key comparison** uses `crypto.timingSafeEqual` (constant-time).
- **Optional config keys** (`port`, `rateLimit`, `cors`, `logging`,
  `store.path`) get sensible defaults; validation-critical keys (`models`
  non-empty, positive prices, `apiKeyEnv` variable present,
  `SEKIMORI_ADMIN_KEY` present) abort startup when invalid.
- **`DELETE /admin/tokens/:id` with an unknown id** returns `404` rather
  than silently succeeding.
- **Unallowed-Origin warning** is logged once per request (no dedup) — the
  goal is that the operator notices; throttling was left out of scope.
- **Budget accounting**: precheck uses a worst-case estimate
  (`ceil(utf8Bytes(messages+system)/4) × input price + max_tokens × output
  price`); actual usage from the upstream response replaces it after the
  fact, and if usage cannot be extracted, the worst-case cost is recorded
  (over-counting is the safe side). Daily/monthly windows are UTC.

## Supported extension points

Contributions are easiest to accept where the seams already are:

- **`Store`** (`src/store.ts`) — the persistence interface behind tokens and
  accounting (`memory` and `file` ship today; Redis/SQLite/KV are plausible
  third-party implementations).
- **Upstream provider** — today Anthropic Messages API only; an
  OpenAI-compatible upstream is on the roadmap and will be introduced
  together with a formal provider abstraction.

Changes that touch the principles above (new runtime dependencies, DB
requirements, horizontal scaling, dashboards) are non-goals — see
[CONTRIBUTING.md](../CONTRIBUTING.md).
