# Contributing to sekimori

Thanks for considering a contribution. This document exists to protect your
time: it tells you up front what is welcome, what needs discussion first, and
what will be declined regardless of quality.

## PRs that are welcome as-is

- Bug fixes (especially anything where sekimori fails **open** when it
  should fail closed — treat those as security-relevant, see
  [SECURITY.md](SECURITY.md))
- Tests that tighten existing guarantees
- Documentation fixes and clarifications (English is the primary language;
  fixes to `README.ja.md` are equally welcome)
- Implementations of the **supported extension points**
  (see [docs/design.md](docs/design.md)):
  - `Store` backends (`src/store.ts`) — e.g. Redis, SQLite, KV
  - Groundwork agreed in an issue for the upstream-provider abstraction

## Open an issue first

- Any new feature or behavior change — check [ROADMAP.md](ROADMAP.md) first;
  if it's not there, propose it with a concrete user story
- Anything that adds a runtime dependency (the default answer is no; the
  bar is "impossible or unsafe to do without it")
- Anything that changes error shapes, config schema, or endpoint semantics

## Non-goals (declined even if well-built)

Multi-tenant SaaS, billing integration, dashboards, prompt management,
caching, retry logic, multi-provider routing, horizontal scaling, databases
as a requirement. These aren't judgments about your idea's value — they are
the scope contract that keeps sekimori reviewable and maintainable by one
person. [LiteLLM](https://github.com/BerriAI/litellm) already serves most of
them well.

## Review principle: when in doubt, fail closed

The tie-breaker for every review is: **if a judgment call exists, sekimori
blocks rather than allows.** Unknown model → reject. Usage data missing →
bill worst-case. Store broken → block everything except `/healthz`. If your
PR makes sekimori more permissive in an ambiguous situation, expect to be
asked for a strong justification.

## Development

```bash
npm install
npm test              # node:test, fully offline, no API key needed
npm run typecheck     # tsc --noEmit
bash examples/demo.sh # end-to-end smoke test, offline, exits non-zero on any mismatch
```

All three must be green before review. Tests run without any real API key —
keeping it that way is a hard requirement for every PR.

## Style

- TypeScript strict; no new runtime dependencies
- Comments and messages in English
- Match the density and idiom of the surrounding code; comments explain
  constraints, not narration
