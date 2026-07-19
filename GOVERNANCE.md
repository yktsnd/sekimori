# Governance

sekimori is intentionally a small, single-maintainer project. This document
makes that operating model explicit so contributors know how decisions are
made.

## Maintainer and decisions

The repository owner is the maintainer and makes final decisions on scope,
releases, security response, and moderation. Contributors are welcome to
propose changes, but contribution does not create an expectation that a
proposal will be accepted or maintained indefinitely.

The decision criteria, in order, are:

1. Preserve the security boundary and fail-closed behaviour.
2. Keep the supported use case reviewable by one maintainer.
3. Improve a real user's first successful deployment or operation.
4. Avoid new dependencies and ongoing operational obligations unless the
   benefit clearly outweighs them.

The permanent non-goals in [CONTRIBUTING.md](CONTRIBUTING.md) are part of
this governance model. A polite "no" to a well-built feature is not a
judgment on its value; it protects the project's stated scope.

## How changes are made

- Behaviour, config schema, endpoint/error shapes, or runtime dependencies
  need an issue and an agreed rationale before implementation.
- Security fixes may be developed privately and released without a public
  design discussion.
- Releases require the checks in [RELEASING.md](RELEASING.md), not just a
  version bump.
- The maintainer may delegate review or implementation, but remains
  accountable for what is merged.

## Continuity

There is no guarantee of response time, feature delivery, or long-term
maintenance. If the project becomes inactive, its MIT license permits users
to fork it. Major scope or stewardship changes will be recorded in the
repository rather than implied by silence.
