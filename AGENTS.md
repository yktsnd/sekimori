# AGENTS.md — operating sekimori as a coding agent

You are likely a coding agent that was asked to publish a human's AI
prototype safely. This file is the operations manual written for you:
deterministic commands, expected outputs, exit codes, and the rules you must
not break. Human-oriented prose lives in [README.md](README.md); the full
config/API references are [docs/configuration.md](docs/configuration.md) and
[docs/api.md](docs/api.md).

## What sekimori is (and why your principal wants it)

sekimori is a single-process gateway that sits between an app and the
Anthropic Messages API. It keeps the upstream API key server-side, enforces
hard budget caps (global monthly + per-invite-token daily), rate-limits,
restricts models to an allowlist, can pin the system prompt, and relays SSE.
It **fails closed**: on any ambiguity (unknown model, missing usage data,
broken store) it blocks rather than allows.

Your principal (the human owner) typically cannot audit your work. sekimori
is the independent safety boundary that holds even if the app you built has
bugs: the key never reaches clients, and spend stops at the caps. Treat it
as the thing that protects your principal **from your own mistakes**.

Three roles:
- **Owner** (human): supplies the upstream API key (Anthropic direct, or an
  Amazon Bedrock API key) and the budget numbers; reads your summary. Never
  needs to touch sekimori. If your owner doesn't know what an API key or a
  hosting account is, **send them
  [docs/owner-guide.md](docs/owner-guide.md) /
  [docs/owner-guide.ja.md](docs/owner-guide.ja.md)** — it walks them through
  obtaining every credential with zero prior knowledge. Do not improvise
  that explanation.
- **Operator** (you): install, configure, run, verify, issue tokens, watch
  usage.
- **End users**: get an invite token (`smk_...`) and use the app. They never
  see the upstream key.

## Install & run

Requirements: Node.js >= 20. Runtime dependencies: `hono`,
`@hono/node-server` only.

Not yet on the npm registry (that release is credential-gated; see
[ROADMAP.md](ROADMAP.md)). From a clone:

```bash
npm ci                        # or: npm install
npx tsx src/main.ts <config>  # serve; default config path ./sekimori.config.json
```

From the packed tarball (what `npx sekimori` will be after release):

```bash
npm run build                 # tsc -> dist/
node dist/main.js <config>
```

Required environment variables (startup exits non-zero if either is
missing):
- `ANTHROPIC_API_KEY` (or whatever name the config's `upstream.apiKeyEnv`
  declares) — the owner's upstream key. **Never** write it into the config
  file, client code, or logs.
- `SEKIMORI_ADMIN_KEY` — generate one yourself:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

On successful boot, stdout prints `[sekimori] listening on ...` plus an
effective-config summary (port, upstream, models, budgets, rate limit, CORS,
store, logBodies). Secrets are never printed.

## Create a config

Two equivalent paths; both must end with a file that startup validation
accepts.

1. **`init` (non-interactive)** — writes defaults; refuse-to-overwrite
   without `--force`; requires `--yes` when stdin is not a TTY (it will
   never hang your pipe):

   ```bash
   npx tsx src/main.ts init --yes [path]   # exit 0, writes path (default ./sekimori.config.json)
   ```

   Every setting also has a flag (`--port`, `--upstream-type
   anthropic|bedrock`, `--upstream-url`, `--model
   name=inputPerMTok,outputPerMTok` — repeatable, replaces the default
   model list entirely once given at least once — `--monthly-usd`,
   `--daily-usd`, `--rate-limit`, `--store file|memory`, `--store-path`,
   `--cors-origin` — repeatable — `--pinned-system`), so `--yes` plus flags
   is a fully non-interactive, fully customized config: agents never need
   to hand-edit JSON. Invalid flag values fail closed (one-line error,
   exit non-zero, nothing written); run `npx tsx src/main.ts init --help`
   for the full list, defaults, and more examples. Worked example:

   ```bash
   npx tsx src/main.ts init --yes --port 3000 \
     --model claude-haiku-4-5-20251001=1,5 --monthly-usd 10 \
     --cors-origin https://example.com
   ```

   To route through Amazon Bedrock instead of calling Anthropic directly
   (e.g. to spend existing AWS credits):

   ```bash
   npx tsx src/main.ts init --yes --upstream-type bedrock
   ```

