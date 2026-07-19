# Security model

This document states what sekimori protects, what it assumes, and where its
boundary ends. It is an operational threat model, not a certification or a
claim that deployment is risk-free.

For reporting a suspected vulnerability, use [SECURITY.md](../SECURITY.md).

## Boundary and assets

sekimori is the only component that should know the upstream provider key and
the admin key. End-user apps receive only revocable invite tokens.

```text
untrusted                         trusted host                    external

browser / app  -- invite -->  sekimori process  -- provider --> Anthropic
                                |       |                         or Bedrock
                                |       +-- config + env secrets
                                +---------- file state (optional)
```

Assets inside the boundary are:

- the upstream provider key;
- `SEKIMORI_ADMIN_KEY`;
- plaintext invite tokens at their one-time creation response;
- token hashes, budget usage, and reservations in the store;
- request and response contents while a call is in progress.

The browser/app, invite-token holders, request bodies, request headers,
network, upstream provider, and public Internet are not trusted.

## Security objectives

Within the assumptions below, sekimori is designed to:

1. keep the upstream key and admin key out of end-user responses and upstream
   error details;
2. reject message calls without a valid, non-revoked invite token;
3. reject admin calls without the admin key;
4. admit only configured models and the supported request shape;
5. reserve configured budget before contacting the provider, so concurrent
   requests cannot all spend the same remaining allowance;
6. block rather than silently under-account when provider usage or local
   storage is ambiguous;
7. avoid logging message bodies unless an operator explicitly enables body
   logging.

These are application-layer controls. HTTPS, host security, provider-account
security, backups, and network denial-of-service protection remain deployment
responsibilities.

## Request and accounting flow

For `POST /v1/messages`, the relevant order is:

1. authenticate the invite token and reject revoked or unknown tokens;
2. apply the per-token rate/concurrency guard;
3. parse and validate the bounded request body and nesting depth;
4. reject unknown models and features whose charges the configured price
   table cannot represent;
5. replace the client `system` value when a pinned system prompt is configured;
6. atomically reserve a conservative cost against both the invite's UTC-daily
   allowance and the global UTC-monthly allowance;
7. send the provider request with server-built authentication headers;
8. settle the reservation only when a successful response contains complete,
   valid usage data.

Network failure, timeout, truncation, malformed or missing usage, an unsafe
response read, and an upstream failure do not release the conservative
reservation merely because billing is uncertain. This can over-count relative
to the provider bill; that is the intentional fail-closed direction. If the
process exits mid-request, restart removes the now-unsettleable reservation
metadata but retains its conservative debit in usage.

The reservation is calculated from the supported request and the operator's
declared input/output prices. Consequently, the configured ceiling is a local
accounting limit, not an independent provider-billing guarantee. A price that
is too low, a provider billing rule outside the supported text model, a
compromised host, or provider-account activity that bypasses sekimori is
outside the guarantee.

## Controls and assumptions

| Control | What it does | Required assumption |
|---|---|---|
| Invite tokens | Stores a hash and shows plaintext only in the creation response; supports revocation | The delivery channel and client storage do not leak the bearer token |
| Admin authentication | Separates token administration and global usage from end-user access | Both secrets are distinct visible-ASCII values; the independently random admin key is at least 32 characters, server-side, and never sent to users |
| Provider-key isolation | Builds upstream auth headers server-side and refuses redirects | The host, runtime, environment, and TLS endpoint are not compromised |
| Model/feature validation | Rejects models and request features absent from the declared accounting model | The operator keeps the allowlist and prices current |
| Budget reservations | Atomically charges a conservative estimate before upstream I/O | Exactly one sekimori process serves a given state file |
| Numeric accounting guard | Bounds configured USD amounts at $1,000,000,000 and rejects positive increments that floating-point precision cannot represent | The operator uses correct current prices within the supported request model |
| File store | Uses an exclusive lifetime lock, synced temporary snapshots requesting mode `0600`, atomic rename, and directory sync; persists tokens/accounting across restarts | The filesystem/host ACL is private and durable, supports the required local file semantics, and is not modified outside sekimori |
| Memory store | Supports disposable local evaluation | The operator accepts that all tokens and accounting reset on restart |
| Rate/concurrency limits | Per-token rolling and active limits plus a process-wide maximum of 256 active message calls | A `Retry-After: 1` process-cap response is a minimum retry hint, not a guaranteed slot or volumetric DDoS protection |
| Pinned system prompt | Prevents a client from replacing the configured system instruction | The prompt itself does not make untrusted model output safe |
| Exact-origin CORS | Allows listed browser origins without wildcard access | CORS is not authentication and non-browser clients are still possible |
| Body logging off | Omits request/response bodies from application logs | Platform, reverse-proxy, crash, and provider logging are configured separately |

