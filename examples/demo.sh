#!/usr/bin/env bash
# demo.sh - sekimori's one-command scenario demo (docs/04-demo-design.md, section 1)
#
# A three-act demo that replays "the moments the guard kicks in" with no real
# API key and zero spend - and at the same time a smoke test that exits
# non-zero on any expected-HTTP-status mismatch (DX review B-3).
#
# Usage:
#   npm install   # first time only
#   bash examples/demo.sh
#
# Requirements: bash / curl / node (after npm install). Nothing else. jq is
# not used (JSON fields are read with a small bundled node script instead).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEKIMORI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

UPSTREAM_PORT="${SEKIMORI_DEMO_UPSTREAM_PORT:-19999}"
SEKIMORI_PORT="${SEKIMORI_DEMO_PORT:-18787}"
ADMIN_KEY="demo-admin-key-32-bytes-minimum-0001"
MODEL="claude-haiku-4-5-20251001"
DISALLOWED_MODEL="claude-opus-4-1-20250805"

# --- Working directory (mktemp -d). Always cleaned up via trap; never dirties the repo ---
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sekimori-demo.XXXXXX")"
CONFIG_PATH="$TMP_DIR/sekimori.config.json"
UPSTREAM_LOG="$TMP_DIR/mock-upstream.log"
SEKIMORI_LOG="$TMP_DIR/sekimori.log"
HDRS="$TMP_DIR/headers.txt"
BODY="$TMP_DIR/body.json"
JF="$TMP_DIR/jf.mjs"

UPSTREAM_PID=""
SEKIMORI_PID=""

