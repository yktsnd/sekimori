# Owner guide — everything that's yours to do, assuming zero prior knowledge

This page is for the **owner of the app — not the person (or agent) building
it**. No programming or server knowledge is assumed. 日本語版:
[owner-guide.ja.md](owner-guide.ja.md).

Your app is built by you or by a coding agent you instructed (Claude Code
etc.), and the agent can also do the publishing. Along the way, **only three
things are yours to do**:

1. **Set up the account that pays for the AI (the API key)**
2. **Set up an account for the place the app runs (hosting)**
3. **Decide**: how much money per month is acceptable, and who gets invited

Each is explained below from "what even is this".

---

## 1. What an API key is (the thing called an "Anthropic key")

The AI (Claude) doesn't run on your computer — it runs on the provider's
computers (Anthropic's, or Amazon's). Every time your app sends the AI a
question, the provider needs to know *whose request this is and who to
bill*. The long string used as that proof of identity (e.g.
`sk-ant-api03-...`) is an **API key**.

So an API key is **"a key to AI usage that is wired to your payment"**.
Which is why:

- Anyone holding the key can use the AI **on your money**. **Never paste it
  into social media or shared chats.**
- This is exactly why sekimori exists: the key lives only on the server, and
  the people using your app get **invite tokens** (permits with spending
  limits) instead. The provider key is not handed to end users.

### Two ways to get one (either is fine)

**Option A: directly from Anthropic**

1. Create an account at [console.anthropic.com](https://console.anthropic.com)
   (an email address is enough)
2. Register the payment method/credit required by the account. Before sharing
   the app, use Anthropic's current official billing guidance to review every
   available spend control and deliberately choose the auto-reload behavior.
3. On the "API Keys" page, click "Create Key" and save the `sk-ant-...`
   string using the provider's current secret-storage guidance (the full value
   may be shown only at creation)
4. Configure the provider-side spend/billing controls currently available to
   the account as an independent layer alongside sekimori

Cost depends on the chosen model, its current pricing, your configured price
table, and traffic. Check the provider's current pricing and billing settings
before launch. sekimori is an additional protective boundary for its supported
text-only request scope; it is **not** a replacement for checking provider
billing controls or keeping its configured prices accurate.

**Option B: through Amazon Bedrock (if you hold AWS credits)**

If you already have AWS credits that are eligible for Bedrock, you may be able
to use them for Amazon's AI service, where Claude is also available. Confirm
eligibility, expiry, and any Marketplace terms in your own AWS account.
sekimori supports Bedrock for a small prototype, with the important limits
below.

1. Create an [AWS account](https://aws.amazon.com/) (or use the one you have)
2. In the AWS console, select the Anthropic model you plan to use and follow
   the current model-access prerequisites. Anthropic models may require a
   one-time use-case form; Marketplace permissions and region/account
   settings also matter.
3. For this integration, create a Bedrock API key and put it only in the
   host's secret/environment-variable settings.
4. Record the key's expiry and rotate it before expiry. sekimori reads a
   static environment variable and does **not** refresh AWS credentials for
   you.

**Important credential limit**: AWS describes long-term Bedrock API keys as
an exploration convenience and recommends short-term credentials for
applications with stronger security requirements. Because sekimori currently
uses a static Bearer key, treat this Bedrock mode as a prototype integration,
not a long-running production credential design. Use Anthropic direct or a
deployment/authentication design that refreshes short-term credentials when
that assurance is needed.

**Streaming caveat**: through Bedrock, sekimori currently cannot do the
"text flows in word by word" display (streaming) — **responses appear all
at once**. Clients must send `"stream": false`. (Support is on the roadmap.)

> Rule of thumb: choose Bedrock only after confirming its account, access,
> billing, region, and key-lifecycle requirements fit your prototype.
> Anthropic direct supports streaming here; Bedrock currently does not. Choose
> based on the account, billing, region, key-lifecycle, and streaming
> requirements you actually verified.

## 2. What a hosting account is

If the app runs on your own computer, it stops when the laptop closes and
nobody else can reach it. A service that keeps your program running on **a
rented computer that is always connected to the internet** is called
*hosting*. "Set up a hosting account" means **registering with such a
service with your email and, where required, a payment method**. Choose a
service only after checking its current pricing, secret storage, HTTPS,
durable-volume, logging, and one-replica controls; sekimori has not yet
published a verified hosting recipe.

- Which service to pick and all configuration afterwards can be **left
  to your operator after you approve the provider, account, and possible
  charges. Ask it to show current official pricing and the verified deployment
  evidence before you create an account
- The card here pays for *the place the app lives*; the key from Option
  A/B pays for *AI usage*. They are **separate bills**.

## 3. What you decide (the questions your agent will ask)

| Question | Meaning | How to decide |
|---|---|---|
| Monthly cap? | Total configured AI allowance per month, everyone combined. A supported request stops before its conservative reservation would exceed the local accounting ceiling; keep provider billing controls on too | Choose the maximum amount you personally accept. There is no project default recommendation, and an agent must not invent it |
| Daily per person? | The configured share one invite may use per UTC day | Choose a fraction of your monthly amount based on how many people you will invite; approve the number yourself |
| Who gets invited? | Who receives an invite code (token). Each one can be revoked instantly | — |

## 4. Handing the key to your agent safely

The API key is a secret. Only the handover needs care:

- **Good**: paste it yourself into the hosting service's "environment
  variables" / "Secrets" settings (your agent will point you to the exact
  screen), or follow the secure procedure your agent prepares
