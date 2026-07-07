# Configuration reference

sekimori reads a single JSON config file. The path is given as the first CLI
argument (default: `./sekimori.config.json`). A template ships as
[`sekimori.config.example.json`](../sekimori.config.example.json).

Secrets never go in the config file — they are passed via environment
variables.

## Keys

| Key | Description |
|---|---|
| `port` | Listen port. Default `8787`. |
| `upstream.baseUrl` | Base URL of the upstream (Anthropic Messages API compatible). |
| `upstream.apiKeyEnv` | **Name of the environment variable** that holds the upstream API key (the key itself is never written to the config). |
| `models` | Allowlist and price table: `{ "<model>": { "inputPerMTok": USD, "outputPerMTok": USD } }`. Requests for models not listed here are rejected with `403`. |
| `budget.monthlyUsd` | Global monthly cap (kill switch). Once exceeded, **every** token gets `429` until the next month (UTC). |
| `budget.defaultDailyPerTokenUsd` | Default per-token daily cap applied when a token is issued without an explicit `dailyUsd`. |
| `rateLimit.requestsPerMinute` | Fixed-window rate limit, per token. |
| `pinnedSystemPrompt` | If set to a string, the client-supplied `system` field is ignored and force-replaced with this value on every upstream request. `null` passes `system` through unchanged. |
| `cors.allowedOrigins` | Array of allowed origins. An empty array `[]` emits **no** CORS headers at all (there is no implicit `*`). |
| `logging.logBodies` | `false` (default): request/response bodies are never logged. |
| `store.type` | `"memory"` (state is lost on process exit) or `"file"` (persisted to a JSON file). |
| `store.path` | Path of the state file when `store.type` is `"file"`. |

## Required environment variables

- The variable named by `upstream.apiKeyEnv` (the upstream API key).
- `SEKIMORI_ADMIN_KEY` — the admin key for `/admin/*` endpoints.

If either is missing, sekimori refuses to start (fail-closed). Startup also
fails when `models` is empty or any price is not a positive number.

All other keys (`port`, `rateLimit`, `cors`, `logging`, `store.path`) fall
back to sensible defaults when omitted.

## Notes on prices

The prices in `models` are **your** declaration, used for budget accounting.
The values in the example config are reference values that go stale —
always verify against the provider's current pricing. Unknown models are
rejected rather than guessed at (fail-closed: the source of truth for prices
is you, not the tool).

## On startup

sekimori prints a summary of the effective configuration (port, upstream,
allowed models, budgets, rate limit, CORS origins, store type, `logBodies`)
so you can see what is being protected before you hand out tokens. Secrets
are not printed.
