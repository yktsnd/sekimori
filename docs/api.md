# API reference

All endpoints speak JSON. Errors always have the shape:

```json
{ "error": { "type": "<machine-readable-type>", "message": "<human text>" } }
```

## User endpoints (invite-token auth)

Authenticate with `Authorization: Bearer <invite token>` (`smk_...`).

### `POST /v1/messages`

The core proxy endpoint — Anthropic Messages API compatible, streaming
(`"stream": true`, SSE) and non-streaming. Request processing order:

1. Bearer token check (missing / unknown / revoked → `401 authentication_error`)
2. Process-wide active-request limit (at most 256 `/v1/messages` calls) and
   per-token rolling-minute/active limit (exceeded → `429 rate_limit_error`,
   with `Retry-After`)
3. Body validation: `model` must be in the config allowlist (else `403`),
   `max_tokens` must be a positive integer, `messages` must be a non-empty
   user/assistant text-message array, and every optional field must match the
   supported text subset (else `400`); with a Bedrock upstream,
   `"stream": true` is also rejected here (`400`, see below)
4. If `pinnedSystemPrompt` is configured, the `system` field is force-replaced
5. Cost-accountable request validation: a submitted body over 64 KiB is
   rejected with `413`; core text-only fields only, tools, prompt caching,
   multimodal/provider-managed features, unknown fields, excessive nesting,
   and an oversize effective request are rejected with `400`
6. Atomically reserve the conservative worst-case budget (would-exceed → `429
   budget_exceeded_error`, with `Retry-After`)
7. Forward upstream, relay the response (SSE is relayed byte-for-byte with
   `Cache-Control: no-cache, no-store, no-transform`), then settle the
   reservation to actual usage.
   Only a successful response with valid usage can lower the reservation.
   Any non-success response, missing usage, network failure, timeout, or unsafe
   response read keeps the conservative reservation because the gateway cannot
   prove it was unbilled. Provider non-success details are normalized to a
   local `502 upstream_error`; they are not exposed as sekimori auth/rate
   errors. Non-streaming responses are capped at 4 MiB in memory; a larger
   response becomes `502 upstream_error`. SSE is not size-capped by the
   gateway, but its independent usage parser falls back to the reservation on
   malformed/incomplete protocol state or a line over 256 KiB. If valid
   provider usage exceeds the conservative reservation, actual usage is
   recorded and the accounting circuit opens. A non-streaming response becomes
   `503 accounting_unavailable_error`; an SSE response whose headers/body have
   already started cannot change status, but subsequent provider calls are
   blocked with that `503` until the operator diagnoses and restarts.

```bash
# non-streaming
curl -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'

# streaming (SSE)
curl -N -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

With a Bedrock upstream (`upstream.type: "bedrock"`, see
[docs/configuration.md](configuration.md)), `"stream": true` returns `400
invalid_request_error` instead of streaming — rejected at the same body
validation stage as `max_tokens`, before any budget is consumed. This holds
until eventstream → SSE transcoding lands (see [ROADMAP.md](../ROADMAP.md),
"Later"); until then, set `"stream": false` against a bedrock upstream.

The full accepted Messages subset is listed in
[configuration.md](configuration.md#cost-accountable-request-scope). In
particular: messages contain only `user`/`assistant` text or text blocks;
`system` uses the same text/text-block shape; `stream` is boolean; `metadata`
contains only an optional `user_id`; stop sequences are non-empty strings;
`temperature`/`top_p` are
0–1; and `top_k` is a positive integer. Unknown or malformed fields are
rejected before reservation/upstream I/O.

### `GET /v1/usage`

Usage of the calling token: `{ todayUsd, dailyLimitUsd }`.

The global monthly total and cap are intentionally **not** exposed to invite
token holders. They can reveal the operator's budget and other users' activity;
the administrator can read them from `GET /admin/usage` instead.

```bash
curl http://localhost:8787/v1/usage -H "Authorization: Bearer $TOKEN"
```

### `GET /healthz`

No auth. `{ "ok": true }`. This is the only endpoint that keeps answering
when the store becomes unhealthy (see [design.md](design.md)).

## Admin endpoints

Authenticate with `Authorization: Bearer $SEKIMORI_ADMIN_KEY`.

```bash
# issue a token (the plaintext token is returned ONLY in this response)
curl -X POST http://localhost:8787/admin/tokens \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"friend-1"}'
# => 201 {"id":"...","token":"smk_..."}
# dailyUsd is omitted here, so the owner-approved configured default applies

# list tokens (no plaintext, no hashes)
curl http://localhost:8787/admin/tokens -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"

# revoke a token (soft delete: sets revokedAt; unknown id => 404)
curl -X DELETE http://localhost:8787/admin/tokens/$TOKEN_ID \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"

# global usage
curl http://localhost:8787/admin/usage -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"
```

Tokens are stored as SHA-256 hashes only; `POST /admin/tokens` is the single
moment the plaintext exists outside the client.

`POST /admin/tokens` accepts a JSON object with optional `name` (a string up
to 256 characters) and optional `dailyUsd` greater than zero and no more than
$1,000,000,000. An empty body is
allowed to use the configured default; malformed JSON, a non-object body, or
a body over 8 KiB returns `400`/`413` rather than issuing a token. Unknown
fields are rejected instead of being ignored.

## `Retry-After`

Both `429` variants carry a `Retry-After` header (seconds):

| Cause | `Retry-After` |
|---|---|
| Per-token daily budget exceeded | Seconds until next UTC midnight |
| Global monthly budget exceeded | Seconds until the 1st of next month, 00:00 UTC |
| Per-token rolling-minute limit reached | Seconds until the oldest admitted request leaves the rolling window |
| Per-token active or process-wide 256 active-message limit reached | `1` (minimum retry hint; capacity is not guaranteed after one second) |

Clients should surface this as "you can try again in ~N hours/seconds" —
see [`examples/chat.html`](../examples/chat.html) for the reference wording.

For an allowed browser origin, sekimori exposes `Retry-After` through CORS so
the reference client can read it.

## Error types

| `error.type` | HTTP | Meaning |
|---|---|---|
| `authentication_error` | 401 | Missing / unknown / revoked token, or bad admin key |
| `permission_error` | 403 | Model not in the allowlist |
| `invalid_request_error` | 400 / 413 | Malformed body (not JSON, bad `max_tokens`, or unsupported request shape); `413` means the submitted body exceeded 64 KiB |
| `rate_limit_error` | 429 | Per-token rolling/active limit or process-wide 256 active-message limit hit |
| `budget_exceeded_error` | 429 | Daily or monthly budget would be exceeded |
| `not_found_error` | 404 | `DELETE /admin/tokens/:id` with an unknown id |
| `upstream_error` | 502 | Upstream unreachable, redirects, rejects the request, times out, or cannot be safely read (including the 4 MiB safety limit). Provider status/body details are not returned as sekimori errors. |
| `internal_error` | 500 | Unexpected internal failure; the response is structured without exposing implementation details. |
| `storage_unavailable_error` | 503 | Store unhealthy — everything except `/healthz` is blocked (fail-closed) |
| `accounting_unavailable_error` | 503 | Usage exceeded the conservative reservation or another accounting invariant became unsafe; non-streaming/currently unstarted and subsequent provider calls are blocked until operator diagnosis and restart. An already-started SSE cannot retroactively change status |

Every response includes at least `Cache-Control: no-store`, including admin
responses and errors that may carry sensitive operational state. SSE adds
`no-cache` and `no-transform`. Unknown routes return a structured `404
not_found_error` rather than an HTML framework response.
