# Releasing sekimori

This is a **release gate**, not an aspiration list. Do not call sekimori a
public release until every applicable item below has an owner and evidence.
It prevents a package upload from being mistaken for a trustworthy launch.

## Before a first public release

- [ ] Review and merge [release-candidate PR #18](https://github.com/yktsnd/sekimori/pull/18)
  into the default branch. Its five CI jobs and required CodeQL security gate
  passed on 2026-07-18. The public default branch must contain the current
  README, security policy, CI, docs, and tests; do not make an older branch
  public by accident.
- [x] The maintainer deliberately made the repository public on 2026-07-18.
  A file-path and credential-pattern scan across every Git revision found no
  committed config, state, token, private key, or provider credential. This
  evidence does not replace GitHub secret scanning or credential revocation if
  a later finding appears.
- [x] Record the preliminary name check. On 2026-07-18 the maintainer reported
  that a J-PlatPat search for `sekimori` found no registered mark. This is a
  project naming decision, not legal clearance. The official npm registry
  endpoint returned `404` for `sekimori` on the same date; availability must
  still be rechecked immediately before publish because an unused name is not
  reserved.
- [x] The maintainer explicitly authorized replacing the personal Gmail
  address in commit author and committer metadata. Before this release
  candidate was pushed, every published branch was rewritten to use the
  repository's existing GitHub noreply address and rescanned.
- [x] The maintainer approved `0.2.0` as the first public version and `YK` as
  the MIT license copyright holder on 2026-07-18.
- [x] Set an accurate one-sentence GitHub description and repository topics;
  both were verified through the GitHub API on 2026-07-18.
- [x] Prepare `.github/social-preview.jpg` at GitHub's recommended 1280 x 640
  size and below its 1 MB upload limit.
- [ ] Upload that image in GitHub repository Settings and verify the rendered
  preview. Do not claim a registry install, production deployment, performance
  level, or user adoption that has not been verified.
- [ ] Check GitHub's community profile and the repository from a signed-out
  browser: README, license, contribution guide, code of conduct, support path,
  security policy, issue forms, and pull-request template must be discoverable
  and must point at the current repository/default branch.
- [ ] Verify every README badge from the public default branch. CI must reflect
  the release commit's workflow, and no badge may advertise an unpublished
  package, unverified deployment, or stale status.
- [x] Enable GitHub private vulnerability reporting; the GitHub API reported it
  enabled on 2026-07-18.
- [ ] Test private vulnerability reporting from a non-maintainer account
  without submitting a real vulnerability.
- [ ] Verify that the private X Direct Message route documented in
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) accepts a message before opening
  participation to strangers.
- [x] Protect the default branch. Active ruleset `Protect main` requires a
  pull request, resolved review conversations, and passing Linux Node.js
  20/22/24, macOS, Windows, and CodeQL security checks; it prevents branch
  deletion, force pushes, and direct unreviewed releases. Approval count
  remains zero so a single maintainer is not locked out; verified on
  2026-07-18.
- [x] Confirm GitHub Actions, Dependabot security updates, secret scanning, and
  push protection are enabled. Actions default to read-only permissions, only
  GitHub-owned Actions are allowed, and every action reference must use a full
  commit SHA; verified on 2026-07-18.
- [x] Enable weekly GitHub CodeQL default setup for JavaScript/TypeScript with
  the Extended query suite and remote threat model. Enable immutable GitHub
  Releases so a published release, its tag, and assets cannot be silently
  replaced; configured on 2026-07-18.
- [ ] Confirm issue/discussion routing: setup questions go to the documented
  support channel, security reports stay private, and bug/feature templates ask
  for reproducible evidence without soliciting secrets.
- [ ] Execute a real HTTPS deployment using an approved hosting account and
  a tiny approved budget. Run the live checks in [AGENTS.md](AGENTS.md),
  measure the end-to-end path, and only then write deploy instructions.
- [ ] Re-check provider pricing, billing controls, API-key guidance, and
  model access against their official documentation on release day.

## Build and package verification

Run these from a clean checkout with Node.js 20 or newer:

```bash
npm ci
npm run typecheck
npm test
npm run demo
npm run test:pack
npm pack --dry-run
npm audit --omit=dev
```

Every configured CI target must be green for the exact release commit.
`npm run test:pack` creates a tarball, installs it into a fresh project, runs
its packaged offline demo and doctor, starts the installed binary, and performs
an offline round trip; do not substitute a source-tree test for it. Inspect the dry-run
file list and the actual tarball: include the runtime, examples, license, and
operator documentation; exclude source secrets, local config, state, logs,
coverage, and unrelated working files.

## Publish and verify

These steps require the maintainer's explicit npm/GitHub authority. The
repository's manual `Publish npm` workflow is the intended path: it refuses a
development version, a non-`main` ref, a mismatched confirmation, a dirty
checkout, or a missing changelog entry, and requests npm provenance.

The `npm-publish` GitHub Environment was configured on 2026-07-18 with a
required `yktsnd` reviewer and protected-branch-only deployment policy. Confirm
those controls still exist before first use. The first publish may use a
short-lived granular `NPM_TOKEN` stored only in that Environment. Once the npm
package exists, configure npm Trusted Publishing for the exact repository,
`publish.yml` workflow filename, and `npm-publish` environment, allowing
`npm stage publish`; then delete the GitHub secret and revoke the token. Keep
two-factor authentication enabled on the maintainer account. Later workflow
runs stage the artifact; a maintainer must inspect and approve that staged
package with 2FA before it becomes public.

1. Reconfirm npm package-name availability and accept the recorded naming
   risk. The maintainer approved `0.2.0` as the first public version.
2. Update both package manifests and [CHANGELOG.md](CHANGELOG.md), merge the
   verified commit to `main`, and manually run `Publish npm` with the exact
   version and confirmation phrase. Use `bootstrap-token` only for the first
   package creation; use `trusted-publisher` thereafter, then inspect and
   approve the staged artifact in npm.
3. Create an annotated `vX.Y.Z` tag and GitHub Release pointing at the same
   commit; include the changelog notes and supported Node version.
4. In a new empty directory, install from the public registry and verify the
   actual artifact, not a local tarball:

   ```bash
   npx sekimori@X.Y.Z --help
   npx sekimori@X.Y.Z demo
   npx sekimori@latest doctor --help
   ```

5. Confirm npm displays the intended README, license, repository link, version,
   provenance, supported Node range, and unpacked file list.
6. Confirm the GitHub tag, Release, npm version, and default branch identify the
   same release commit and changelog entry.
7. Record the registry-install result and the live-deployment evidence in the
   release notes or linked issue.

If any check fails, stop the release, fix it, and repeat the verification on
the new commit.