cleanup() {
  local code=$?
  [ -n "$SEKIMORI_PID" ] && kill "$SEKIMORI_PID" >/dev/null 2>&1
  [ -n "$UPSTREAM_PID" ] && kill "$UPSTREAM_PID" >/dev/null 2>&1
  wait >/dev/null 2>&1
  rm -rf "$TMP_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

# --- Minimal JSON field reader without jq (depends only on node) -----------------
cat > "$JF" <<'EOF'
import { readFileSync } from "node:fs";
const [, , file, path] = process.argv;
let data;
try {
  data = JSON.parse(readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}
let v = data;
for (const key of path.split(".")) {
  if (v == null) break;
  v = v[key];
}
if (v !== undefined && v !== null) process.stdout.write(String(v));
EOF

jf() { node "$JF" "$BODY" "$1"; }

STEP=0
act() {
  echo
  echo "=== $1 ==="
}
note() {
  STEP=$((STEP + 1))
  echo "  [$STEP] $1"
}
assert_status() {
  # assert_status <description> <expected status> <actual status>
  local desc="$1" expected="$2" actual="$3"
  STEP=$((STEP + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  [$STEP] OK   $desc (HTTP $actual)"
  else
    echo "  [$STEP] FAIL $desc (expected HTTP $expected, got HTTP $actual)" >&2
    echo "        response body: $(cat "$BODY" 2>/dev/null)" >&2
    exit 1
  fi
}

# --- HTTP helper: returns the status code; body goes to $BODY, headers to $HDRS --------
req() {
  # req METHOD PATH [BEARER] [JSON_BODY]
  local method="$1" path="$2" bearer="${3:-}" data="${4:-}"
  local args=(-s -D "$HDRS" -o "$BODY" -w '%{http_code}' -X "$method" "http://127.0.0.1:$SEKIMORI_PORT$path")
  [ -n "$bearer" ] && args+=(-H "Authorization: Bearer $bearer")
  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  curl "${args[@]}"
}

retry_after_header() {
  grep -i '^retry-after:' "$HDRS" 2>/dev/null | awk '{print $2}' | tr -d '\r'
}

wait_for_http() {
  local url="$1" tries=100
  for ((i = 0; i < tries; i++)); do
    if curl -s -o /dev/null --max-time 1 "$url"; then
      return 0
    fi
    sleep 0.1
  done
  echo "timed out waiting for $url. Check that ports $UPSTREAM_PORT / $SEKIMORI_PORT are not in use by another process." >&2
  exit 1
}

# ============================================================================
act "Act 1: Going live"
# ============================================================================

note "starting the mock upstream (examples/mock-upstream.mjs) - it stands in for the real Anthropic API"
node "$SEKIMORI_DIR/examples/mock-upstream.mjs" "$UPSTREAM_PORT" >"$UPSTREAM_LOG" 2>&1 &
UPSTREAM_PID=$!
wait_for_http "http://127.0.0.1:$UPSTREAM_PORT/healthz-not-a-real-path"
UPSTREAM_BASE_URL="http://127.0.0.1:$UPSTREAM_PORT"
UPSTREAM_API_KEY_ENV="SEKIMORI_DEMO_UPSTREAM_KEY"
export SEKIMORI_DEMO_UPSTREAM_KEY="dummy-mock-key"
MONTHLY_USD=5
ALICE_MAX_TOKENS=50
MALLORY_SMALL_MAX_TOKENS=50
MALLORY_HUGE_MAX_TOKENS=200000

cat > "$CONFIG_PATH" <<EOF
{
  "port": $SEKIMORI_PORT,
  "upstream": { "baseUrl": "$UPSTREAM_BASE_URL", "apiKeyEnv": "$UPSTREAM_API_KEY_ENV" },
  "models": { "$MODEL": { "inputPerMTok": 1.0, "outputPerMTok": 5.0 } },
  "budget": { "monthlyUsd": $MONTHLY_USD, "defaultDailyPerTokenUsd": 0.5 },
  "rateLimit": { "requestsPerMinute": 5 },
  "pinnedSystemPrompt": null,
  "cors": { "allowedOrigins": [] },
  "logging": { "logBodies": false },
  "store": { "type": "memory", "path": "" }
}
EOF

note "starting sekimori (monthly cap \$$MONTHLY_USD, rate limit 5 req/min, a single model)"
TSX_BIN="$SEKIMORI_DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "tsx not found. Run 'npm install' first." >&2
  exit 1
fi
SEKIMORI_ADMIN_KEY="$ADMIN_KEY" "$TSX_BIN" "$SEKIMORI_DIR/src/main.ts" "$CONFIG_PATH" >"$SEKIMORI_LOG" 2>&1 &
SEKIMORI_PID=$!
wait_for_http "http://127.0.0.1:$SEKIMORI_PORT/healthz"

note "the startup summary (a declaration of what is being protected; added in DX review A-3) prints as-is:"
sed 's/^/        /' "$SEKIMORI_LOG"

# ============================================================================
act "Act 2: Inviting people"
# ============================================================================

status=$(req POST /admin/tokens "$ADMIN_KEY" '{"name":"alice","dailyUsd":1.0}')
assert_status "issue a token for alice (dailyUsd: \$1.0 - a normal user)" 201 "$status"
ALICE_TOKEN=$(jf token)

status=$(req POST /admin/tokens "$ADMIN_KEY" '{"name":"mallory","dailyUsd":0.002}')
assert_status "issue a token for mallory (dailyUsd: \$0.002 - set up to hit her cap immediately)" 201 "$status"
MALLORY_TOKEN=$(jf token)
MALLORY_ID=$(jf id)

status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$ALICE_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"hello from alice\"}]}")
assert_status "alice makes one non-streaming round trip -> gets a response" 200 "$status"

status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$ALICE_MAX_TOKENS,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hello again\"}]}")
assert_status "alice makes one streaming round trip -> text streams back" 200 "$status"

status=$(req GET /v1/usage "$ALICE_TOKEN")
assert_status "alice checks /v1/usage -> her spend is recorded" 200 "$status"
echo "        alice's usage today: \$$(jf todayUsd) / \$$(jf dailyLimitUsd)"

# ============================================================================
act "Act 3: The guard kicks in"
# ============================================================================

status=$(req POST /v1/messages "" "{\"model\":\"$MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "/v1/messages without a token -> sekimori does not become a free-for-all proxy" 401 "$status"

status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$DISALLOWED_MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "alice requests a non-allowlisted model -> no sneaking onto pricier models" 403 "$status"

status=$(req POST /v1/messages "$MALLORY_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$MALLORY_SMALL_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "mallory uses her token once -> still under her cap, so it succeeds" 200 "$status"

status=$(req POST /v1/messages "$MALLORY_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$MALLORY_HUGE_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
retry_after=$(retry_after_header)
assert_status "mallory tries again -> budget_exceeded_error (daily) + Retry-After" 429 "$status"
if [ -z "$retry_after" ]; then
  echo "  FAIL: Retry-After header is missing" >&2
  exit 1
fi
error_type=$(jf error.type)
if [ "$error_type" != "budget_exceeded_error" ]; then
  echo "  FAIL: error.type is not budget_exceeded_error ($error_type)" >&2
  exit 1
fi
retry_after_hours=$(awk "BEGIN { printf \"%.1f\", $retry_after / 3600 }")
echo "        Retry-After: ${retry_after}s (about ${retry_after_hours} hours from now = next UTC midnight)"

# Rate limiting: alice has already hit /v1/messages 3 times by now (non-streaming,
# streaming, and the disallowed-model rejection - the rate limiter counts requests
# before model validation, so rejections count too). So exactly which of the "6
# rapid-fire requests" gets the 429 can depend on execution order - here we verify
# that "within 6 rapid-fire requests, rate_limit_error + Retry-After happens at
# least once" (decision: see the judgment notes referenced from the README).
note "alice fires 6 rapid requests -> hits the rate limit (5 req/min): rate_limit_error + Retry-After"
rate_limited=0
for i in 1 2 3 4 5 6; do
  status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$ALICE_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"burst $i\"}]}")
  if [ "$status" = "429" ]; then
    error_type=$(jf error.type)
    retry_after=$(retry_after_header)
    if [ "$error_type" = "rate_limit_error" ] && [ -n "$retry_after" ]; then
      rate_limited=1
      echo "        request $i got 429 rate_limit_error (Retry-After: ${retry_after}s)"
      break
    fi
  fi
done
STEP=$((STEP + 1))
if [ "$rate_limited" = "1" ]; then
  echo "  [$STEP] OK   rate_limit_error + Retry-After occurred within the 6 rapid requests"
else
  echo "  [$STEP] FAIL no rate_limit_error within 6 rapid requests" >&2
  exit 1
fi

status=$(req GET /admin/usage "$ADMIN_KEY")
assert_status "the operator checks /admin/usage -> mallory's spend is visible" 200 "$status"
mallory_seen=$(node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const found = (data.tokens || []).some((t) => t.name === "mallory");
process.stdout.write(found ? "yes" : "no");
' "$BODY")
if [ "$mallory_seen" != "yes" ]; then
  echo "  FAIL: mallory is missing from the /admin/usage listing" >&2
  exit 1
fi
echo "        confirmed /admin/usage includes mallory's usage"

status=$(req DELETE "/admin/tokens/$MALLORY_ID" "$ADMIN_KEY")
assert_status "the operator revokes mallory's token" 200 "$status"

status=$(req POST /v1/messages "$MALLORY_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "mallory's next request after revocation is immediately 401 (uninviting works)" 401 "$status"

note "Summary: throughout all of this, the only traffic that reached the upstream was alice's and mallory's legitimate requests. The API key never left the server."

echo
echo "All $STEP steps completed. Exit code 0."
