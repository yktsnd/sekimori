# sekimori (関守)

> A minimal self-hosted gateway for shipping AI prototypes without exposing
> your API key, melting your budget, or becoming a free LLM proxy.

**sekimori is for the moment when your weekend AI prototype works and you
want to let friends, SNS followers, or beta users touch it.** It sits between
your app and the Anthropic Messages API and provides, with **one config file
and one process**: key concealment, hard budget caps, invite-token auth,
rate limiting, a server-pinned system prompt, and SSE passthrough.

Named after the Edo-period barrier keepers (関守) who checked travel permits
at checkpoints: it inspects each visitor's token and meters what passes
through.

**Single-process by design**: rate limiting and the in-memory store live in
process memory. sekimori does not scale horizontally and is not for team or
enterprise production use — it targets an individual sharing an app at the
scale of tens to thousands of requests per day.

## See everything in one command

The six moments sekimori exists for — blocking tokenless intrusion, stopping
budget overrun, rate limiting, rejecting unlisted models, revoking an invite,
all while a legitimate user keeps chatting — replayed offline, with no real
API key and zero spend:

```bash
npm install        # first time only
bash examples/demo.sh
```

The script boots a mock upstream and sekimori with a temp config, runs the
full scenario with two tokens (`alice`, a normal user, and `mallory`, one
configured to hit her cap immediately), verifies every expected HTTP status,
and cleans up after itself. Any mismatch exits non-zero, so it doubles as an
end-to-end smoke test. Bonus mode against the real API:
`SEKIMORI_DEMO_REAL=1 ANTHROPIC_API_KEY=sk-... bash examples/demo.sh`
(the default is always offline).

## Quickstart (offline, no API key)

```bash
npm install

# 1. start a stub of the Anthropic Messages API on :9999
node examples/mock-upstream.mjs 9999
```

In another terminal:

```bash
# 2. create a config pointed at the stub and start sekimori
cp sekimori.config.example.json sekimori.config.json
#    edit sekimori.config.json: set upstream.baseUrl to "http://localhost:9999"

ANTHROPIC_API_KEY=dummy SEKIMORI_ADMIN_KEY=change-me npx tsx src/main.ts sekimori.config.json
```

```bash
# 3. issue an invite token and talk through the gateway
curl -s -X POST http://localhost:8787/admin/tokens \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","dailyUsd":1}'
# => {"id":"...","token":"smk_..."}

TOKEN=smk_xxxxxxxx  # from the response above

curl -s -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

To go live, point `upstream.baseUrl` at `https://api.anthropic.com` and set
the real `ANTHROPIC_API_KEY`.

Want a browser client? Serve [`examples/chat.html`](examples/chat.html)
(e.g. `python3 -m http.server 8000 --directory examples`), add the serving
origin to `cors.allowedOrigins`, and restart. `chat.html` is a **reference
client meant to be copied as the starting point of your own app**: a
developer-edited `CONFIG` block (base URL / model / app name), invite token
as the *only* thing end users ever enter (kept in `localStorage`), live
"today's usage" display, and per-`error.type` human-readable error messages.

## Documentation

| You want to… | Read |
|---|---|
| Configure sekimori | [docs/configuration.md](docs/configuration.md) |
| Call or administer it (all endpoints, curl examples, error types, `Retry-After`) | [docs/api.md](docs/api.md) |
| Understand the design constraints (fail-closed decisions, extension points) | [docs/design.md](docs/design.md) |
| See where the project is going | [ROADMAP.md](ROADMAP.md) |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Read why it was built this way (design-round records, Japanese) | [docs/history/](docs/history/) |

日本語の README は [README.ja.md](README.ja.md) にあります。

## Tests & typecheck

```bash
npm test          # node:test; bundles a mock upstream — no real API key needed
npm run typecheck # tsc --noEmit
```

## If LiteLLM is enough for you, use LiteLLM

Need multi-provider routing, team management, or Postgres-backed budgets?
[LiteLLM Proxy](https://github.com/BerriAI/litellm) is the better tool.
sekimori deliberately covers the step *before* that: Anthropic only, one
person publishing to their own circle, `hono` as the only runtime
dependency — for when LiteLLM feels like overkill for a weekend app.

## Non-goals

Multi-tenant SaaS, billing integration, dashboards, prompt management,
caching, retry logic, 100-provider support, horizontal scaling. See
[docs/design.md](docs/design.md) and [CONTRIBUTING.md](CONTRIBUTING.md) —
these are declared so your PR time is never wasted on them.

## Project process

- Design / review: Claude (Fable 5)
- Implementation: Claude (Sonnet 5), delegated per issue
- Publishing, deployment, naming decisions: human ([@yktsnd](https://github.com/yktsnd))

## Status

- 2026-07: MVP + DX-review fixes complete; standalone repo extracted.
  Current work: v0.2 "distribution-ready" (see [ROADMAP.md](ROADMAP.md)).
