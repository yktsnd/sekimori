#!/usr/bin/env bash
# pack-smoke.sh - verifies the *packaged* sekimori actually works end to end:
# `npm pack` -> `npm install <tarball>` into a fresh project -> run the
# installed `sekimori` bin -> hit it over HTTP. This is the acceptance gate
# for issue #6 (npm packaging): it is the only test that exercises what a
# real `npm install sekimori` user would get, as opposed to running from a
# clone via `tsx src/main.ts`.
#
# Offline, no API key: uses examples/mock-upstream.mjs as the upstream, same
# as examples/demo.sh.
#
# Usage:
#   npm run build   # first time / after source changes
#   bash test/pack-smoke.sh
#
# Legacy POSIX implementation. `npm run test:pack` and CI use the Node-only
# `test/pack-smoke.mjs` so the same acceptance test runs on Windows; keep this
# script for contributors who prefer the original Bash diagnostic flow.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEKIMORI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

UPSTREAM_PORT="${SEKIMORI_PACK_UPSTREAM_PORT:-19998}"
SEKIMORI_PORT="${SEKIMORI_PACK_PORT:-18788}"
ADMIN_KEY="pack-smoke-admin-key-32-bytes-minimum-0001"
MODEL="claude-haiku-4-5-20251001"

# --- Working directories (mktemp -d). Always cleaned up via trap; never dirties the repo ---
PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sekimori-pack.XXXXXX")"
PROJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sekimori-pack-project.XXXXXX")"
CONFIG_PATH="$PACK_DIR/sekimori.config.json"
UPSTREAM_LOG="$PACK_DIR/mock-upstream.log"
SEKIMORI_LOG="$PACK_DIR/sekimori.log"
BODY="$PACK_DIR/body.json"
JF="$PACK_DIR/jf.mjs"

UPSTREAM_PID=""
SEKIMORI_PID=""

cleanup() {
  local code=$?
  [ -n "$SEKIMORI_PID" ] && kill "$SEKIMORI_PID" >/dev/null 2>&1
  [ -n "$UPSTREAM_PID" ] && kill "$UPSTREAM_PID" >/dev/null 2>&1
  wait >/dev/null 2>&1
  rm -rf "$PACK_DIR" "$PROJECT_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $1" >&2
  echo "--- mock-upstream.log ---" >&2
  cat "$UPSTREAM_LOG" 2>/dev/null >&2
  echo "--- sekimori.log ---" >&2
  cat "$SEKIMORI_LOG" 2>/dev/null >&2
  exit 1
}

STEP=0
note() {
  STEP=$((STEP + 1))
  echo "[$STEP] $1"
}

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

req() {
  # req METHOD PATH [BEARER] [JSON_BODY] -> prints HTTP status, body in $BODY
  local method="$1" path="$2" bearer="${3:-}" data="${4:-}"
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "http://localhost:$SEKIMORI_PORT$path")
  [ -n "$bearer" ] && args+=(-H "Authorization: Bearer $bearer")
  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  curl "${args[@]}"
}

wait_for_http() {
  local url="$1" tries=100
  for ((i = 0; i < tries; i++)); do
    if curl -s -o /dev/null --max-time 1 "$url"; then
      return 0
    fi
    sleep 0.1
  done
  fail "timed out waiting for $url"
}

# ============================================================================
note "npm run build (dist/ must be up to date - not committed to the repo)"
# ============================================================================
(cd "$SEKIMORI_DIR" && npm run build >/dev/null) || fail "npm run build failed"

# ============================================================================
note "npm pack into a temp dir"
# ============================================================================
TARBALL="$(cd "$SEKIMORI_DIR" && npm pack --silent --pack-destination "$PACK_DIR")" || fail "npm pack failed"
[ -f "$PACK_DIR/$TARBALL" ] || fail "tarball not found: $PACK_DIR/$TARBALL"
MANIFEST="$PACK_DIR/package-manifest.txt"
tar -tzf "$PACK_DIR/$TARBALL" >"$MANIFEST" || fail "could not read packed tarball manifest"
for expected in \
  package/docs/configuration.md \
  package/docs/api.md \
  package/examples/chat.html \
  package/examples/demo.mjs \
  package/AGENTS.md \
  package/CONTRIBUTING.md \
  package/SECURITY.md \
  package/SUPPORT.md \
  package/GOVERNANCE.md \
  package/CODE_OF_CONDUCT.md \
  package/RELEASING.md \
  package/ROADMAP.md; do
  # Do not use `tar ... | grep -q` with pipefail: grep exits as soon as it
  # finds a match, which can make tar report SIGPIPE and falsely fail CI.
  grep -Fxq -- "$expected" "$MANIFEST" || fail "packed tarball is missing $expected"
