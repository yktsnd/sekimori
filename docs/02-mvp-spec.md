# sekimori MVP 仕様(実装契約)

> **この文書は凍結済みの歴史文書。** MVP 実装(コミット `7244f3e`)時点の実装契約であり、以後の変更(DX レビューに基づく追加: 起動サマリ・`Retry-After`・`examples/demo.sh` 等)はここに反映されていない。**現在の挙動の一次情報源は `README.md` とソースコードそのもの。** 本書は「なぜ最初にこの範囲で作ったか」を残すために保持している。以後の追加判断は [03-dx-review.md](03-dx-review.md) と [04-demo-design.md](04-demo-design.md) を参照。

この文書は MVP 実装の**契約**である。実装者はここに書かれたスコープを勝手に広げない。判断に迷う細部は「fail-closed(安全側=遮断側に倒す)」を原則に選ぶ。

## 0. スコープ宣言

- 上流: **Anthropic Messages API のみ**(`POST {baseUrl}/v1/messages`)
- デプロイ形態: **単一 Node.js プロセス**(水平スケール非対応と README に明記)
- UI なし。管理操作はすべて `curl` で行い、README に全コマンド例を載せる
- ここに書かれていない機能(キャッシュ、リトライ、OpenAI 互換、Workers 対応)は実装しない

## 1. 技術スタック

- Node.js 20+ / TypeScript(strict)
- ランタイム依存は **hono のみ**(`@hono/node-server` は可)。他のランタイム依存を追加しない
- 開発依存: `typescript`, `tsx`, `@types/node`
- テスト: `node:test`(追加のテストフレームワーク禁止)
- 置き場所: `projects/sekimori/` 配下

```
projects/sekimori/
├── package.json
├── tsconfig.json
├── sekimori.config.example.json
├── src/
│   ├── main.ts          # エントリポイント(config 読込 → サーバー起動)
│   ├── app.ts           # Hono アプリ組み立て(テストから直接使える形に)
│   ├── config.ts        # config の読込と検証
│   ├── store.ts         # Store インターフェース + MemoryStore + FileStore
│   ├── tokens.ts        # 招待トークンの発行・検証(ハッシュ保存)
│   ├── budget.ts        # コスト見積もり・会計・上限判定(純粋関数中心に)
│   ├── ratelimit.ts     # 固定ウィンドウのレート制限
│   └── proxy.ts         # 上流への転送(非ストリーム/SSE)と usage 抽出
├── test/                # node:test。モック上流サーバーを内包
├── examples/
│   ├── mock-upstream.mjs  # オフラインデモ用の擬似 Anthropic サーバー(依存ゼロ)
│   └── chat.html          # sekimori に向けて fetch+SSE する最小チャットページ
└── README.md
```

## 2. 設定

`sekimori.config.json`(パスは第1引数、既定 `./sekimori.config.json`)。秘密情報は config に書かず環境変数で渡す。

```jsonc
{
  "port": 8787,
  "upstream": {
    "baseUrl": "https://api.anthropic.com",
    "apiKeyEnv": "ANTHROPIC_API_KEY"        // キーを読む環境変数「名」
  },
  "models": {                                // 許可リスト兼価格表(USD / 100万トークン)
    "claude-haiku-4-5-20251001": { "inputPerMTok": 1.0, "outputPerMTok": 5.0 }
  },
  "budget": {
    "monthlyUsd": 30,                        // 全体の月次上限(キルスイッチ)
    "defaultDailyPerTokenUsd": 0.5           // トークン別日次上限の既定値
  },
  "rateLimit": { "requestsPerMinute": 10 },  // トークンごと
  "pinnedSystemPrompt": null,                // 文字列を設定すると system をサーバー側で強制上書き
  "cors": { "allowedOrigins": [] },          // 空 = CORS ヘッダを出さない
  "logging": { "logBodies": false },
  "store": { "type": "file", "path": ".sekimori/state.json" }  // "memory" | "file"
}
```

検証ルール(起動時に失敗させる): `models` が空 / 価格が正の数でない / `apiKeyEnv` の環境変数が未設定 / `SEKIMORI_ADMIN_KEY` 未設定、のいずれかならエラー終了。

## 3. 認証

- **管理キー**: 環境変数 `SEKIMORI_ADMIN_KEY`。`/admin/*` は `Authorization: Bearer <admin-key>` 必須
- **招待トークン**: 形式 `smk_` + ランダム 32 バイトの base64url。**平文は発行レスポンスで一度だけ返し、ストアには SHA-256 ハッシュのみ保存**
- トークンレコード: `{ id, name?, tokenHash, dailyUsd, createdAt, revokedAt? }`

## 4. エンドポイント

### 利用者向け

- `POST /v1/messages` — 本体。処理順:
  1. Bearer トークン検証(なし/不明/失効 → `401`)
  2. レート制限(超過 → `429`、`Retry-After` 付き)
  3. ボディ検証: `model` が `models` に存在(なければ `403`)、`max_tokens` が正整数(なければ `400`)
  4. `pinnedSystemPrompt` 設定時は `system` フィールドを強制置換
  5. 予算プリチェック(§5。超過 → `429`、理由を JSON で返す)
  6. 上流へ転送(§6)、レスポンスを中継、usage を会計に記録
