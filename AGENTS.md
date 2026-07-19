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
configured budget ceilings (global monthly + per-invite-token daily), rate-limits,
restricts models to an allowlist, can pin the system prompt, and relays SSE.
It **fails closed**: on any ambiguity (unknown model, missing usage data,
broken store) it blocks rather than allows.

Your principal (the human owner) typically cannot audit your work. sekimori
is the independent safety boundary that holds even if the app you built has
bugs: provider credentials stay server-side, and for the supported request
subset with current declared prices, new requests stop at the configured
accounting ceilings. Treat it as the thing that protects your principal
**from your own mistakes**.

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
  Both this and the upstream key must use visible ASCII only (`0x21`–`0x7e`,
  so no whitespace/control/non-ASCII); the admin key must be at least 32
  characters, and the two values must differ.

On successful boot, stdout prints `[sekimori] listening on ...` plus an
effective-config summary (port, listen host, upstream and its timeout, models,
budgets, rate limit, CORS, store, logBodies). Secrets are never printed.

## Create a config

Two equivalent paths; both must end with a file that startup validation
accepts.

1. **`init` (non-interactive)** — writes defaults; refuse-to-overwrite
   without `--force`; requires `--yes` when stdin is not a TTY (it will
   never hang your pipe):

   ```bash
   npx tsx src/main.ts init --yes [path]   # exit 0, writes path (default ./sekimori.config.json)
   ```

   Every setting also has a flag (`--port`, `--listen-host`, `--upstream-type
   anthropic|bedrock`, `--upstream-url`, `--upstream-timeout-ms`, `--model
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
     values are reference only. Every configured USD amount must be positive
     and no more than $1,000,000,000. Unlisted models are rejected (403).
   - The configured accounting boundary deliberately supports only ordinary text Messages
     requests (no tools, prompt caching, multimodal/provider-managed
     features, or unknown request fields). Keep client JSON within 64 KiB and
     64 nesting levels; use a provider-specific gateway with a complete price
     model if the app needs those features.
   - `upstream.baseUrl`: HTTPS is required for every non-local address. Plain
     HTTP is accepted only for exact localhost or a literal loopback IP, and
     provider-authenticated redirects are refused.
   - `rateLimit.requestsPerMinute`: 1–10,000. It is both a per-token rolling
     minute limit and that token's active-request cap. Independently, the
     process refuses message call 257 while 256 are active across all tokens.
   - `budget.monthlyUsd`: global kill switch. Ask the owner for this number;
     do not invent it.
     The same applies to `budget.defaultDailyPerTokenUsd`; CLI defaults are
     examples, not owner approval for a real deployment.
     If a positive USD debit cannot change the stored total at the current
     floating-point magnitude, sekimori fails closed. Do not work around that
     error by weakening accounting; inspect the configured amounts/state.
   - `cors.allowedOrigins`: exact origins only. Empty array = no CORS
     headers. **Never** work around a CORS failure by adding `*` — add the
     app's real origin. HTTPS is required except for exact localhost or a
     literal loopback IP.
   - `pinnedSystemPrompt`: set it whenever the app does not need
     client-supplied system prompts; it turns a stolen token into a much
     less useful asset.
   - `store`: use `"file"` for anything that must survive a restart
     (budget accounting resets to zero with `"memory"` — that weakens the
     cap; prefer `file` in production). File stores compact settled usage from
     previous UTC months on a later reservation, but retain any unresolved
     reservation so a cross-midnight request can still settle safely.
     The file store holds `<state>.lock` for the process lifetime. A second
     live process is refused; graceful `SIGINT`/`SIGTERM` releases the lock,
     while a hard crash can leave a stale lock that startup will not reclaim.
     Remove it only after verifying that no sekimori process uses that exact
     state path. Never delete a live owner's lock to create a second replica.
   - `listenHost`: defaults to `127.0.0.1`, so an accidental plain-HTTP
     internet listener is not created. Set `0.0.0.0` / `::` only when a
     platform or TLS-terminating reverse proxy must reach it, and verify the
     startup log before handing out a URL.
   - `upstream.timeoutMs`: defaults to 120 seconds for upstream response
     headers and separately bounds the complete non-streaming body read. SSE
     may continue after headers. A timeout leaves the conservative reservation
     charged because the provider may have started a billable request.
   - Non-streaming upstream bodies are limited to 4 MiB to protect gateway
     memory. An over-limit body returns `502` and keeps the conservative
     reservation. SSE relay remains byte-for-byte; its accounting parser has a
     256 KiB unterminated-line limit and also keeps the reservation if parsing
     becomes unsafe.
   - `upstream.type: "bedrock"`: routes through Amazon Bedrock instead of
     Anthropic directly. **Set `"stream": false` in every client** (see
     the reference client's `CONFIG.stream` in
     [`examples/chat.html`](examples/chat.html)) — Bedrock streaming isn't
     implemented yet, and sekimori rejects `"stream": true` with `400`
     fail-closed rather than silently ignoring it. The upstream key env
     var is conventionally `AWS_BEARER_TOKEN_BEDROCK` (what `sekimori init
     --upstream-type bedrock` writes into `upstream.apiKeyEnv`), and model
     access for the model(s) you list must be confirmed before first use.
     Check AWS's current model-access prerequisites rather than following a
     stale opt-in walkthrough; long-term Bedrock API keys are exploration
     credentials, so record their expiry and do not present this static-key
     integration as a long-running production auth design.

## Verify (before handing the URL to anyone)

```bash
curl -fsS http://127.0.0.1:8787/healthz        # -> {"ok":true}, exit 0
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
npm run demo                                   # 18 steps, exit 0, no API key, zero spend
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
  -H 'Content-Type: application/json' -d '{"name":"friend-1"}'   # 201; uses the owner-approved configured default

# list / revoke / global usage
curl -s $BASE/admin/tokens        -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"   # 200
curl -s -X DELETE $BASE/admin/tokens/$ID -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"  # 200 (404 if unknown id)
curl -s $BASE/admin/usage         -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"   # 200
```

Semantics you must encode in the app you build:
- `429` carries `Retry-After` (seconds). `budget_exceeded_error` resets at
  UTC midnight (daily) or the 1st of next month UTC (monthly);
  rolling-window `rate_limit_error` within a minute. Active-request pressure
  returns `1` as a minimum retry hint, not a guaranteed slot. Show end users a friendly countdown —
  [`examples/chat.html`](examples/chat.html) is the reference wording and is
  designed to be copied as your app's starting point.
- `503 storage_unavailable_error` means the store broke and sekimori is
  deliberately blocking everything except `/healthz`. Fix storage, restart.
  Do not retry through it.

## Report to the owner (template)

After setup, tell your principal in plain language, for example:

> Your app is live at <URL>. It talks to Claude through a gateway I set up:
> your API key stays on the server and is never in the app or the browser.
> For the supported text requests and the model prices in the configuration,
> the gateway blocks a new request before its conservative reservation would
> exceed $<monthly> per month total or $<daily> per day per invited person; if
> a limit is hit, requests pause until it
> resets. Only people with an invite code can use it, each
> invite can be cancelled anytime, and requests are limited to <N> per
> rolling minute per person, with at most 256 messages active in the gateway
> at once. Conversation contents are not logged. Provider
> prices must be re-checked whenever models or pricing change.

## Rules (do not break these)

1. Never place the upstream API key in the config file, client code,
   repository, or logs. Only the environment variable.
2. Never expose `SEKIMORI_ADMIN_KEY` to end users or embed it in the app's
   frontend. Both secrets must use visible ASCII only; the admin key must be
   at least 32 characters and differ from the upstream key.
3. Never add `*` (or the effect of it) to CORS origins.
4. Never raise budget caps or issue tokens beyond what the owner approved.
   Budget numbers come from the owner, not from you.
5. Do not disable or work around a fail-closed block (403/429/503). The
   block is the product working. Diagnose, report, or wait for the reset.
6. sekimori is single-process; do not put it behind a load balancer with
   multiple replicas (limits would fragment, and file-store ownership is
   exclusive). If `<state>.lock` names a live process, stop that process rather
   than deleting the lock. After a confirmed hard crash, verify no process uses
   the state path before removing the stale lock and restarting.
7. HTTPS is required for anything beyond localhost — terminate TLS in front
   (platform default or a reverse proxy).
