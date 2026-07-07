# Roadmap

sekimori aims to be **done software**: a small tool that converges on
finished, not a project that must grow forever to stay alive. The scope is
fixed by the [non-goals](docs/design.md); this roadmap is about closing the
gap between "works for its author" and "trustworthy for strangers", then
stopping.

The goal, revised by the two sustainability reviews
([round 1](docs/history/05-sustainability-review.md),
[round 2](docs/history/06-agent-operator-review.md)):

> The **owner** (a human who may know nothing about deployment or billing)
> supplies only a budget and an API key. The **operator** — typically a
> coding agent — installs, configures, verifies, and runs sekimori without
> human intervention, and hands the owner a plain-language summary of what
> is protected. A third-party contributor can still fix and extend the tool
> without ever contacting the maintainer.

Work is issue-driven: every item maps to a GitHub issue with acceptance
criteria. Items marked **[credential gate]** need the owner's accounts,
spend, or naming judgment — the agent team executes them the moment a human
provides credentials and approval; everything else is completable by the
agent team alone (design/review: Fable 5, implementation: Sonnet 5).

## v0.2 — "distribution-ready" ✅ (2026-07)

A third party can try sekimori in 5 minutes and contribute without
guessing. Shipped: sustainability review; reader-task docs with English as
the primary language; governance set (CONTRIBUTING/SECURITY/CHANGELOG/
templates); English-only source; npm packaging with a pack/boot smoke test;
`sekimori init`; minimal CI (Node 20/22, typecheck + 55 tests + offline
demo + pack smoke, ~30 s per job).

## v0.3 — "agent-ready" (in progress)

A coding agent can operate sekimori end-to-end deterministically — no TTY,
no guesswork, machine-verifiable results.

- [x] Agent-operator review: roles (owner / agent operator / end users),
      root causes, this plan
- [x] `AGENTS.md`: the operations manual written for agents (deterministic
      commands, expected outputs/exit codes, owner-report template, hard
      rules), shipped in the npm package (packaging wired in the init-flags
      issue); README/positioning updated so the agent use case is
      first-class
- [x] Fully non-interactive `sekimori init`: per-setting flags (`--port`,
      `--model name=input,output`, `--monthly-usd`, `--daily-usd`,
      `--rate-limit`, `--store`, `--cors-origin`, `--pinned-system`, ...)
      plus `--help`; agents never hand-edit JSON either
- [ ] `sekimori doctor <config>`: non-interactive self-check of a concrete
      installation (config validity, required env vars, store writability)
      with a plain-language summary for owners and `--json` + exit codes
      for agents

## v0.4 — "public release" (credential gates)

The release itself, plus proof that the 30-minute publish target holds in
the real world. Execution is agent work; each item starts the moment the
human provides the named credential/approval.

- [ ] **[credential gate: hosting account + API key]** Real-deployment
      verification: an agent session deploys one real prototype behind
      sekimori (e.g. Fly.io / Railway / VPS), runs the AGENTS.md
      verification steps against the live instance, and measures
      prompt-to-published wall-clock time against the 30-minute target.
      The owner's only actions: provide hosting credentials and the
      Anthropic key, approve the budget numbers
- [ ] Deploy guide (`docs/deploy.md`): 2–3 recipes written **from that
      measured run** — never from imagination (unverified deploy steps are
      debt). Written for agent execution first (deterministic steps +
      verification), readable by humans second
- [ ] **[credential gate: naming judgment]** Name/trademark sanity check
      for "sekimori"
- [ ] **[credential gate: npm account]** `npm publish` + v0.2.0 tag/release
      notes; verify `npx sekimori@latest` boots from the registry

## Later (only if pulled by real usage)

Ordered by "shortens the first 5 minutes" > "adds deployment options".
Each requires an issue with a concrete user story before any code.

1. OpenAI-compatible upstream (`/v1/chat/completions`) — introduced together
   with a formal upstream-provider abstraction (one of the two supported
   extension points)
2. Cloudflare Workers + Durable Objects deployment
3. BYOK mode (users bring their own key; zero budget risk for the developer)
4. Magic-link / OAuth end-user auth (upgrade path from invite tokens)
5. Single-page static usage view
6. `npm create sekimori` scaffold (frontend starter included)
7. MCP server exposing admin operations as tools — only if real agent
   operation shows the CLI + HTTP API surface is not enough
8. Publish-readiness auditor (the shelved alternative concept, revisited)

## Non-goals (permanent)

Multi-tenant SaaS, billing integration (Stripe), dashboards, prompt
management/evals, caching, retries, 100-provider support, horizontal
scaling, databases. See [docs/design.md](docs/design.md) — proposals to
change these are welcome as discussions, but the default answer is no.
