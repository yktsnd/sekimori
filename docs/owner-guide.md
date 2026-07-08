# Owner guide — everything that's yours to do, assuming zero prior knowledge

This page is for the **owner of the app — not the person (or agent) building
it**. No programming or server knowledge is assumed. 日本語版:
[owner-guide.ja.md](owner-guide.ja.md).

Your app is built by you or by a coding agent you instructed (Claude Code
etc.), and the agent can also do the publishing. Along the way, **only three
things are yours to do**:

1. **Set up the account that pays for the AI (the API key)** — 10–15 min
2. **Set up an account for the place the app runs (hosting)** — 10 min
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
  caps) instead. The key itself is never handed to anyone.

### Two ways to get one (either is fine)

**Option A: directly from Anthropic (the standard route)**

1. Create an account at [console.anthropic.com](https://console.anthropic.com)
   (an email address is enough)
2. Register a payment method and **buy prepaid credit** (from about $5;
   usage draws it down — nothing is auto-charged beyond what you bought)
3. On the "API Keys" page, click "Create Key" and save the `sk-ant-...`
   string (**it is shown only once, on that screen**)
4. For extra peace of mind you can also set a **monthly spend limit** in
   Anthropic's console — a second wall in addition to sekimori's caps

Cost ballpark: a small app shared with a few friends usually lands at
**$0.5–$5 per month**. sekimori enforces your cap, so surprise bills cannot
happen.

**Option B: through Amazon Bedrock (if you hold AWS credits)**

The **free credits from signing up for AWS can be applied to Bedrock**,
Amazon's AI service — and Claude runs on Bedrock too. sekimori supports
Bedrock (with one caveat, below).

1. Create an [AWS account](https://aws.amazon.com/) (or use the one you have)
2. In the AWS console, open "Amazon Bedrock" and request **model access**
   for Anthropic Claude (a short use-case form; usually approved quickly)
3. On Bedrock's "API keys" page, **generate an API key** (this is the
   equivalent of Option A's key)
4. Check the credit terms (which services, expiry) on the AWS side

**Caveat**: through Bedrock, sekimori currently cannot do the
"text flows in word by word" display (streaming) — **responses appear all
at once**. Chat works fine; it just feels slightly different. (Support is
on the roadmap.)

> Rule of thumb: **have AWS credits → Option B** (start with zero extra
> spend). **Otherwise → Option A** (shorter setup, streaming display works).

## 2. What a hosting account is

If the app runs on your own computer, it stops when the laptop closes and
nobody else can reach it. A service that keeps your program running on **a
rented computer that is always connected to the internet** is called
*hosting*. "Set up a hosting account" means **registering with such a
service (e.g. [Fly.io](https://fly.io), [Railway](https://railway.com)) with
your email and a payment card**.

- Cost ballpark: **$0–5/month** at this scale; free tiers often suffice
- Which service to pick and all configuration afterwards can be **left
  entirely to your agent** — ask it "which service should I create an
  account with?" and it will walk you through
- The card here pays for *the place the app lives*; the key from Option
  A/B pays for *AI usage*. They are **separate bills**.

## 3. What you decide (the questions your agent will ask)

| Question | Meaning | If unsure |
|---|---|---|
| Monthly cap? | Total AI spend allowed per month, everyone combined. Exceeding it auto-stops usage (no extra billing) | $5–30 |
| Daily per person? | What one invited person may use per day. Exceeding it stops only that person until tomorrow | $0.5–1 |
| Who gets invited? | Who receives an invite code (token). Each one can be revoked instantly | — |

## 4. Handing the key to your agent safely

The API key is a secret. Only the handover needs care:

- **Good**: paste it yourself into the hosting service's "environment
  variables" / "Secrets" settings (your agent will point you to the exact
  screen), or follow the secure procedure your agent prepares
- **Avoid**: anywhere public or shared — social media, shared chat logs,
  inside the app's source code
- If a key ever leaks, **revoke it** in the issuer's console (Anthropic
  Console / AWS) and it stops working from that moment. And because
  sekimori's caps are independent, damage before you notice is bounded by
  your cap anyway.

## 5. What to check once setup is done

After setup, the agent sends you a **protection summary** like this (it is
generated by sekimori's built-in self-check, `doctor`):

> - Allowed models: claude-haiku-4-5
> - Monthly cap: $30 total; $0.5 per person per day
> - Rate limit: 10 requests/minute per person
> - Conversation contents are not logged
> - The API key never appears on anyone's screen

The only thing you need to verify is **that the numbers are the ones you
chose**. That check stands in for a technical audit. If a number is wrong,
just tell the agent "set the cap to $X".

## FAQ

**Q. I'm worried about an unbounded AI bill.**
A. Two independent walls: (1) sekimori cuts off at your caps automatically
(the cutoff is the product working, not breaking); (2) with Option A the
credit is prepaid, so spending beyond what you bought is physically
impossible. With Option B you can additionally set AWS budget alerts.

**Q. Can I use my AWS Bedrock free credit?**
A. Yes (Option B). sekimori supports Bedrock's API-key authentication. One
limitation: streaming display is not supported yet, so responses appear all
at once.

**Q. What if an invited friend overuses it?**
A. Only that person is auto-stopped at their daily cap and resumes the next
day (UTC). If the overall monthly cap is reached, everyone pauses until next
month. No extra billing in either case.

**Q. What if I want to shut the app down?**
A. Tell your agent "stop it" and it stops the app at the hosting service.
Revoking the API key at the issuer shuts off AI usage completely.

**Q. Where are the technical details?**
A. [README](../README.md) (developers) and [AGENTS.md](../AGENTS.md)
(agents). You don't need to read them.
