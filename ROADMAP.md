# Roadmap

sekimori aims to become **done software**: a small, dependable tool that does
not need permanent feature expansion to remain useful. The permanent scope is
defined in [docs/design.md](docs/design.md); this roadmap tracks the remaining
distance between a locally verified release candidate and a release that a
stranger can independently install and trust.

Capability labels below are not published SemVer versions. Until an npm
artifact, Git tag, GitHub Release, and default-branch commit all agree, there
is no released version. [RELEASING.md](RELEASING.md) is authoritative for that
transition.

The owner/operator/contributor design came from three reviews:
[sustainability](docs/history/05-sustainability-review.md),
[agent operation](docs/history/06-agent-operator-review.md), and
[owner onboarding](docs/history/07-owner-onboarding-review.md).

## Implemented in the release candidate

- **Distribution foundation:** English-first project documentation, npm
  package layout and binary, clean-install pack smoke test, CI, contribution
  and governance files, a cross-platform offline demo, and a manual,
  provenance-enabled npm publish workflow with fail-closed release preflight.
- **Deterministic operation:** non-interactive `init`, per-setting CLI flags,
  `doctor --json`, stable error types, expected exit behavior, and an agent
  operations manual in [AGENTS.md](AGENTS.md).
- **Owner onboarding:** English and Japanese owner guides explaining keys,
  hosting, budget decisions, and both Anthropic-direct and AWS Bedrock paths.
- **Safety boundary:** invite/admin authentication, exact model allowlist,
  conservative atomic budget reservations, bounded requests/responses, rate
  and active-request controls, pinned system prompts, exact-origin CORS,
  restart-safe file storage, and fail-closed behavior for ambiguous accounting.
- **Supported providers:** Anthropic Messages API (non-streaming and SSE) and
  Amazon Bedrock `InvokeModel` (non-streaming only).

These statements describe the working tree/release candidate. They do not
claim that the same files are already on the default branch or in a registry
package, and must be re-verified on the exact release commit.

## First public release gates

### Maintainer or account authority required

- [ ] Review and merge [release-candidate PR #18](https://github.com/yktsnd/sekimori/pull/18)
      into the intended default branch; all five required CI jobs are green.
- [x] Record the maintainer's 2026-07-18 J-PlatPat search for `sekimori` (no
      registered mark found) as a naming-risk decision, not legal clearance.
- [ ] Reconfirm npm name availability immediately before publish.
- [x] Use `0.2.0` as the first public version, as approved by the maintainer on
      2026-07-18; retain `YK` as the approved MIT copyright holder.
- [x] Make the repository public deliberately and scan every Git revision for
      sensitive paths and credential patterns (no matches found on 2026-07-18).
- [x] Replace the personal Gmail address in author and committer metadata with
      the repository's existing GitHub noreply address across every published
      branch, as explicitly authorized by the maintainer.
- [x] Enable private vulnerability reporting.
- [ ] Test private vulnerability reporting from a non-maintainer account.
- [ ] Verify the documented X Direct Message conduct-reporting route accepts a
      private message.
- [x] Enable secret scanning, push protection, Dependabot security updates,
      CodeQL Extended, immutable GitHub Releases, read-only default Actions
      permissions, and full-SHA action pinning.
- [x] Configure an active default-branch ruleset after the history rewrite:
      require PRs and the five Linux/macOS/Windows CI checks; prevent deletion,
      force pushes, and direct unreviewed releases without requiring a second
      maintainer's approval.
- [x] Add accurate GitHub About text and repository topics.
- [x] Prepare a 1280 x 640, sub-1 MB social-preview asset in `.github/`.
- [ ] Upload the social preview and verify the community profile from a
      signed-out view.
- [ ] Publish with the maintainer's npm/GitHub authority, then create a matching
      Git tag and GitHub Release from the same verified commit.

### Real-world evidence required

- [ ] Deploy exactly one process behind HTTPS using an approved hosting
      account, approved provider credential, and owner-approved small budget.
- [ ] Run `doctor`, the blocked/allowed live checks in [AGENTS.md](AGENTS.md),
      token revocation, restart persistence, and provider round-trip checks.
- [ ] Re-check current provider prices, model access, key guidance, and billing
      controls using official provider documentation.
- [ ] Write deployment recipes only from the verified run, including rollback,
      secret rotation, durable storage, log access, and one-replica settings.
- [ ] Install the published package in a new empty directory and verify
      `npx sekimori@<version> demo`, `init`, `doctor`, and a local round trip.

## After release, only when pulled by evidence

New work needs an issue with a concrete user story and acceptance evidence.
Order improvements that shorten first success, reduce operator error, or close
a demonstrated safety gap ahead of new surface area.

Possible candidates, not commitments:

1. A verified deployment recipe for each hosting environment actually tested.
2. An application starter that makes the invite-token and error UX reusable.
3. Bedrock streaming, including eventstream-to-SSE conversion and complete
   usage extraction.
4. A provider abstraction paired with a fully specified request, response, and
   pricing model for any additional upstream.
5. A small operator-facing usage view if actual operation proves the HTTP API
   insufficient.
6. An alternative end-user authentication mode if bearer invite tokens are a
   demonstrated adoption blocker.

## Permanent non-goals

Multi-tenant SaaS, payment processing, provider billing replacement,
dashboards as a product, prompt/evaluation management, caching, automatic
retries, broad provider coverage, databases required for the core, and
horizontal scaling. Proposals may be discussed, but should not be presented as
accepted roadmap work without a scope decision.
