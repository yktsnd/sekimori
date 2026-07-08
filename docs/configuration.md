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

Every setting can also be pre-answered with a flag (issue #13) — `--port`,
`--upstream-url`, `--model`, `--monthly-usd`, `--daily-usd`, `--rate-limit`,
`--store`, `--store-path`, `--cors-origin`, `--pinned-system`. In interactive
mode a flagged setting is acknowledged (`<setting>: <value> (from --flag)`)
instead of prompted, and every other setting still prompts as usual; with
`--yes`, a flagged setting takes the flag's value and every other setting
takes its default — so `--yes` plus flags is fully non-interactive **and**
fully customized:

```bash
sekimori init --yes --port 3000 --model claude-haiku-4-5-20251001=1,5 \
  --monthly-usd 10 --cors-origin https://example.com
```

Invalid flag values (non-numeric/out-of-range numbers, a malformed
`--model` spec, an unknown `--store` value, a malformed `--upstream-url`,
`--store-path` combined with `--store memory`, ...) are rejected with a
one-line error and a usage pointer, exit non-zero, and write nothing — the
same fail-closed rule as everywhere else in sekimori. `sekimori init --help`
prints the full flag list with defaults and more examples; `sekimori --help`
/ `sekimori help` print brief top-level usage.

Flags:

| Flag | Effect |
|---|---|
| `[path]` | Where to write the config. Default `./sekimori.config.json`. |
| `--force` | Overwrite an existing file at `path` (refused otherwise, exit non-zero). |
| `--yes`, `-y` | Non-interactive: writes every default (or given flag values) without prompting. Also required when stdin is not a TTY (e.g. in scripts/CI) — otherwise `sekimori init` exits non-zero immediately rather than hang waiting for input, even if flags are present. |
| `--help`, `-h` | Print init usage/flags/examples and exit 0. |
| `--port N` | Listen port. Must be a positive integer <= 65535. Default `8787`. |
| `--upstream-url URL` | Upstream base URL. Must be a valid URL. Default `https://api.anthropic.com`. |
| `--model name=inputPerMTok,outputPerMTok` | Add a model to the allow list / price table (positive USD/MTok prices). Repeatable; if given at least once, **replaces** the default model list entirely instead of merging with it. |
| `--monthly-usd N` | `budget.monthlyUsd`. Must be a positive number. Default `30`. |
| `--daily-usd N` | `budget.defaultDailyPerTokenUsd`. Must be a positive number. Default `0.5`. |
| `--rate-limit N` | `rateLimit.requestsPerMinute`. Must be a positive number. Default `10`. |
| `--store file\|memory` | `store.type`. Default `file`. |
| `--store-path PATH` | `store.path` (only meaningful with `store.type: "file"`). Rejected together with `--store memory`. Default `.sekimori/state.json`. |
| `--cors-origin ORIGIN` | Add an allowed CORS origin. Repeatable. Default: none. |
| `--pinned-system TEXT` | `pinnedSystemPrompt`. Default: none (`null`). |

## `sekimori doctor` — installation self-check

`sekimori init` proves a config file *could* start sekimori; `sekimori
doctor` proves a *concrete installation* actually will. It is
non-interactive, needs no TTY, never starts the HTTP server, and never makes
a network call — it only reads the config file, checks that the required
environment variables are set (never prints their values), and probes
whether the configured store location is writable without ever touching an
existing state file.

```bash
# from a clone:
npx tsx src/main.ts doctor [configPath]
# from an installed package:
npx sekimori doctor [configPath]
```

`configPath` defaults to `./sekimori.config.json`, same as the serve
command. Each check reports a stable snake_case `name`, a `status` of
`"ok"`, `"warn"`, or `"fail"`, and a human-readable `detail`:

| `name` | Meaning |
|---|---|
| `config_file` | The config file exists and is readable. |
| `config_valid` | It parses as JSON and passes `validateConfig` (env-var presence is checked separately below, so this does not itself require secrets to be set). |
| `upstream_key_env` | The environment variable named by `upstream.apiKeyEnv` is set and non-empty. |
| `admin_key_env` | `SEKIMORI_ADMIN_KEY` is set and non-empty. |
| `store_writable` | For `store.type: "file"`: the state file (or its directory) is writable. For `"memory"`: always a `warn` — accounting resets on every restart. |
| `logging` | `warn` if `logging.logBodies: true`, else `ok`. |

If `config_file` or `config_valid` fails, every remaining check reports
`fail` with detail `"skipped: config not available"` — the `checks` array
always contains all six names, in the order above, regardless of how far
the run got.

Default output is one line per check (`ok` / `WARN` / `FAIL`), followed —
only when every check passes (warnings are fine) — by a "Protection
summary" in plain language, built from the effective config: allowed
models, monthly cap, per-token daily default, rate limit, CORS origins (or
"browser access disabled"), whether body logging is on, and whether the
store persists across restarts. That block is meant to be pasted straight
into a report to the owner.

`--json` prints a single JSON object to stdout and nothing else:
`{ "ok": boolean, "checks": [ { "name", "status", "detail" }, ... ] }`.
Agents should key on `checks[].name` / `checks[].status`, not on `detail`
text. Exit code is `0` when `ok` is `true` (no check failed — warnings do
not count), `1` otherwise, in both human and `--json` mode.

Run it after any config or environment change, and again right before
handing the URL to anyone. `sekimori doctor --help` prints the full flag
list.

## Keys

| Key | Description |
|---|---|
| `port` | Listen port. Default `8787`. |
| `upstream.baseUrl` | Base URL of the upstream (Anthropic Messages API compatible). |
| `upstream.apiKeyEnv` | **Name of the environment variable** that holds the upstream API key (the key itself is never written to the config). |
| `upstream.type` | `"anthropic"` (default when omitted) or `"bedrock"`. Any other value fails startup (`ConfigError`, fail-closed). See "Using Amazon Bedrock" below. |
| `models` | Allowlist and price table: `{ "<model>": { "inputPerMTok": USD, "outputPerMTok": USD } }`. Requests for models not listed here are rejected with `403`. |
| `budget.monthlyUsd` | Global monthly cap (kill switch). Once exceeded, **every** token gets `429` until the next month (UTC). |
| `budget.defaultDailyPerTokenUsd` | Default per-token daily cap applied when a token is issued without an explicit `dailyUsd`. |
| `rateLimit.requestsPerMinute` | Fixed-window rate limit, per token. |
| `pinnedSystemPrompt` | If set to a string, the client-supplied `system` field is ignored and force-replaced with this value on every upstream request. `null` passes `system` through unchanged. |
| `cors.allowedOrigins` | Array of allowed origins. An empty array `[]` emits **no** CORS headers at all (there is no implicit `*`). |
| `logging.logBodies` | `false` (default): request/response bodies are never logged. |
| `store.type` | `"memory"` (state is lost on process exit) or `"file"` (persisted to a JSON file). |
| `store.path` | Path of the state file when `store.type` is `"file"`. |

## Using Amazon Bedrock

Set `upstream.type: "bedrock"` to route through Amazon Bedrock instead of
calling Anthropic directly — useful if you'd rather spend existing AWS
credits. sekimori sends Bearer-authenticated, non-streaming requests to
Bedrock's `InvokeModel` endpoint (`POST {baseUrl}/model/{model}/invoke`),
transforming the request body (dropping `model`/`stream`, adding
`"anthropic_version": "bedrock-2023-05-31"`) before forwarding it.
Everything else about a request — the model allowlist, budget accounting,
rate limiting, the pinned system prompt — behaves exactly as it does with
the Anthropic-direct upstream. **Streaming is not
yet supported**: a request with `"stream": true` against a bedrock upstream
is rejected with `400 invalid_request_error` before any budget is consumed
(eventstream → SSE transcoding is a [ROADMAP.md](../ROADMAP.md) "Later"
item) — set `"stream": false` in your client (see `CONFIG.stream` in
[`examples/chat.html`](../examples/chat.html)).

To use it:

1. **Generate a Bedrock API key.** Bedrock has offered Bearer-token API
   keys since July 2025 — generate one from the Bedrock console (or the
   AWS CLI) and export it as `AWS_BEARER_TOKEN_BEDROCK` (the conventional
   env var name, and what `sekimori init --upstream-type bedrock` writes
   into `upstream.apiKeyEnv` by default — you can point `apiKeyEnv` at a
   different variable name if you prefer).
2. **Enable model access in the AWS console.** Bedrock model access is
   opt-in per model, per account/region — a request against a model you
   haven't enabled fails even with a valid API key. Enable it before first
   use.
3. **Use Bedrock-style model ids.** Bedrock model ids look like
   `global.anthropic.claude-haiku-4-5-20251001-v1:0` — region and
   inference-profile prefixes vary by account, so check the owner's AWS
   console for the exact id to put in `models`.

Example config snippet:

```json
{
  "upstream": {
    "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
    "apiKeyEnv": "AWS_BEARER_TOKEN_BEDROCK",
    "type": "bedrock"
  },
  "models": {
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": { "inputPerMTok": 1.0, "outputPerMTok": 5.0 }
  }
}
```

`sekimori init --upstream-type bedrock` generates this shape for you
(defaults: Bedrock's `us-east-1` `bedrock-runtime` endpoint,
`AWS_BEARER_TOKEN_BEDROCK`, and the model id above) — see "`sekimori init`"
above.

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