2. **Write the JSON yourself** against
   [docs/configuration.md](docs/configuration.md), starting from
   [`sekimori.config.example.json`](sekimori.config.example.json). Rules
   that matter:
   - `models` is both allowlist and price table; prices are the operator's
     declaration in USD per MTok. Verify current provider pricing — shipped
     values are reference only. Unlisted models are rejected (403).
   - `budget.monthlyUsd`: global kill switch. Ask the owner for this number;
     do not invent it.
   - `cors.allowedOrigins`: exact origins only. Empty array = no CORS
     headers. **Never** work around a CORS failure by adding `*` — add the
     app's real origin.
   - `pinnedSystemPrompt`: set it whenever the app does not need
     client-supplied system prompts; it turns a stolen token into a much
     less useful asset.
   - `store`: use `"file"` for anything that must survive a restart
     (budget accounting resets to zero with `"memory"` — that weakens the
     cap; prefer `file` in production).
   - `upstream.type: "bedrock"`: routes through Amazon Bedrock instead of
     Anthropic directly. **Set `"stream": false` in every client** (see
     the reference client's `CONFIG.stream` in
     [`examples/chat.html`](examples/chat.html)) — Bedrock streaming isn't
     implemented yet, and sekimori rejects `"stream": true` with `400`
     fail-closed rather than silently ignoring it. The upstream key env
     var is conventionally `AWS_BEARER_TOKEN_BEDROCK` (what `sekimori init
     --upstream-type bedrock` writes into `upstream.apiKeyEnv`), and model
     access for the model(s) you list must be enabled in the AWS console
     before first use (opt-in per model, per account/region).

## Verify (before handing the URL to anyone)

```bash
curl -fsS http://localhost:8787/healthz        # -> {"ok":true}, exit 0
```

Run `sekimori doctor` after any config or environment change, and again
right before handing the URL out — it is a non-interactive, offline,
no-network self-check of the concrete installation (config validity,
required env vars, store writability, body-logging state). It never starts
the HTTP server.

```bash
npx tsx src/main.ts doctor [configPath]           # human output, exit 0 only if nothing failed
npx tsx src/main.ts doctor [configPath] --json     # { "ok": boolean, "checks": [...] }
```

Agents should use `--json` and key on `checks[].name` / `checks[].status`
(`"ok" | "warn" | "fail"`) — never on `detail` text, which is for humans.
Check names are stable: `config_file`, `config_valid`, `upstream_key_env`,
`admin_key_env`, `store_writable`, `logging`. `ok: true` means no check
failed (warnings, e.g. a memory store or `logBodies: true`, do not fail it).
When every check passes, the human-mode output ends with a "Protection
summary" in plain language — that block is the source for the owner-report
template below; paste it rather than re-deriving it. Behavioral
verification — the full blocked/allowed scenario — runs offline from a
clone:

```bash
bash examples/demo.sh                          # 18 steps, exit 0, no API key, zero spend
```

Verify the guards on YOUR deployed instance (cheap, uses the real key —
one tiny request):

```bash
# no token -> 401
curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/v1/messages \
  -H 'Content-Type: application/json' -d '{}'          # expect 401
# unlisted model -> 403 (with a valid token)
# real round trip -> 200 (with a valid token, max_tokens small, e.g. 16)
```

## Operate

All admin calls: `Authorization: Bearer $SEKIMORI_ADMIN_KEY`. All error
responses: `{ "error": { "type": "...", "message": "..." } }` — dispatch on
`error.type`, never on message text. Full endpoint table with expected
statuses: [docs/api.md](docs/api.md).

```bash
# issue an invite token (plaintext appears ONLY in this response; store it nowhere except delivery to the end user)
curl -s -X POST $BASE/admin/tokens -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"name":"friend-1","dailyUsd":1}'   # 201

# list / revoke / global usage
curl -s $BASE/admin/tokens        -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"   # 200
curl -s -X DELETE $BASE/admin/tokens/$ID -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"  # 200 (404 if unknown id)
curl -s $BASE/admin/usage         -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"   # 200
```

Semantics you must encode in the app you build:
- `429` carries `Retry-After` (seconds). `budget_exceeded_error` resets at
  UTC midnight (daily) or the 1st of next month UTC (monthly);
  `rate_limit_error` within a minute. Show end users a friendly countdown —
  [`examples/chat.html`](examples/chat.html) is the reference wording and is
  designed to be copied as your app's starting point.
- `503 storage_unavailable_error` means the store broke and sekimori is
  deliberately blocking everything except `/healthz`. Fix storage, restart.
  Do not retry through it.

## Report to the owner (template)

After setup, tell your principal in plain language, for example:

> Your app is live at <URL>. It talks to Claude through a gateway I set up:
> your API key stays on the server and is never in the app or the browser.
> Spending is capped at $<monthly> per month total and $<daily> per day per
> invited person; if a cap is hit, requests pause until it resets (no
> overage is possible). Only people with an invite code can use it, each
> invite can be cancelled anytime, and requests are limited to <N> per
> minute per person. Conversation contents are not logged.

## Rules (do not break these)

1. Never place the upstream API key in the config file, client code,
   repository, or logs. Only the environment variable.
2. Never expose `SEKIMORI_ADMIN_KEY` to end users or embed it in the app's
   frontend.
3. Never add `*` (or the effect of it) to CORS origins.
4. Never raise budget caps or issue tokens beyond what the owner approved.
   Budget numbers come from the owner, not from you.
5. Do not disable or work around a fail-closed block (403/429/503). The
   block is the product working. Diagnose, report, or wait for the reset.
6. sekimori is single-process; do not put it behind a load balancer with
   multiple replicas (limits and memory-store state would fragment).
7. HTTPS is required for anything beyond localhost — terminate TLS in front
   (platform default or a reverse proxy).
