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
same validation startup uses, so `sekimori init` rejects structurally invalid
output. Startup can still refuse invalid/missing secret
environment variables or unavailable storage. `init` does **not** require
`ANTHROPIC_API_KEY` or `SEKIMORI_ADMIN_KEY` to already be set — those are
exported later, right before starting sekimori (see the printed "next
steps").

Every setting can also be pre-answered with a flag (issue #13) — `--port`,
`--listen-host`, `--upstream-url`, `--upstream-timeout-ms`, `--model`,
`--monthly-usd`, `--daily-usd`, `--rate-limit`, `--store`, `--store-path`,
`--cors-origin`, `--pinned-system`. In interactive
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
| `--listen-host HOST` | `listenHost`. `127.0.0.1` by default; accepts `localhost` or a literal IPv4/IPv6 address. Use `0.0.0.0` / `::` only deliberately for a platform or TLS-terminating reverse proxy. |
| `--upstream-url URL` | Upstream base URL. Must be an absolute HTTPS URL without credentials, query, or fragment. Plain HTTP is accepted only for the exact `localhost` hostname or a literal loopback IP. Default `https://api.anthropic.com`. |
| `--upstream-timeout-ms N` | `upstream.timeoutMs`: wait for upstream response headers, and bound the complete non-streaming body read, for 1000–900000 ms. Default `120000`; a timeout keeps the worst-case budget reservation. SSE may continue after its headers arrive. |
| `--model name=inputPerMTok,outputPerMTok` | Add a model to the allow list / price table (positive USD/MTok prices, at most $1,000,000,000 each). Repeatable; if given at least once, **replaces** the default model list entirely instead of merging with it. |
| `--monthly-usd N` | `budget.monthlyUsd`. Must be positive and at most $1,000,000,000. Default `30`. |
| `--daily-usd N` | `budget.defaultDailyPerTokenUsd`. Must be positive and at most $1,000,000,000. Default `0.5`. |
| `--rate-limit N` | `rateLimit.requestsPerMinute`. Must be an integer from 1 through 10,000. Default `10`. |
| `--store file\|memory` | `store.type`. Default `file`. |
| `--store-path PATH` | Non-empty `store.path` (only meaningful with `store.type: "file"`). Rejected together with `--store memory`. Default `.sekimori/state.json`. |
| `--cors-origin ORIGIN` | Add an exact HTTPS CORS origin (for example, `https://app.example`). Plain HTTP is accepted only for exact `localhost` or a literal loopback IP. Repeatable. Default: none. |
| `--pinned-system TEXT` | `pinnedSystemPrompt`. Default: none (`null`). |

## `sekimori doctor` — installation self-check

`sekimori init` produces a structurally valid config; `sekimori doctor`
checks the config, environment, and storage prerequisites of a *concrete
installation*. It is
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
| `upstream_key_env` | The environment variable named by `upstream.apiKeyEnv` is non-empty visible ASCII (`0x21`–`0x7e`). |
| `admin_key_env` | `SEKIMORI_ADMIN_KEY` is visible ASCII, at least 32 characters, and distinct from the upstream key. |
| `store_writable` | For `store.type: "file"`: an existing state file is valid for FileStore and its directory can write+rename an atomic snapshot; a missing state file's directory is probed without creating the state file. This check does not take the serve-time lifetime lock, so startup still refuses any existing lock (live or stale). For `"memory"`: always a `warn` — accounting resets on every restart. |
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

## Network exposure

The default `listenHost: "127.0.0.1"` binds only to the local machine. This is
the safe default for a reverse proxy on the same host and prevents an
accidental plain-HTTP internet listener.

Set `listenHost` to `0.0.0.0` (IPv4) or `::` (IPv6) only when your hosting
platform requires it. In that case, put HTTPS/TLS and a firewall/platform
access policy in front of sekimori; the gateway itself does not terminate TLS.
The startup log prints the actual configured bind address—verify it before
handing the URL to anyone.

## Keys

| Key | Description |
|---|---|
| `port` | Listen port. Default `8787`. |
| `listenHost` | Bind address. Default `127.0.0.1` (loopback only). `localhost` or a literal IPv4/IPv6 address is accepted. Use `0.0.0.0` / `::` only when a hosting platform or TLS-terminating reverse proxy must reach it. |
| `upstream.baseUrl` | Base URL of the upstream. HTTPS is required except for exact `localhost` or a literal loopback IP, where HTTP is allowed for local development. Credentials, query, and fragment are forbidden. Redirects are never followed with the provider credential. |
| `upstream.apiKeyEnv` | **Name of the environment variable** that holds the upstream API key (the key itself is never written to the config). |
| `upstream.timeoutMs` | Maximum time to wait for upstream response headers and, separately, to finish reading a non-streaming body. Integer 1000–900000, default `120000`. SSE may continue after headers arrive. A timeout is ambiguous and retains the worst-case budget reservation. |
| `upstream.type` | `"anthropic"` (default when omitted) or `"bedrock"`. Any other value fails startup (`ConfigError`, fail-closed). See "Using Amazon Bedrock" below. |
| `models` | Allowlist and price table: `{ "<model>": { "inputPerMTok": USD, "outputPerMTok": USD } }`. Each amount is positive and at most $1,000,000,000. Requests for models not listed here are rejected with `403`. |
| `budget.monthlyUsd` | Global monthly accounting ceiling (kill switch), positive and at most $1,000,000,000. A request whose conservative reservation would exceed the remaining room gets `429`; at the ceiling, all new message requests remain blocked until the next month (UTC). |
| `budget.defaultDailyPerTokenUsd` | Default per-token daily cap, positive and at most $1,000,000,000, applied when a token is issued without an explicit `dailyUsd`. |
| `rateLimit.requestsPerMinute` | Integer 1–10,000. Rolling 60-second admission limit per token and cap on that token's simultaneously active provider requests. The process also caps all active `/v1/messages` calls at 256, regardless of token. |
| `pinnedSystemPrompt` | If set to a string, the client-supplied `system` field is ignored and force-replaced with this value on every upstream request. `null` passes `system` through unchanged. |
| `cors.allowedOrigins` | Array of exact origins. HTTPS is required except for exact `localhost` or a literal loopback IP. An empty array `[]` emits **no** CORS headers at all (there is no implicit `*`). |
| `logging.logBodies` | `false` (default): request/response bodies are never logged. |
| `store.type` | `"memory"` (state is lost on process exit) or `"file"` (persisted to a JSON file). |
| `store.path` | Path of the state file when `store.type` is `"file"`. A relative path is resolved from the config directory. Startup acquires an exclusive adjacent `<path>.lock`; a second process is refused and graceful `SIGINT`/`SIGTERM` releases it. A hard crash can leave a stale lock, which is not auto-reclaimed. During one process lifetime, unresolved reservations survive month compaction; after restart, orphan metadata is removed but its already-recorded conservative debit remains. |

Unknown keys are rejected at every documented config object level. A typo is
therefore a startup error, not an ignored security setting.

File snapshots are written to a same-directory temporary file requesting mode
`0600` (where the platform honors POSIX modes), synced, atomically renamed,
and followed by a directory sync. This protects
against partial replacement; it does not turn the file store into distributed
storage. If startup reports a lock, first verify that no sekimori process uses
that exact state path. Stop the owner process if it is live. Only after a
confirmed hard crash with no owner may an operator remove the stale lock and
restart; never delete a lock to run a second replica.

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

1. **Generate a Bedrock API key for a prototype.** Export it as
   `AWS_BEARER_TOKEN_BEDROCK` (the conventional env var name, and what
   `sekimori init --upstream-type bedrock` writes into `upstream.apiKeyEnv`
   by default — you can point `apiKeyEnv` at a different variable name if
   you prefer). Record its expiry and rotate it before expiry: sekimori uses
   a static environment variable and does not refresh AWS credentials.
   AWS recommends long-term Bedrock API keys for exploration; use a
   credential design with short-term refresh for a workload needing stronger
   production assurance.
2. **Confirm current model-access prerequisites.** In commercial regions,
   models are generally enabled by default when the account has the needed
   AWS Marketplace permissions. The first use of a third-party model may
   take time to subscribe, and Anthropic models require a one-time use-case
   form for most accounts. Do not rely on an old console walkthrough; check
   AWS's current model-access guidance before first use.
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

See AWS's [API-key guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html)
and [model-access guidance](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
on the day you deploy; those account rules change independently of sekimori.

## Required environment variables

- The variable named by `upstream.apiKeyEnv` (the upstream API key), containing
  visible ASCII only (`0x21`–`0x7e`; no whitespace, control, or non-ASCII).
- `SEKIMORI_ADMIN_KEY` — the admin key for `/admin/*` endpoints. It must be at
  least 32 visible-ASCII characters and have a value different from the
  upstream key. Generate it with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

If either is missing, sekimori refuses to start (fail-closed). Startup also
fails when `models` is empty or an accounting USD value is non-positive or over
$1,000,000,000.

When omitted, `port`, `rateLimit`, `cors`, `logging`, and `store.path` fall
back to sensible defaults. A supplied value must still pass its validation.

## Notes on prices

The prices in `models` are **your** declaration, used for budget accounting.
The values in the example config are reference values that go stale —
always verify against the provider's current pricing. Unknown models are
rejected rather than guessed at (fail-closed: the source of truth for prices
is you, not the tool).

All configured price/budget/token-limit USD amounts are bounded at
$1,000,000,000. Accounting also checks that a positive debit is representable
at the current JavaScript number magnitude. If floating-point precision would
make a positive increment leave the stored total unchanged, the operation
fails closed rather than silently treating the increment as zero.

## Cost-accountable request scope

The `models` table intentionally has only ordinary input/output token prices.
To make the configured ceilings meaningful rather than silently forwarding an
unpriced provider feature, `/v1/messages` accepts only the core text request
fields: `model`, `max_tokens`, `messages`, `system`, `stream`, `metadata`,
`stop_sequences`, `temperature`, `top_p`, and `top_k`. Their supported shapes
are deliberately narrower than every shape a provider might accept:

- `messages` is a non-empty array. Each item contains only `role`
  (`"user"` or `"assistant"`) and `content` (a string or non-empty array of
  `{ "type": "text", "text": "..." }` blocks).
- `system`, when present, is the same string/text-block shape; `stream` is a
  boolean.
- `metadata`, when present, contains only an optional `user_id` string of 1–256
  characters. `stop_sequences` is an array of non-empty strings.
- `temperature` and `top_p` are finite numbers from 0 through 1; `top_k` is a
  positive safe integer.
- Malformed or unknown fields are rejected locally before any budget
  reservation or provider call.

- Submitted request bodies are limited to **64 KiB of UTF-8 JSON** while
  streaming them in (HTTP 413 when exceeded), and the effective request is
  checked again after server-side policy transformations. This stays below
  long-context price tiers that a two-column flat price table cannot express.
- Request nesting is limited to 64 levels, so a small but pathologically deep
  JSON value cannot exhaust the gateway's JavaScript stack.
- Tools/tool choice, prompt caching, multimodal blocks, MCP/container
  features, and unknown or provider-priced request fields are rejected with
  `400 invalid_request_error` before any upstream call or budget reservation.
- sekimori reserves a conservative worst-case amount on disk before it calls
  the provider, then settles that reservation to reported actual usage. Any
  non-success response, missing usage data, network failure, timeout, or
  response-read failure keeps the conservative reservation because
  the gateway cannot prove that the provider did not bill it.
- Non-streaming upstream responses are buffered only up to **4 MiB**. A larger
  or malformed response returns `502 upstream_error` and keeps that worst-case
  reservation rather than risking unbounded gateway memory. SSE bytes still
  pass through unchanged; only the separate incremental usage parser is
  limited to a 256 KiB unterminated event line, and falls back to the
  worst-case reservation if its protocol state is malformed or incomplete.
- If successful provider usage exceeds the reservation, sekimori does not
  silently under-count it: the request becomes `503
  accounting_unavailable_error`, the actual usage is recorded, and new
  provider calls are blocked until the operator diagnoses and restarts the
  process.

If your application needs those capabilities, use a gateway with a complete
provider-specific pricing model rather than weakening this boundary.

## On startup

sekimori prints a summary of the effective configuration (port, upstream,
allowed models, budgets, rate limit, CORS origins, store type, `logBodies`)
so you can see what is being protected before you hand out tokens. Secrets
are not printed.
