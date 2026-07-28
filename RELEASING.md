# Releasing sekimori

This is a **release gate**, not an aspiration list. Do not call sekimori a
public release until every applicable item below has an owner and evidence.
It prevents a package upload from being mistaken for a trustworthy launch.

## Before a first public release

- [x] [Release-candidate PR #18](https://github.com/yktsnd/sekimori/pull/18)
  is **merged** into the default branch (merge commit `10b5750`). Its five CI
  jobs and required CodeQL security gate passed on 2026-07-18. Three
  release-blocking defects were found and fixed *after* that CI run — #24
  (`init` failed when a weak secret was already exported), #27 (`doctor`
  reported `ok` while a stale file-store lock actually blocked startup), and
  #25 (added `docs/deploy.md` from an executed deployment rehearsal). This
  gate item is evidenced against the commit that is actually released, not
  against `main` in the abstract: on 2026-07-28, from a clean checkout of the
  commit carrying those three fixes, `npm ci`, `npm run typecheck`, `npm
  test` (200 tests: 199 passed, 1 skipped, 0 failed), `npm run demo` (all 18
  scripted checks passed), `npm run test:pack` (all 10 packaged-tarball
  smoke-test steps passed), `npm pack --dry-run` (35 files — runtime,
  examples, docs, license, manifests; no config, state, log, or secret
  material), and `npm audit --omit=dev` (0 vulnerabilities) all passed
  locally. **Re-verify this item — rerun the checks above and re-read the CI
  run for the exact commit — every time `main` advances before publish**;
  this evidence does not carry forward to a later commit automatically. The
  public default branch must contain the current README, security policy,
  CI, docs, and tests; do not make an older branch public by accident.
- [x] The maintainer deliberately made the repository public on 2026-07-18.
  A file-path and credential-pattern scan across every Git revision found no
  committed config, state, token, private key, or provider credential. This
  evidence does not replace GitHub secret scanning or credential revocation if
  a later finding appears.
- [x] Record the preliminary name check. On 2026-07-18 the maintainer reported
  that a J-PlatPat search for `sekimori` found no registered mark. This is a
  project naming decision, not legal clearance. The official npm registry
  endpoint returned `404` for `sekimori` on 2026-07-18 and again on
  2026-07-28; availability must still be rechecked immediately before publish
  because an unused name is not reserved.
- [x] The maintainer explicitly authorized replacing the personal Gmail
  address in commit author and committer metadata. Before this release
  candidate was pushed, every published branch was rewritten to use the
  repository's existing GitHub noreply address and rescanned.
- [x] The maintainer approved `0.2.0` as the first public version and `YK` as
  the MIT license copyright holder on 2026-07-18.
- [x] Set an accurate one-sentence GitHub description and repository topics;
  both were verified through the GitHub API on 2026-07-18.
- [x] Prepare `.github/social-preview.jpg` at GitHub's recommended 1280 x 640
  size and below its 1 MB upload limit. Re-verified 2026-07-28: 1280x640,
  ~117 kB.