done
echo "    tarball: $TARBALL"

# ============================================================================
note "npm install the tarball into a fresh temp project"
# ============================================================================
(cd "$PROJECT_DIR" && npm init -y >/dev/null 2>&1)
(cd "$PROJECT_DIR" && npm install --no-audit --no-fund "$PACK_DIR/$TARBALL" >"$PACK_DIR/npm-install.log" 2>&1) \
  || fail "npm install of the packed tarball failed (see $PACK_DIR/npm-install.log)"

SEKIMORI_BIN="$PROJECT_DIR/node_modules/.bin/sekimori"
[ -x "$SEKIMORI_BIN" ] || fail "installed bin not found or not executable: $SEKIMORI_BIN"

# ============================================================================
note "starting the mock upstream (examples/mock-upstream.mjs)"
# ============================================================================
node "$SEKIMORI_DIR/examples/mock-upstream.mjs" "$UPSTREAM_PORT" >"$UPSTREAM_LOG" 2>&1 &
UPSTREAM_PID=$!
wait_for_http "http://localhost:$UPSTREAM_PORT/healthz-not-a-real-path"

# ============================================================================
note "writing a config pointed at the mock upstream"
# ============================================================================
cat > "$CONFIG_PATH" <<EOF
{
  "port": $SEKIMORI_PORT,
  "upstream": { "baseUrl": "http://localhost:$UPSTREAM_PORT", "apiKeyEnv": "SEKIMORI_PACK_UPSTREAM_KEY" },
  "models": { "$MODEL": { "inputPerMTok": 1.0, "outputPerMTok": 5.0 } },
  "budget": { "monthlyUsd": 5, "defaultDailyPerTokenUsd": 0.5 },
  "rateLimit": { "requestsPerMinute": 10 },
  "pinnedSystemPrompt": null,
  "cors": { "allowedOrigins": [] },
  "logging": { "logBodies": false },
  "store": { "type": "memory", "path": "" }
}
EOF

# ============================================================================
note "running the installed sekimori bin (via the temp project's node_modules/.bin)"
# ============================================================================
(
  cd "$PROJECT_DIR" || exit 1
  # `exec` makes the background PID the Node process itself. Without it,
  # Git Bash can kill only this subshell during cleanup and leave the child
  # gateway holding its port and temporary install directory.
  exec env SEKIMORI_ADMIN_KEY="$ADMIN_KEY" SEKIMORI_PACK_UPSTREAM_KEY="dummy-mock-key" \
    "$SEKIMORI_BIN" "$CONFIG_PATH" >"$SEKIMORI_LOG" 2>&1
) &
SEKIMORI_PID=$!
wait_for_http "http://localhost:$SEKIMORI_PORT/healthz"

# ============================================================================
note "GET /healthz -> {\"ok\":true}"
# ============================================================================
status=$(req GET /healthz)
[ "$status" = "200" ] || fail "/healthz returned HTTP $status (expected 200)"
ok=$(jf ok)
[ "$ok" = "true" ] || fail "/healthz body did not contain ok:true (got: $(cat "$BODY"))"
echo "    OK: $(cat "$BODY")"

# ============================================================================
note "POST /admin/tokens -> issue an invite token"
# ============================================================================
status=$(req POST /admin/tokens "$ADMIN_KEY" '{"name":"pack-smoke","dailyUsd":1}')
[ "$status" = "201" ] || fail "/admin/tokens returned HTTP $status (expected 201): $(cat "$BODY")"
TOKEN=$(jf token)
[ -n "$TOKEN" ] || fail "no token in /admin/tokens response: $(cat "$BODY")"
echo "    OK: token issued"

# ============================================================================
note "POST /v1/messages with the token -> round trip through the gateway"
# ============================================================================
status=$(req POST /v1/messages "$TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"hello from pack-smoke\"}]}")
[ "$status" = "200" ] || fail "/v1/messages returned HTTP $status (expected 200): $(cat "$BODY")"
echo "    OK: $(jf content.0.text)"

echo
echo "All $STEP steps completed. Exit code 0."
