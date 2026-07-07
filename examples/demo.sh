#!/usr/bin/env bash
# demo.sh — sekimori のワンコマンド・シナリオデモ(docs/04-demo-design.md §1)
#
# 「守りが効く瞬間」を実 API キーなし・課金ゼロで再現する 3 幕構成のデモであり、同時に
# 「期待 HTTP ステータスの不一致で非ゼロ終了する」スモークテストでもある(DX レビュー B-3)。
#
# 使い方:
#   cd projects/sekimori && npm install   # 初回のみ
#   bash examples/demo.sh
#
# 実 API モード(おまけ。既定はオフライン):
#   SEKIMORI_DEMO_REAL=1 ANTHROPIC_API_KEY=sk-... bash examples/demo.sh
#
# 前提: bash / curl / node(npm install 済み)。それ以外の依存なし。jq は使わない
# (JSON の読み取りは同梱の小さな node スクリプトで行う)。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEKIMORI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REAL_MODE="${SEKIMORI_DEMO_REAL:-0}"
UPSTREAM_PORT="${SEKIMORI_DEMO_UPSTREAM_PORT:-19999}"
SEKIMORI_PORT="${SEKIMORI_DEMO_PORT:-18787}"
ADMIN_KEY="demo-admin-key"
MODEL="claude-haiku-4-5-20251001"
DISALLOWED_MODEL="claude-opus-4-1-20250805"

if [ "$REAL_MODE" = "1" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "SEKIMORI_DEMO_REAL=1 のときは ANTHROPIC_API_KEY を設定してください" >&2
  exit 1
fi

# --- 作業ディレクトリ(mktemp -d)。trap で必ず片付け、リポジトリを汚さない -------------
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

# --- jq を使わない最小限の JSON フィールド読み取り(node のみに依存) ------------------
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
  # assert_status <説明> <期待ステータス> <実際のステータス>
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

# --- HTTP ヘルパー: ステータスコードを返し、ボディは $BODY、ヘッダは $HDRS に書く --------
req() {
  # req METHOD PATH [BEARER] [JSON_BODY]
  local method="$1" path="$2" bearer="${3:-}" data="${4:-}"
  local args=(-s -D "$HDRS" -o "$BODY" -w '%{http_code}' -X "$method" "http://localhost:$SEKIMORI_PORT$path")
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
  echo "$url がタイムアウトしました。ポート $UPSTREAM_PORT / $SEKIMORI_PORT が他プロセスに使われていないか確認してください。" >&2
  exit 1
}

# ============================================================================
act "第1幕: 公開する"
# ============================================================================

if [ "$REAL_MODE" = "1" ]; then
  note "実 API モード(SEKIMORI_DEMO_REAL=1): 擬似上流は使わず本物の Anthropic API に接続します"
  UPSTREAM_BASE_URL="https://api.anthropic.com"
  UPSTREAM_API_KEY_ENV="ANTHROPIC_API_KEY"
  MONTHLY_USD=5
  ALICE_MAX_TOKENS=16
  MALLORY_SMALL_MAX_TOKENS=16
  MALLORY_HUGE_MAX_TOKENS=200000
else
  note "擬似上流(examples/mock-upstream.mjs)を起動します — 本物の Anthropic API の代役です"
  node "$SEKIMORI_DIR/examples/mock-upstream.mjs" "$UPSTREAM_PORT" >"$UPSTREAM_LOG" 2>&1 &
  UPSTREAM_PID=$!
  wait_for_http "http://localhost:$UPSTREAM_PORT/healthz-not-a-real-path"
  UPSTREAM_BASE_URL="http://localhost:$UPSTREAM_PORT"
  UPSTREAM_API_KEY_ENV="SEKIMORI_DEMO_UPSTREAM_KEY"
  export SEKIMORI_DEMO_UPSTREAM_KEY="dummy-mock-key"
  MONTHLY_USD=5
  ALICE_MAX_TOKENS=50
  MALLORY_SMALL_MAX_TOKENS=50
  MALLORY_HUGE_MAX_TOKENS=200000
fi

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

note "sekimori を起動します(月次上限 \$$MONTHLY_USD、レート制限 5 req/min、モデル 1 つ)"
TSX_BIN="$SEKIMORI_DIR/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "tsx が見つかりません。先に 'cd projects/sekimori && npm install' を実行してください。" >&2
  exit 1
fi
SEKIMORI_ADMIN_KEY="$ADMIN_KEY" "$TSX_BIN" "$SEKIMORI_DIR/src/main.ts" "$CONFIG_PATH" >"$SEKIMORI_LOG" 2>&1 &
SEKIMORI_PID=$!
wait_for_http "http://localhost:$SEKIMORI_PORT/healthz"

note "起動サマリ(何を守るかの宣言。DX レビュー A-3 で追加したもの)がそのまま画面に出ます:"
sed 's/^/        /' "$SEKIMORI_LOG"

# ============================================================================
act "第2幕: 招待する"
# ============================================================================

status=$(req POST /admin/tokens "$ADMIN_KEY" '{"name":"alice","dailyUsd":1.0}')
assert_status "alice のトークンを発行(dailyUsd: \$1.0 — 普通の利用者)" 201 "$status"
ALICE_TOKEN=$(jf token)

status=$(req POST /admin/tokens "$ADMIN_KEY" '{"name":"mallory","dailyUsd":0.001}')
assert_status "mallory のトークンを発行(dailyUsd: \$0.001 — すぐ上限に達する設定)" 201 "$status"
MALLORY_TOKEN=$(jf token)
MALLORY_ID=$(jf id)

status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$ALICE_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"hello from alice\"}]}")
assert_status "alice が非ストリームで 1 往復 → 応答が返る" 200 "$status"

