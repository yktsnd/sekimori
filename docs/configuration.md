# Configuration reference

sekimori reads a single JSON config file. The path is given as the first CLI
argument (default: `./sekimori.config.json`). A template ships as
[`sekimori.config.example.json`](../sekimori.config.example.json).

Secrets never go in the config file — they are passed via environment
variables.

## `sekimori init` — interactive config generator

The fastest way to get a config file is `sekimori init`: it prompts for each
setting (Enter accepts the default shown in `[brackets]`) and writes a valid
`sekimori.config.json`, so the first five minutes never involve hand-editing
JSON.

```bash
# from a clone:
npx tsx src/main.ts init
# from an installed package:
npx sekimori init
```

Prompts, in order: `port`, upstream base URL, the model allow list (offers
the shipped default model, and lets you add others with their per-MTok
prices — printed clearly as **reference values to verify against the
provider's current pricing**, see "Notes on prices" below), monthly budget
USD, default per-token daily budget USD, rate limit (requests/minute), store
type (`file` or `memory`, with a path prompt for `file`), CORS allowed
origins (comma-separated, empty = none), and a pinned system prompt (empty =
`null`).

Every answer is validated as you type (invalid numbers, empty model lists,
etc. re-prompt); before writing, the generated config is run through the
same validation startup uses, so `sekimori init` can never produce a config
that `sekimori` would then refuse to start with. It does **not** require
`ANTHROPIC_API_KEY` or `SEKIMORI_ADMIN_KEY` to already be set — those are
exported later, right before starting sekimori (see the printed "next
steps").

Flags:

| Flag | Effect |
|---|---|
| `[path]` | Where to write the config. Default `./sekimori.config.json`. |
| `--force` | Overwrite an existing file at `path` (refused otherwise, exit non-zero). |
| `--yes` | Non-interactive: writes every default without prompting. Also required when stdin is not a TTY (e.g. in scripts/CI) — otherwise `sekimori init` exits non-zero immediately rather than hang waiting for input. |

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