## Failure behavior

| Condition | Behavior | Operator action |
|---|---|---|
| Unknown/revoked invite | `401` | Issue or deliver a valid invite; do not weaken authentication |
| Unlisted model | `403` | Verify the model and its current price before changing the allowlist |
| Unsupported request feature | `400` | Remove the feature or use a gateway with a complete billing model for it |
| Rate or configured budget reached | `429` with `Retry-After` | Wait for reset, revoke abusive invites, or obtain explicit owner approval before changing limits |
| Store unavailable/invalid or state file locked | Startup/protected operations fail closed | Repair storage or identify the owner process. Remove a stale lock only after confirming a hard crash and that no process uses the state path |
| Accounting invariant unsafe | Actual usage is recorded and new provider calls get `503`. A non-streaming response can become `503`; an already-started SSE cannot be retracted or change its status | Stop, inspect price/config/provider behavior, restart only after the cause is understood |
| Provider redirect, timeout, malformed/oversized response, or transport failure | Local gateway error; conservative reservation remains | Diagnose provider/network/config; do not assume the provider did not bill |

`/healthz` is a process liveness endpoint, not proof that credentials, storage,
provider access, pricing, TLS, or a real round trip are correct. Run
`sekimori doctor` and the deployment checks in [AGENTS.md](../AGENTS.md).

## Deliberate limitations

- **Single process only.** A file store holds an adjacent lifetime lock and
  refuses a second live process. Graceful `SIGINT`/`SIGTERM` releases it; a
  hard crash can leave a stale lock and startup fails closed instead of
  auto-reclaiming it. The operator may remove it only after confirming that no
  sekimori process uses that state path. This is not distributed coordination:
  do not place multiple instances behind a load balancer or share a state file
  across hosts.
- **HTTPS is external.** sekimori serves HTTP. Anything beyond localhost must
  terminate TLS in a trusted platform or reverse proxy before traffic reaches
  the process. Public provider and browser origins must be HTTPS; plain HTTP
  config is accepted only for exact localhost or a literal loopback IP.
- **Text-only accounting boundary.** Tools, prompt caching, multimodal input,
  and provider-managed features are rejected because their charges are not
  represented by the flat input/output price table.
- **Bedrock streaming is unsupported.** Bedrock uses non-streaming
  `InvokeModel`; streaming requests are rejected instead of being silently
  transformed.
- **Bearer credentials remain bearer credentials.** A stolen invite token can
  be used until revoked or limited. A stolen admin or provider key is a host
  compromise and requires immediate rotation.
- **No user isolation inside a shared app.** Invite names are operator labels,
  not verified identities. sekimori is not an account system or tenant
  boundary.
- **No content-safety guarantee.** The gateway controls access and configured
  spend, not model correctness, prompt injection, output safety, moderation,
  legal compliance, or data residency.
- **No availability guarantee.** Request-size and response-parser bounds,
  a configurable per-token rate/active limit (maximum 10,000), and a hard
  process-wide 256-active-message limit reduce some abuse, but do not replace a
  CDN, firewall, host limits, monitoring, or incident response.
- **Reference client trade-off.** `examples/chat.html` keeps an invite token in
  `localStorage`; any XSS in a derived frontend can steal it. Use a different
  client/session design if that risk is unacceptable.

## Production checklist

Before issuing a real invite:

- complete every applicable first-release/deployment gate in
  [RELEASING.md](../RELEASING.md);
- use current provider documentation to verify prices, model access, key
  handling, and provider-side billing alerts/limits;
- use `store.type: "file"` on private durable storage and run one process;
- use HTTPS, an exact CORS allowlist, a pinned system prompt where possible,
  and body logging off;
- generate independent provider/admin secrets, rotate any exposed credential,
  and never put them in the repository or frontend;
- run `sekimori doctor --json`, the offline demo, and the live blocked/allowed
  checks in [AGENTS.md](../AGENTS.md);
- monitor usage and storage health, and rehearse token revocation and secret
  rotation.