- [x] Upload that image in GitHub repository Settings and verify the rendered
  preview. Do not claim a registry install, production deployment, performance
  level, or user adoption that has not been verified. Verified 2026-07-28:
  fetching the public repository page returns `og:image` and `twitter:image`
  meta tags pointing at `repository-images.githubusercontent.com/...`
  (GitHub's uploaded-image host), not the default generated
  `opengraph.githubassets.com` card — which is how a custom uploaded social
  preview presents. Both READMEs now also show the banner via the absolute
  `raw.githubusercontent.com/yktsnd/sekimori/main/.github/social-preview.jpg`
  URL, verified `200`/`image/jpeg` with `curl -sSI`, so it also renders on the
  npm package page where `.github/` is not shipped.
- [x] Checked GitHub's community profile and the repository from a signed-out
  browser on 2026-07-28: `raw.githubusercontent.com/yktsnd/sekimori/main/…`
  returned `200` for README.md, LICENSE, CONTRIBUTING.md,
  CODE_OF_CONDUCT.md, SUPPORT.md, SECURITY.md, and every file under
  `.github/ISSUE_TEMPLATE/` (`config.yml`, `bug_report.yml`,
  `feature_request.yml`, `question.yml`) plus `.github/pull_request_template.md`.
  Every URL in `.github/ISSUE_TEMPLATE/config.yml` (the security-advisory
  link, the `SUPPORT.md` blob link, the `CONTRIBUTING.md` blob link) points
  at `yktsnd/sekimori` and the `main` branch. `api.github.com` is not
  reachable from this sandbox, so the GitHub-computed "community profile"
  checklist score itself could not be re-fetched; the underlying files it
  scores were confirmed present and current instead. `https://github.com/yktsnd/sekimori`
  itself loads signed-out with the correct description, topics, README
  rendering, MIT license, and `main` as the default branch.
- [x] Verified every README badge from the public default branch on
  2026-07-28. The CI badge (`.../actions/workflows/ci.yml/badge.svg`) renders
  and currently reads "passing" for `main`'s HEAD; the License badge renders
  "MIT". Neither badge advertises an npm package, a production deployment, or
  any adoption/performance number — there is no npm-version badge in the
  README, consistent with no package being published yet. **This reflects
  `main` as it stood on 2026-07-28, before this branch's commits merge —
  re-check both badges again after merge**, since the CI badge tracks
  whatever `main`'s latest workflow run reports.
- [x] Enable GitHub private vulnerability reporting; the GitHub API reported it
  enabled on 2026-07-18.
- [ ] Test private vulnerability reporting from a non-maintainer account
  without submitting a real vulnerability. **Optional/deferrable —
  maintainer-only, needs a second GitHub account; see the maintainer
  checklist below.**
- [x] **Non-blocking.** The private X Direct Message route documented in
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) needs a maintainer-only settings
  check (whether `@yktsnd`'s account currently accepts DMs from
  non-followers) that no agent can perform. It does not block the release
  gate because the document already specifies a fallback for exactly this
  case: "If X does not let you open a Direct Message, open a public issue
  only to request another private channel; include no report details." A
  reporter is never stuck without a private path. Recorded 2026-07-28;
  actually sending a probe DM is listed as optional/deferrable in the
  maintainer checklist below, not required before opening participation.
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
- [x] Confirmed issue/discussion routing on 2026-07-28. Discussions are not
  enabled (issues only); `.github/ISSUE_TEMPLATE/config.yml` sets
  `blank_issues_enabled: false` and routes: security reports to GitHub
  private advisories (`.../security/advisories/new`, never a public issue);
  setup/support questions to `SUPPORT.md` via the "Support and safe reporting
  guidance" contact link; and proposed changes to `CONTRIBUTING.md`.
  `bug_report.yml` and `feature_request.yml` ask for the sekimori
  version/commit, Node.js version, OS, a redacted config, and a minimal
  offline reproduction — they do not solicit a provider key, admin key, or
  invite token, and `SUPPORT.md` explicitly warns against pasting any of
  those into an issue.
