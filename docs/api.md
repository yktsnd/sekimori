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
2. Rate limit (exceeded → `429 rate_limit_error`, with `Retry-After`)
3. Body validation: `model` must be in the config allowlist (else `403`),
   `max_tokens` must be a positive integer (else `400`)
4. If `pinnedSystemPrompt` is configured, the `system` field is force-replaced
5. Budget precheck (would-exceed → `429 budget_exceeded_error`, with `Retry-After`)
6. Forward upstream, relay the response (SSE is relayed byte-for-byte),
   record actual usage for accounting

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

### `GET /v1/usage`

Usage of the calling token:
`{ todayUsd, dailyLimitUsd, monthUsd, monthlyLimitUsd }`.
`monthUsd` is the **global** (all tokens combined) figure for the current
month, because the monthly cap is a global kill switch — there is no
per-token monthly cap.

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
  -d '{"name":"friend-1","dailyUsd":2}'
# => 201 {"id":"...","token":"smk_..."}

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

## `Retry-After`

Both `429` variants carry a `Retry-After` header (seconds):

| Cause | `Retry-After` |
|---|---|
| Per-token daily budget exceeded | Seconds until next UTC midnight |
| Global monthly budget exceeded | Seconds until the 1st of next month, 00:00 UTC |
| Rate limit exceeded | Seconds until the current 1-minute window ends |

Clients should surface this as "you can try again in ~N hours/seconds" —
see [`examples/chat.html`](../examples/chat.html) for the reference wording.

## Error types

| `error.type` | HTTP | Meaning |
|---|---|---|
| `authentication_error` | 401 | Missing / unknown / revoked token, or bad admin key |
| `permission_error` | 403 | Model not in the allowlist |
| `invalid_request_error` | 400 | Malformed body (not JSON, or bad `max_tokens`) |
| `rate_limit_error` | 429 | Per-token rate limit hit |
| `budget_exceeded_error` | 429 | Daily or monthly budget would be exceeded |
| `not_found_error` | 404 | `DELETE /admin/tokens/:id` with an unknown id |
| `upstream_error` | 502 | Upstream unreachable. (Upstream 4xx/5xx **responses** are relayed as-is with their original status and body.) |
| `storage_unavailable_error` | 503 | Store unhealthy — everything except `/healthz` is blocked (fail-closed) |