- **Avoid**: anywhere public or shared — social media, shared chat logs,
  inside the app's source code
- If a key ever leaks, **revoke it** in the issuer's console (Anthropic
  Console / AWS) and rotate the environment variable. sekimori's caps add a
  protective limit, but you should still treat a leaked key as urgent and
  verify provider-side billing and access controls.

## 5. What to check once setup is done

After setup, the agent sends you a **protection summary** like this (it is
generated by sekimori's built-in self-check, `doctor`):

> - Allowed models: <verified allowlisted model(s)>
> - Monthly cap: $<your approved total>; $<your approved daily amount> per person
> - Rate limit: <configured number> requests/rolling minute per person
> - Conversation contents are not logged
> - The provider and admin keys are configured server-side

At minimum, verify that **the numbers are exactly the ones you chose** and the
models/prices are the ones the operator re-checked. This summary is not a
technical audit: also require the successful `doctor` result and live
blocked/allowed checks described in [AGENTS.md](../AGENTS.md), and review your
provider billing controls. If a number is wrong, do not issue invite tokens;
tell the operator the exact approved value and have the checks repeated.

## FAQ

**Q. I'm worried about an unbounded AI bill.**
A. Use layers: (1) configure sekimori with correct, current prices and caps
for its supported text-only requests; (2) review the provider's billing
settings; and (3) for Anthropic, turn auto-reload off if you do not want it to
buy more prepaid credit. With AWS, configure budget alerts and review the
account's own spend controls. No single setting replaces the others.

**Q. Can I use AWS credits with Bedrock?**
A. Possibly—check that your credits and account are eligible. sekimori
supports Bedrock API-key authentication for a prototype, but its static-key
integration does not refresh short-term credentials and streaming display is
not supported yet, so responses appear all at once.

**Q. What if an invited friend overuses it?**
A. For the supported request subset and correctly declared model prices, only
that token is stopped before a reservation would exceed its configured daily
accounting ceiling and resumes the next UTC day. If a reservation would exceed
the configured monthly ceiling, all tokens pause
until next month. Keep provider-side billing controls enabled as an independent
layer.

**Q. What if I want to shut the app down?**
A. Tell your agent "stop it" and it stops the app at the hosting service.
Revoking the API key at the issuer shuts off AI usage completely.

**Q. Where are the technical details?**
A. [README](../README.md) (developers) and [AGENTS.md](../AGENTS.md)
(agents). You don't need to read them.

## Official account guidance

Provider account rules change independently of sekimori. Check these primary
sources again when setting up or renewing a deployment:

- [Anthropic API billing and auto-reload](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)
- [Amazon Bedrock API-key lifecycle and intended use](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html)
- [Amazon Bedrock model-access prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