- [ ] Execute a real HTTPS deployment using an approved hosting account and
  a tiny approved budget. Run the live checks in [AGENTS.md](AGENTS.md),
  measure the end-to-end path, and only then write deploy instructions.
  [docs/deploy.md](docs/deploy.md) already documents an executed rehearsal
  of the packaged tarball on real OS processes — install, non-interactive
  `init`, `doctor`, boot, admin token issue, a `/v1/messages` round trip
  through a mock upstream, graceful restart (SIGTERM), and hard-kill crash
  recovery (SIGKILL) — which is everything that does not require a hosting
  account. It deliberately does **not** satisfy this item: no hosted HTTPS
  deployment has been executed against a real provider key. That remains
  credential-gated on the maintainer and is tracked in
  [issue #9](https://github.com/yktsnd/sekimori/issues/9).
- [x] Re-checked provider pricing, billing controls, API-key guidance, and
  model access against their official documentation on 2026-07-28:
  - **Anthropic pricing**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`,
    the model shipped in `sekimori.config.example.json`) is
    $1.00/$5.00 per MTok input/output on the current official pricing
    ([platform.claude.com/docs/en/pricing](https://platform.claude.com/docs/en/pricing.md);
    corroborated via web search of the live rate card). This **matches** the
    example config's `inputPerMTok: 1.0` / `outputPerMTok: 5.0` exactly — no
    correction needed. `docs/configuration.md`'s "Notes on prices" section
    already states these are reference values the operator must re-verify
    against current pricing before relying on them; that framing remains
    accurate and was left unchanged.
  - **Anthropic prepaid credit / auto-reload**: confirmed against
    [support.claude.com/en/articles/8977456](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)
    (reachable, `200`). Credit is purchased on the Console Billing page;
    auto-reload (when enabled) charges a configured amount whenever the
    balance drops below a configured threshold; purchased credit expires one
    year from purchase and is non-refundable. This matches
    [docs/owner-guide.md](docs/owner-guide.md)'s existing guidance ("review
    every available spend control and deliberately choose the auto-reload
    behavior"; "turn auto-reload off if you do not want it to buy more
    prepaid credit") — already correctly hedged as "current official billing
    guidance" rather than a hard-coded number, so no edit was needed.
  - **Amazon Bedrock API-key (Bearer) authentication**: confirmed against
    [docs.aws.amazon.com/bedrock/.../api-keys-reference.html](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html)
    (reachable, `200`). AWS explicitly recommends long-term Bedrock API keys
    only for **exploration**, and short-term credentials (≤12 hours) for
    production workloads with stronger security requirements. This matches
    [docs/owner-guide.md](docs/owner-guide.md) and
    [docs/configuration.md](docs/configuration.md)'s existing "Important
    credential limit" / static-key-is-a-prototype-integration language
    verbatim — no correction needed.
  - **Bedrock model-access requirement**: confirmed against
    [docs.aws.amazon.com/bedrock/.../model-access.html](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
    (reachable, `200`). Access to Bedrock foundation models is enabled by
    default given the correct AWS Marketplace IAM permissions
    (`aws-marketplace:Subscribe` etc.); Anthropic models specifically still
    require a one-time "First Time Use" use-case form per account (or per
    AWS Organization management account) before first invocation, submitted
    either through the console or the `PutUseCaseForModelAccess` API — this
    does **not** apply when going through the separate `bedrock-mantle`
    endpoint, which sekimori does not use (it calls the classic
    `InvokeModel` endpoint). This matches the existing "Anthropic models
    require a one-time use-case form for most accounts" wording in
    [docs/configuration.md](docs/configuration.md) and
    [docs/owner-guide.md](docs/owner-guide.md) — no correction needed.
  - **AWS free/promotional credits applying to Bedrock**: neither official
    page makes any claim about promotional AWS credits covering Bedrock
    usage, and neither project doc asserts that they do —
    [docs/owner-guide.md](docs/owner-guide.md) already says only "if you
    already have AWS credits that are eligible for Bedrock, you may be able
    to use them" and tells the owner to "confirm eligibility, expiry, and
    any Marketplace terms in your own AWS account." That is exactly what the
    two official pages support (eligibility is Marketplace- and
    account-specific, not a blanket promise) — already correctly hedged, no
    correction needed.
  - No stale number or unverifiable claim was found in
    `sekimori.config.example.json`, `docs/owner-guide.md`,
    `docs/owner-guide.ja.md`, or `docs/configuration.md`; nothing in those
    four files was edited by this pass.

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
   **(Agent-doable: re-run the `registry.npmjs.org/sekimori` check; only
   *accepting* the residual risk is the maintainer's call.)**
2. Update both package manifests and [CHANGELOG.md](CHANGELOG.md), merge the
   verified commit to `main`, and manually run `Publish npm` with the exact
   version and confirmation phrase. Use `bootstrap-token` only for the first
   package creation; use `trusted-publisher` thereafter, then inspect and
   approve the staged artifact in npm. **(Manifest/changelog edits and the
   merge are agent-doable; triggering `Publish npm` and the npm/2FA approval
   are maintainer-only — see the checklist below.)**
3. Create an annotated `vX.Y.Z` tag and GitHub Release pointing at the same
   commit; include the changelog notes and supported Node version.
   **(Agent-doable once the package exists on npm.)**
4. In a new empty directory, install from the public registry and verify the
   actual artifact, not a local tarball. **(Agent-doable once the package
   exists on npm.)**

   ```bash
   npx sekimori@X.Y.Z --help
   npx sekimori@X.Y.Z demo
   npx sekimori@latest doctor --help
   ```

5. Confirm npm displays the intended README, license, repository link, version,
   provenance, supported Node range, and unpacked file list. **(Agent-doable
   — read the public npm package page.)**
6. Confirm the GitHub tag, Release, npm version, and default branch identify the
   same release commit and changelog entry. **(Agent-doable.)**
7. Record the registry-install result and the live-deployment evidence in the
   release notes or linked issue. **(Agent-doable.)**

If any check fails, stop the release, fix it, and repeat the verification on
the new commit.

---

## MAINTAINER-ONLY — remaining work, in order

Everything above this line that an agent could evidence or execute has been
done, including uploading `.github/social-preview.jpg` as the repository's
social preview (verified 2026-07-28 — see the release gate above). Everything
below can **only** be done by the maintainer personally — either because it
requires an authenticated human decision (2FA, account creation, clicking
"approve") or because GitHub/npm expose no API for it. What remains is the
entire npm-publish sequence (steps 1–6) plus one forward-looking GitHub
account setting (step 7) and the optional/deferrable items (step 8); the
maintainer has not started any of the npm steps yet. Do these in order;
nothing later in the list unblocks until the item before it is done.

1. **Create an npm account with two-factor authentication enabled**, if the
   maintainer does not already have one. [npmjs.com/signup](https://www.npmjs.com/signup) →
   account Settings → enable 2FA. ~5 minutes.
2. **Generate a short-lived, granular npm publish token** scoped to the
   `sekimori` package name (or "publish new packages" if the name doesn't
   exist on npm yet), with the shortest expiry npm offers. npm Console →
   Access Tokens → Generate New Token → Granular Access Token. ~2 minutes.
3. **Store that token as the `NPM_TOKEN` secret in the existing `npm-publish`
   GitHub Environment.** Repository → Settings → Environments →
   `npm-publish` → Environment secrets → Add secret. ~2 minutes.
4. **Run the `Publish npm` GitHub Actions workflow** with version `0.2.0`,
   authentication `bootstrap-token`, and the workflow's exact required
   confirmation phrase (check the workflow's `workflow_dispatch` inputs for
   the literal string it expects — do not guess it). Actions tab →
   `Publish npm` → Run workflow. **Then approve the environment deployment**
   when GitHub pauses the run for the `npm-publish` reviewer gate (the
   maintainer is the configured required reviewer). ~5 minutes plus however
   long it takes to notice the pending-approval notification.
5. **Inspect and 2FA-approve the staged package on npm** once the workflow
   stages it. npm sends a publish-approval prompt (email or npm CLI/web,
   depending on account settings) — verify the package name, version, and
   file list look right, then approve with the 2FA code. ~5 minutes.
6. **After the package exists on npm, configure npm Trusted Publishing** for
   this exact repository, the `publish.yml` workflow filename, and the
   `npm-publish` environment (npm package Settings → Publishing access →
   Trusted Publisher). **Then delete the `NPM_TOKEN` GitHub secret and
   revoke the granular token** from step 2 (npm Console → Access Tokens →
   Revoke). ~5 minutes.
7. **One GitHub account setting, forward-looking only:** enable "Keep my
   email address private" in GitHub → Settings → Emails, so that any merge
   commits authored or created from this account going forward use the
   GitHub-generated noreply address automatically instead of a personal one.
   This is unrelated to the historical address rewrite already recorded
   above in this file — it only affects future commits. ~1 minute.
8. **Optional / deferrable — do not block publish on these:**
   - Test GitHub private vulnerability reporting end-to-end from a second,
     non-maintainer GitHub account (open a draft advisory, confirm the flow
     works, do not submit a real vulnerability).
   - Confirm the X DM route in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
     actually accepts a message from a non-follower — send yourself (or have
     someone else send) a test DM to `@yktsnd`.
   - Execute a real hosted HTTPS deployment against an approved hosting
     account and provider key, per [issue #9](https://github.com/yktsnd/sekimori/issues/9)
     — this is a separate piece of work from the npm publish and does not
     block it.

Once step 6 above is done, hand the session back to an agent for tagging,
the GitHub Release, and the `npx sekimori@0.2.0` post-publish verification
(steps 3–7 in "Publish and verify" above) — none of that needs maintainer
credentials.
