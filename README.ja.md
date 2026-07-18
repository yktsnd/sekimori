# sekimori (関守)

[![CI](https://github.com/yktsnd/sekimori/actions/workflows/ci.yml/badge.svg)](https://github.com/yktsnd/sekimori/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md)

> Anthropic を使うプロトタイプを、プロバイダーの API キーをブラウザに置かずに共有するための、小さなセルフホスト型の予算・アクセス防護ゲートウェイ。

sekimori はアプリと Anthropic Messages API の間に立つ。1 個のプロセスと
1 枚の設定ファイルで、招待トークン認証、モデル許可リスト、招待ごとの日次・
全体の月次予算上限、レート制限、任意の system プロンプト固定、SSE 中継を行う。

対象は意図的に狭い。オーナー 1 人、プロセス 1 個、テキストの Messages
リクエスト、Anthropic 直結または Amazon Bedrock の非ストリーミング実行に
絞っている。汎用 LLM ゲートウェイや企業向けコントロールプレーンではない。

```text
エンドユーザーのアプリ         sekimori                    プロバイダー
招待トークン  ------------->  認証・制限  ------------->  Anthropic / Bedrock
                              プロバイダーキーはここに置く
```

名前は、通行手形を確認した関所の番人「関守」に由来する。

## まず保護動作をオフラインで試す

必要なのは Node.js 20 以降だけ。デモ自体はプロバイダーへの通信を行わず、
プロバイダーキーも課金も不要。

```bash
npm install
npm run demo
```

ローカルの模擬プロバイダーと一時的な sekimori を起動し、トークンなしの拒否、
正常なリクエスト、許可外モデルの拒否、予算遮断、レート制限、トークン失効、
使用量表示を含む 18 の動作を確認する。不一致があれば非ゼロで終了する。
将来 npm レジストリから導入した場合は `npx sekimori demo` が同じ入口になる。

> **公開状況:** ソースリポジトリは公開済みで、この候補の version は `0.2.0`。
> ただし npm パッケージ、version tag / GitHub Release、実環境での HTTPS
> デプロイはまだ検証されていない。クローンから評価し、残るゲートは
> [RELEASING.md](RELEASING.md) を参照すること。

## 対応範囲

| 領域 | 現在対応 | 非対応 |
|---|---|---|
| 上流 | Anthropic Messages API、Amazon Bedrock `InvokeModel` | その他のプロバイダー |
| メッセージ | 通常のテキストリクエスト | tools、prompt caching、マルチモーダル、その他プロバイダー管理機能 |
| レスポンス | Anthropic の非ストリーミングと SSE、Bedrock の非ストリーミング | Bedrock streaming |
| アクセス | 失効可能な招待 bearer token、別系統の admin bearer key | OAuth、アカウント、チーム |
| 負荷上限 | token ごとの rolling/active limit、process 全体で active message 256 件まで | volumetric DDoS 防御 |
| 支出制御 | 招待ごとの日次・全体の月次設定上限 | プロバイダー側の請求制御、価格の自動取得 |
| 永続化 | 再起動をまたぐ file store、ローカル評価用 memory store | データベース、共有状態、複数 replica |
| 配置 | HTTPS の後ろで 1 プロセス、file store ごとの排他 lock | 水平スケール、複数プロセス、ロードバランシング |

予算上限の正確さは、設定に宣言したモデル価格に依存する。sekimori は保守的に
予約し、使用量が曖昧なら fail-closed にするが、古い・不完全な価格宣言は訂正
できない。安全境界として使う前に [セキュリティモデル](docs/security-model.md) を
読むこと。設定する USD 額は $1,000,000,000 以下に制限され、floating-point
precision で正の debit を表現できない場合も fail-closed にする。

## クローンからのクイックスタート（オフライン）

以下は実際の API を確認する長い手順。最初に見るだけなら上の
`npm run demo` を使う。

### 1. インストールして模擬プロバイダーを起動

```bash
npm install
node examples/mock-upstream.mjs 9999
```

### 2. 設定を作って sekimori を起動

macOS / Linux では別ターミナルで実行する。

```bash
npx tsx src/main.ts init --yes --upstream-url http://localhost:9999
export ANTHROPIC_API_KEY=dummy
export SEKIMORI_ADMIN_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
npx tsx src/main.ts sekimori.config.json &
GATEWAY_PID=$!
```

ここで `dummy` を使えるのは、上流がローカルの模擬プロバイダーだからである。
実際のプロバイダーキーを設定ファイル、クライアント、リポジトリ、ログ、コピー
するコマンドに書かない。`upstream.apiKeyEnv` が指定する環境変数だけで渡す。

Windows PowerShell では次を使う。

```powershell
npx tsx src/main.ts init --yes --upstream-url http://localhost:9999
$env:ANTHROPIC_API_KEY = "dummy"
$env:SEKIMORI_ADMIN_KEY = & node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$gateway = Start-Process -FilePath "npx.cmd" `
  -ArgumentList @("tsx", "src/main.ts", "sekimori.config.json") `
  -WindowStyle Hidden -PassThru
```

起動後、同じ shell で確認する（起動中なら少し待って再実行する）。
macOS / Linux:

```bash
curl -fsS http://127.0.0.1:8787/healthz
# {"ok":true}
```

Windows PowerShell:

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/healthz"
# ok
# --
# True
```

### 3. 招待を発行してゲートウェイを呼ぶ

macOS / Linux では、手順 2 と同じ shell で続ける。

```bash
curl -sS -X POST http://127.0.0.1:8787/admin/tokens \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","dailyUsd":1}'
# レスポンスに一度だけ現れる `token` をコピー:
export TOKEN=smk_xxxxxxxx

curl -sS -X POST http://127.0.0.1:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

Windows PowerShell では、手順 2 と同じ shell で続ける。

```powershell
$adminHeaders = @{ Authorization = "Bearer $env:SEKIMORI_ADMIN_KEY" }
$invite = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/admin/tokens" `
  -Headers $adminHeaders `
  -ContentType "application/json" `
  -Body '{"name":"demo","dailyUsd":1}'

$userHeaders = @{ Authorization = "Bearer $($invite.token)" }
$message = @{
  model = "claude-haiku-4-5-20251001"
  max_tokens = 100
  messages = @(@{ role = "user"; content = "hello" })
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/v1/messages" `
  -Headers $userHeaders `
  -ContentType "application/json" `
  -Body $message
```

終了時は macOS / Linux なら `kill "$GATEWAY_PID"`、PowerShell なら
`Stop-Process -Id $gateway.Id` でバックグラウンドの gateway を止め、模擬
プロバイダーを動かしたターミナルも停止する。

平文の招待トークンが現れるのは作成レスポンスだけ。対象ユーザーに安全に渡し、
漏えいした場合は失効させる。

### 任意: server-side で Anthropic TypeScript SDK を使う

現在の SDK は `baseURL`、nullable な `apiKey`、bearer `authToken` を公開している
（[公式 client source](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)）。
信頼できる server-side app では、それらを sekimori に向け、対応する通常の
[text request shape](docs/configuration.md#cost-accountable-request-scope) だけを送る。

```bash
npm install @anthropic-ai/sdk
```

```ts
import Anthropic from "@anthropic-ai/sdk";

if (
  !process.env.SEKIMORI_URL ||
  !process.env.SEKIMORI_INVITE_TOKEN ||
  !process.env.SEKIMORI_MODEL
) {
  throw new Error("SEKIMORI_URL, SEKIMORI_INVITE_TOKEN, and SEKIMORI_MODEL are required");
}

const client = new Anthropic({
  baseURL: process.env.SEKIMORI_URL,
  apiKey: null,
  authToken: process.env.SEKIMORI_INVITE_TOKEN!,
  maxRetries: 0,
});

const message = await client.messages.create({
  model: process.env.SEKIMORI_MODEL!,
  max_tokens: 100,
  messages: [{ role: "user", content: "hello" }],
});
```

`SEKIMORI_URL` は gateway base URL（`/v1/messages` を付けない）、
`SEKIMORI_MODEL` は設定の allowlist と完全一致する値にする。
`maxRetries: 0` により retry の判断を明示的にする。timeout など結果が曖昧な場合、
sekimori は予約額を保守的に維持するため、隠れた自動 retry は別の provider call と
予約を発生させ得る。SDK の browser 利用を有効にしたり、invite token を frontend
code に埋め込んだりしない。browser app は fetch ベースの
[`examples/chat.html`](examples/chat.html) を出発点にする。

## localhost 以外へ配置する前に

- file store を使う。memory store は再起動すると使用量がリセットされる。
- HTTPS の後ろで、プロセス / replica を必ず 1 個だけ動かす。
  同じ state file を使う 2 個目のプロセスは隣接する `<state>.lock` により拒否
  される。生きている所有プロセスを止めずに lock を削除しない。hard crash 後は
  同じ state path を使うプロセスがないと確認してから stale lock を削除し、再起動
  する。
- `rateLimit.requestsPerMinute` は 1–10,000。active message が process 全体で 256
  件ある間は 257 件目を拒否する。これは memory/availability の境界であり、capacity
  や DDoS 防御の保証ではない。
- localhost / literal loopback 以外のプロバイダー・ブラウザ Origin には HTTPS
  を使う。ブラウザの Origin を完全一致で指定し、wildcard CORS は使わない。
- 現在のプロバイダー価格とモデルアクセスを確認し、オーナーが承認した予算を
  設定する。sekimori は価格を取得しない。
- クライアントが system プロンプトを変更する必要がなければ固定する。
- プロバイダーキーと admin key は別々に生成してサーバー側だけに置く。両方とも
  visible ASCII（`0x21`–`0x7e`、空白・control・非 ASCII なし）だけを使い、admin
  key は 32 文字以上にする。設定・環境変更後は毎回 `sekimori doctor` を実行する。
- 招待発行前に [AGENTS.md](AGENTS.md) の配置検証を実行する。

ブラウザ用の参照実装は [`examples/chat.html`](examples/chat.html)。自分のアプリへ
コピーし、`CONFIG` を編集して `cors.allowedOrigins` に列挙した Origin から配信
する。招待トークンを `localStorage` に保持するため、XSS に対して信頼できる
フロントエンドでのみ使う。

## ドキュメント

| したいこと | 読む場所 |
|---|---|
| 予備知識なしで課金・認証情報・ホスティングを準備する | [オーナーガイド](docs/owner-guide.ja.md) / [English](docs/owner-guide.md) |
| コーディングエージェントとして運用する | [AGENTS.md](AGENTS.md) |
| 設定する | [設定リファレンス](docs/configuration.md) |
| API を呼ぶ・管理する | [API リファレンス](docs/api.md) |
| 保証、前提、障害時の動作を理解する | [セキュリティモデル](docs/security-model.md) |
| 設計制約と拡張点を理解する | [設計](docs/design.md) |
| 貢献する・質問する | [CONTRIBUTING.md](CONTRIBUTING.md) / [SUPPORT.md](SUPPORT.md) |
| 参加ルールと意思決定を理解する | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) / [GOVERNANCE.md](GOVERNANCE.md) |
| 脆弱性を非公開で報告する | [SECURITY.md](SECURITY.md) |
| 一般公開を準備する | [RELEASING.md](RELEASING.md) |
| 変更履歴を確認する | [CHANGELOG.md](CHANGELOG.md) |
| 残る予定を確認する | [ROADMAP.md](ROADMAP.md) |

一次言語は英語（[README.md](README.md)）。内容が食い違う場合は英語版を正とする。

## 開発時の検証

```bash
npm run typecheck
npm test
npm run demo
npm run test:pack
```

テストとデモは既定でオフライン。pack smoke test は tarball を作り、一時的な空の
プロジェクトへ導入し、インストールされた実体、同梱デモ、doctor、HTTP 往復を
検証する。

## スコープ

複数プロバイダー、チーム管理、データベース、ダッシュボード、複数 replica が
必要なら、その要件向けのゲートウェイを選ぶこと。sekimori はマルチテナント
SaaS、課金代行、prompt 管理、cache、retry、水平スケールを意図的に実装しない。

公開、デプロイ、命名、予算、認証情報の決定は人間の maintainer / owner が行う。
設計と実装は、人間か AI 支援ワークフローかにかかわらず、根拠に基づいてレビュー
する。
