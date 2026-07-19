# sekimori (関守)

[![CI](https://github.com/yktsnd/sekimori/actions/workflows/ci.yml/badge.svg)](https://github.com/yktsnd/sekimori/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[日本語](README.ja.md)

> A small, self-hosted budget and access guard for sharing an Anthropic-based
> prototype without putting the provider key in the browser.

sekimori sits between your app and the Anthropic Messages API. One process and
one config file provide invite-token access, a model allowlist, per-invite
daily and global monthly budget ceilings, rate limiting, an optional pinned
system prompt, and SSE relay.

It is deliberately narrow: one owner, one process, text Messages requests, and
Anthropic direct or non-streaming Amazon Bedrock. It is not a general-purpose
LLM gateway or an enterprise control plane.

```text
end user's app              sekimori                    provider
invite token  ----------->  auth + limits  ---------->  Anthropic / Bedrock
                             provider key stays here
```

The name comes from the Japanese *sekimori* (関守), a keeper who checked
travel permits at a checkpoint.

## Try the protection, offline

Requires Node.js 20 or newer. The demo itself makes no provider network call
and uses no provider key or spend.

```bash
npm install
npm run demo
```

The demo boots a local mock provider and a temporary sekimori instance, then
checks 18 behaviors including missing-token rejection, an allowed request,
model rejection, budget blocking, rate limiting, token revocation, and usage
reporting. Any mismatch exits non-zero. From a future registry installation,
the equivalent command will be `npx sekimori demo`.

> **Release status:** the source repository is public and this candidate is
> versioned `0.2.0`, but no npm package, version tag/GitHub Release, or real
> HTTPS deployment has been verified yet. Evaluate it from a clone and see
> [RELEASING.md](RELEASING.md) for the remaining gates.

## Fit at a glance

| Area | Supported now | Not supported |
|---|---|---|
| Upstream | Anthropic Messages API; Amazon Bedrock `InvokeModel` | Other providers |
| Messages | Ordinary text requests | Tools, prompt caching, multimodal and other provider-managed features |
| Response | Anthropic non-streaming and SSE; Bedrock non-streaming | Bedrock streaming |
| Access | Revocable bearer invite tokens; separate admin bearer key | OAuth, accounts, teams |
| Load bounds | Per-token rolling/active limits; at most 256 active messages process-wide | Volumetric DDoS protection |
| Spend control | Configured per-invite daily and global monthly ceilings | Provider-side billing controls or automatic price discovery |
| Persistence | File store for restart-safe accounting; memory store for local evaluation | Databases, shared state, multiple replicas |
| Deployment | One process behind HTTPS; exclusive lock per file store | Horizontal scaling, multi-process/load-balanced operation |

The budget ceiling is only as accurate as the model prices you declare in the
config. sekimori reserves conservatively and fails closed when usage is
ambiguous, but it cannot correct a stale or incomplete price declaration. See
[the security model](docs/security-model.md) before relying on it as a safety
boundary. Configured USD amounts are capped at $1,000,000,000, and accounting
fails closed if floating-point precision cannot represent a positive debit.

## Quickstart from a clone (offline)

This longer flow shows the actual API. For the fastest first look, use
`npm run demo` above.

### 1. Install and start the mock provider

```bash
npm install
node examples/mock-upstream.mjs 9999
```

### 2. Create a config and start sekimori

In another terminal on macOS or Linux:

```bash
npx tsx src/main.ts init --yes --upstream-url http://localhost:9999
export ANTHROPIC_API_KEY=dummy
export SEKIMORI_ADMIN_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
npx tsx src/main.ts sekimori.config.json &
GATEWAY_PID=$!
```

`dummy` is accepted only because the upstream in this walkthrough is the local
mock. Never put a real provider key in a config file, client, repository, log,
or copied command. Supply it through the environment named by
`upstream.apiKeyEnv`.

On Windows PowerShell:

```powershell
npx tsx src/main.ts init --yes --upstream-url http://localhost:9999
$env:ANTHROPIC_API_KEY = "dummy"
$env:SEKIMORI_ADMIN_KEY = & node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$gateway = Start-Process -FilePath "npx.cmd" `
  -ArgumentList @("tsx", "src/main.ts", "sekimori.config.json") `
  -WindowStyle Hidden -PassThru
```

After startup, check it from the same shell (retry once if the process is still
starting). On macOS or Linux:

```bash
curl -fsS http://127.0.0.1:8787/healthz
# {"ok":true}
```

On Windows PowerShell:

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/healthz"
# ok
# --
# True
```

### 3. Issue an invite and call the gateway

On macOS or Linux, continue in the shell from step 2:

```bash
curl -sS -X POST http://127.0.0.1:8787/admin/tokens \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","dailyUsd":1}'
# Copy the one-time `token` value from the response:
export TOKEN=smk_xxxxxxxx

curl -sS -X POST http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

On Windows PowerShell, continue in the shell from step 2:

```powershell
$adminHeaders = @{ Authorization = "Bearer $env:SEKIMORI_ADMIN_KEY" }
$invite = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/admin/tokens" `
  -Headers $adminHeaders `
  -ContentType "application/json" `
  -Body '{"name":"demo","dailyUsd":1}'

$userHeaders = @{ Authorization = "Bearer $($invite.token)" }
$message = @{
  model = "claude-haiku-4-5-20251001"
  max_tokens = 100
  messages = @(@{ role = "user"; content = "hello" })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/v1/messages" `
  -Headers $userHeaders `
  -ContentType "application/json" `
  -Body $message
```

When finished, stop the background gateway with `kill "$GATEWAY_PID"` on
macOS/Linux or `Stop-Process -Id $gateway.Id` in PowerShell, then stop the mock
provider in its terminal.

The plaintext invite token appears only in its creation response. Deliver it
to the intended user, and revoke it if it is exposed.

### Optional: use the Anthropic TypeScript SDK on a server

The current SDK exposes `baseURL`, nullable `apiKey`, and bearer `authToken`
options ([official client source](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)).
In a trusted server-side app, point those at sekimori and send only the
[supported ordinary-text request shape](docs/configuration.md#cost-accountable-request-scope):

```bash
npm install @anthropic-ai/sdk
```

```ts
import Anthropic from "@anthropic-ai/sdk";

if (
  !process.env.SEKIMORI_URL ||
  !process.env.SEKIMORI_INVITE_TOKEN ||
  !process.env.SEKIMORI_MODEL
) {
  throw new Error("SEKIMORI_URL, SEKIMORI_INVITE_TOKEN, and SEKIMORI_MODEL are required");
}

const client = new Anthropic({
  baseURL: process.env.SEKIMORI_URL,
  apiKey: null,
  authToken: process.env.SEKIMORI_INVITE_TOKEN!,
  maxRetries: 0,
});

const message = await client.messages.create({
  model: process.env.SEKIMORI_MODEL!,
  max_tokens: 100,
  messages: [{ role: "user", content: "hello" }],
});
```

Set `SEKIMORI_URL` to the gateway base URL (without `/v1/messages`) and
`SEKIMORI_MODEL` to the exact configured allowlist entry.
`maxRetries: 0` keeps retry decisions explicit: after a timeout or other
ambiguous result, sekimori conservatively keeps the reservation, so a hidden
automatic retry could create another provider attempt and reservation. Do not
enable SDK browser use or bundle the invite token into frontend code; browser
apps should start from the fetch-based [`examples/chat.html`](examples/chat.html).

## Before any non-local deployment

- Use the file store; the memory store resets accounting on restart.
- Put sekimori behind HTTPS and keep exactly one running process/replica.
  A second process using the same state file is refused by its adjacent
  `<state>.lock`; stop the live owner process instead of deleting its lock.
  After a confirmed hard crash, verify no process uses the state path before
  removing the stale lock and restarting.
- Keep `rateLimit.requestsPerMinute` within 1–10,000. The process rejects
  message call 257 while 256 are active; this is a memory/availability bound,
  not a promise of capacity or DDoS protection.
- Use HTTPS provider/browser origins outside localhost or a literal loopback
  address. Set exact browser origins; never use wildcard CORS.
- Verify current provider pricing and model access, then set owner-approved
  budget numbers. sekimori does not fetch prices.
- Pin the system prompt when clients do not need to supply it.
- Generate separate provider and admin secrets, keep both server-side, and use
  visible ASCII only (`0x21`–`0x7e`, so no whitespace/control/non-ASCII). The
  admin key must be at least 32 characters. Run `sekimori doctor` after every
  config/environment change.
- Run the deployment checks in [AGENTS.md](AGENTS.md) before issuing tokens.

The reference browser client is [`examples/chat.html`](examples/chat.html).
Copy it into your app, edit its `CONFIG`, and serve it from an origin listed in
`cors.allowedOrigins`. It stores the invite token in browser `localStorage`,
so it is suitable only for an app whose frontend you trust against XSS.

## Documentation

| You want to… | Read |
|---|---|
| Set up billing, credentials, or hosting with no prior knowledge | [Owner guide](docs/owner-guide.md) / [日本語](docs/owner-guide.ja.md) |
| Operate sekimori as a coding agent | [AGENTS.md](AGENTS.md) |
| Configure sekimori | [Configuration](docs/configuration.md) |
| Call or administer it | [API reference](docs/api.md) |
| Understand guarantees, assumptions, and failure behavior | [Security model](docs/security-model.md) |
| Understand design constraints and extension points | [Design](docs/design.md) |
| Contribute or ask for help | [CONTRIBUTING.md](CONTRIBUTING.md) / [SUPPORT.md](SUPPORT.md) |
| Understand participation and decisions | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) / [GOVERNANCE.md](GOVERNANCE.md) |
| Report a vulnerability privately | [SECURITY.md](SECURITY.md) |
| Prepare a public release | [RELEASING.md](RELEASING.md) |
| See notable changes | [CHANGELOG.md](CHANGELOG.md) |
| See the remaining roadmap | [ROADMAP.md](ROADMAP.md) |

日本語の README は [README.ja.md](README.ja.md) です。

## Development verification

```bash
npm run typecheck
npm test
npm run demo
npm run test:pack
```

All tests and demos are offline by default. The pack smoke test creates a
tarball, installs it into a clean temporary project, and exercises the
installed binary, packaged demo, doctor checks, and an HTTP round trip.

## Scope

If you need multi-provider routing, team management, a database, dashboards,
or multiple replicas, choose a gateway designed for those requirements.
sekimori intentionally does not implement multi-tenant SaaS, billing
integration, prompt management, caching, retries, or horizontal scaling.

Publishing, deployment, naming, budget, and credential decisions remain with
the human maintainer/owner. Design and implementation changes must be reviewed
on their evidence, regardless of whether a human or an AI-assisted workflow
produced them.