- `GET /v1/usage` — 呼び出しトークン自身の `{ todayUsd, dailyLimitUsd, monthUsd, monthlyLimitUsd }`
- `GET /healthz` — 認証不要、`{ ok: true }`

### 管理者向け(Bearer = admin key)

- `POST /admin/tokens` `{ name?, dailyUsd? }` → `201 { id, token }`(token 平文はこの一度だけ)
- `GET /admin/tokens` → 平文とハッシュを含まない一覧
- `DELETE /admin/tokens/:id` → 失効(`revokedAt` を立てる。物理削除しない)
- `GET /admin/usage` → `{ monthUsd, monthlyLimitUsd, tokens: [{ id, name, todayUsd, dailyUsd }] }`

エラーはすべて `{ "error": { "type": string, "message": string } }` 形式。

## 5. 予算(budget.ts)— 最重要モジュール

- 会計単位は USD。日次・月次とも **UTC** 区切り
- **プリチェック**: `worstCost = estimateInputTokens × inputPrice + max_tokens × outputPrice`
  - `estimateInputTokens = ceil(utf8ByteLength(JSON.stringify(messages) + system) / 4)`(粗くてよい。目的は桁の防御)
  - `月間実績 + worstCost > monthlyUsd` または `トークンの当日実績 + worstCost > dailyUsd` なら遮断
- **実績記録**: 上流レスポンスの `usage.input_tokens` / `usage.output_tokens` から実コストを計算して加算
  - ストリーミング時は `message_start`(input_tokens)と最後の `message_delta`(output_tokens)から取得
  - **usage が取得できなかった場合は `worstCost` を実績として記録する**(過大計上側=安全側)
- **fail-closed**: ストアへの記録が失敗した場合、以後のリクエストは `503` で遮断(プロセスは落とさない)
- 集計は「日付キーごとの積算」でよい: `usage[tokenId][YYYY-MM-DD] += usd`。月次はその月の日次合計

`budget.ts` の判定・見積もり・集計は I/O を持たない純粋関数として書き、単体テスト対象にする。

## 6. 上流転送(proxy.ts)

- 転送先: `{upstream.baseUrl}/v1/messages`。ヘッダは `x-api-key: <上流キー>`, `anthropic-version: 2023-06-01`, `content-type: application/json` を**サーバー側で構築**する(クライアントのヘッダを素通ししない)
- 非ストリーム: 上流 JSON をそのまま返し、`usage` を記録
- ストリーム(`"stream": true`): SSE バイト列を**無加工で中継**しつつ、複製を行単位でパースして usage を抽出
- 上流の 4xx/5xx はステータスとボディをそのまま返す(会計は usage が取れなければ worstCost)

## 7. レート制限 / ログ / CORS

- レート制限: トークンごとの固定ウィンドウ(分単位)。インメモリでよい(単一プロセス前提)
- ログ: 1 リクエスト 1 行の JSON を stdout へ: `{ ts, tokenId, model, inputTokens, outputTokens, costUsd, status, ms }`。`logBodies: false`(既定)では本文・プロンプトを一切ログに出さない
- CORS: `allowedOrigins` に列挙された Origin のみ許可(`*` を暗黙で出さない)

## 8. テスト(node:test)

モック上流: テスト内で `node:http` サーバーを起動し、Anthropic 形式の応答(非ストリーム/SSE 両方)を返す。実 API キー不要で全テストが回ること。

必須ケース:
1. 認証: トークンなし/不正/失効 → 401
2. 許可リスト: 未知モデル → 403(価格未設定モデルは通らないことの確認を兼ねる)
3. 予算: 日次上限・月次上限それぞれでプリチェック遮断(429)。モック応答の usage が実績として加算されること
4. ストリーミング: SSE が改変なくクライアントに届き、かつ usage が会計されること
5. usage 欠落時に worstCost が計上されること
6. fail-closed: FileStore の書き込み失敗を注入 → 以後 503
7. レート制限: 上限+1 回目が 429
8. 管理: トークン発行 → 利用 → 失効 → 401 のライフサイクル
9. `pinnedSystemPrompt` が上流へのリクエストで実際に置換されていること

## 9. 受け入れ条件

- `npm test` が全て通る
- `npx tsc --noEmit` がエラーゼロ
- オフラインのクイックスタートが README 記載どおりに動く:
  1. `node examples/mock-upstream.mjs`(擬似上流を :9999 で起動)
  2. `baseUrl` を `http://localhost:9999` に向けた config で sekimori 起動
  3. `curl` でトークン発行 → `curl` で `/v1/messages` 呼び出し(非ストリーム/ストリーム両方)
  4. `examples/chat.html` をブラウザで開いてチャットできる
- README に含める: 一行コンセプト、クイックスタート、全 curl 例、設定リファレンス、「LiteLLM で足りる人へ」の節、単一プロセス前提の明記

## 10. 実装しないこと(再掲)

リトライ、キャッシュ、OpenAI 互換、Workers/KV、ダッシュボード、DB、Docker、CI 設定。これらに手を出す時間があればテストを厚くする。