status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$ALICE_MAX_TOKENS,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hello again\"}]}")
assert_status "alice がストリーミングで 1 往復 → テキストが流れる" 200 "$status"

status=$(req GET /v1/usage "$ALICE_TOKEN")
assert_status "alice の /v1/usage → 消費額が記録されている" 200 "$status"
echo "        alice の今日の利用: \$$(jf todayUsd) / \$$(jf dailyLimitUsd)"

# ============================================================================
act "第3幕: 守りが効く"
# ============================================================================

status=$(req POST /v1/messages "" "{\"model\":\"$MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "トークンなしで /v1/messages → 野良プロキシ化しない" 401 "$status"

status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$DISALLOWED_MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "alice が許可外モデルを指定 → 勝手に高いモデルを使われない" 403 "$status"

status=$(req POST /v1/messages "$MALLORY_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$MALLORY_SMALL_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "mallory が 1 回使う → まだ上限内なので成功" 200 "$status"

status=$(req POST /v1/messages "$MALLORY_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$MALLORY_HUGE_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
retry_after=$(retry_after_header)
assert_status "mallory がもう 1 回使う → budget_exceeded_error(daily) + Retry-After" 429 "$status"
if [ -z "$retry_after" ]; then
  echo "  FAIL: Retry-After ヘッダがありません" >&2
  exit 1
fi
error_type=$(jf error.type)
if [ "$error_type" != "budget_exceeded_error" ]; then
  echo "  FAIL: error.type が budget_exceeded_error ではありません ($error_type)" >&2
  exit 1
fi
retry_after_hours=$(awk "BEGIN { printf \"%.1f\", $retry_after / 3600 }")
echo "        Retry-After: ${retry_after}秒(約 ${retry_after_hours} 時間後 = 次の UTC 深夜)"

# レート制限: alice はこの時点で既に 3 回 /v1/messages を叩いている(非ストリーム・ストリーム・
# 許可外モデル拒否の 3 回。レート制限はモデル検証より前で数えるため拒否分もカウントされる)。
# したがって「6 連打」の中の何回目で 429 になるかは実行順に依存しうる — ここでは「6 回連打する
# うちに rate_limit_error + Retry-After が必ず 1 回は起きること」を検証する(判断: README の
# 判断メモ参照)。
note "alice が 6 連打 → レート制限(5 req/min)に引っかかり rate_limit_error + Retry-After が出る"
rate_limited=0
for i in 1 2 3 4 5 6; do
  status=$(req POST /v1/messages "$ALICE_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":$ALICE_MAX_TOKENS,\"messages\":[{\"role\":\"user\",\"content\":\"burst $i\"}]}")
  if [ "$status" = "429" ]; then
    error_type=$(jf error.type)
    retry_after=$(retry_after_header)
    if [ "$error_type" = "rate_limit_error" ] && [ -n "$retry_after" ]; then
      rate_limited=1
      echo "        $i 回目で 429 rate_limit_error(Retry-After: ${retry_after}秒)"
      break
    fi
  fi
done
STEP=$((STEP + 1))
if [ "$rate_limited" = "1" ]; then
  echo "  [$STEP] OK   6 連打のうちに rate_limit_error + Retry-After が発生した"
else
  echo "  [$STEP] FAIL 6 連打しても rate_limit_error が発生しなかった" >&2
  exit 1
fi

status=$(req GET /admin/usage "$ADMIN_KEY")
assert_status "管理者が /admin/usage で全体を確認 → mallory の消費が見える" 200 "$status"
mallory_seen=$(node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const found = (data.tokens || []).some((t) => t.name === "mallory");
process.stdout.write(found ? "yes" : "no");
' "$BODY")
if [ "$mallory_seen" != "yes" ]; then
  echo "  FAIL: /admin/usage の一覧に mallory が見当たりません" >&2
  exit 1
fi
echo "        /admin/usage に mallory の利用状況が含まれていることを確認"

status=$(req DELETE "/admin/tokens/$MALLORY_ID" "$ADMIN_KEY")
assert_status "管理者が mallory を失効させる" 200 "$status"

status=$(req POST /v1/messages "$MALLORY_TOKEN" "{\"model\":\"$MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")
assert_status "失効させた mallory の次のリクエストが即座に 401 になる(招待の取り消しが効く)" 401 "$status"

note "まとめ: この間、上流に漏れたのは alice と mallory の正当なリクエストだけ。API キーは一度もクライアントに渡っていない。"

echo
echo "全 $STEP ステップ完走。終了コード 0。"
