# Roadmap

sekimori aims to be **done software**: a small tool that converges on
finished, not a project that must grow forever to stay alive. The scope is
fixed by the [non-goals](docs/design.md); this roadmap is about closing the
gap between "works for its author" and "trustworthy for strangers", then
stopping.

The goal, from the [sustainability review](docs/history/05-sustainability-review.md):

> A third party can — without ever contacting the maintainer —
> **(a) try sekimori in 5 minutes, (b) publish an app behind it in 30
> minutes, and (c) contribute without guessing.**

Work is issue-driven: every item below maps to a GitHub issue with acceptance
criteria. Items marked **[human]** involve publishing, spending money, or
legal judgment and are reserved for the human maintainer; everything else can
be completed by the agent team (design/review: Fable 5, implementation:
Sonnet 5).

## v0.2 — "distribution-ready" (in progress)

Goal (a) and (c). Everything here is verifiable inside the repo.

- [x] Sustainability review: ideal state, root causes, goals
- [x] Docs restructured around reader tasks; English as the primary language
      (README landing + `README.ja.md`; current-truth references in `docs/`;
      round records frozen in `docs/history/`)
- [x] Governance docs: CONTRIBUTING, SECURITY, CHANGELOG, issue/PR templates
- [x] English-only source: comments, log output, CLI messages, reference
      client UI text
- [x] npm packaging: `tsc` build to `dist/`, `sekimori` bin, package
      metadata; `npx` from a packed tarball verified as a smoke test
      (actual registry publish is a v0.3 human gate)
- [x] `sekimori init`: interactive config generator (zero new dependencies),
      so the first five minutes never involve hand-editing JSON
- [ ] Minimal CI (GitHub Actions): typecheck + tests + offline demo +
      pack/boot smoke; fast enough that it never gets disabled

## v0.3 — "public release" (human gates)

Goal (b) and the release itself. These need real deployments, real spend, or
naming judgment, so they are **[human]**-owned; agent work resumes only where
measurements come back.

- [ ] **[human]** Dogfooding: publish one real prototype through sekimori;
      measure "clone/`npx` → deployed" against the 30-minute target
      (success criterion from the original concept)
- [ ] Deploy guide (`docs/deploy.md`): 2–3 recipes (e.g. Fly.io / Railway /
      VPS + Caddy), HTTPS assumed, admin-key generation — written **from the
      dogfooding measurements**, never from imagination (unverified deploy
      steps are debt)
- [ ] **[human]** Name/trademark sanity check for "sekimori"
- [ ] **[human]** `npm publish` + v0.2.0 tag/release notes

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
7. Publish-readiness auditor (the shelved alternative concept, revisited)

## Non-goals (permanent)

Multi-tenant SaaS, billing integration (Stripe), dashboards, prompt
management/evals, caching, retries, 100-provider support, horizontal
scaling, databases. See [docs/design.md](docs/design.md) — proposals to
change these are welcome as discussions, but the default answer is no.
