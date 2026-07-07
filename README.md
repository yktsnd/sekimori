# sekimori(関守)

> AI プロトタイプを、API キーを晒さず・予算を溶かさず・悪用されずに公開するための、最小のセルフホスト型ゲートウェイ。

「週末に作った AI プロトタイプを、友人・SNS・β ユーザーに触らせたい」段階の個人開発者向け。設定ファイル 1 枚 + プロセス 1 個で、キー秘匿・予算上限・招待トークン認証・レート制限・system プロンプト固定・SSE 素通しを提供する。背景は [docs/00-background.md](docs/00-background.md)、コンセプトは [docs/01-concept.md](docs/01-concept.md)、実装契約は [docs/02-mvp-spec.md](docs/02-mvp-spec.md)、DX レビューは [docs/03-dx-review.md](docs/03-dx-review.md)、デモ設計は [docs/04-demo-design.md](docs/04-demo-design.md) を参照。

**単一プロセス前提**: sekimori は水平スケールに対応していない。レート制限・トークンストア(memory 時)はプロセス内メモリで完結する設計であり、複数インスタンスを同時に立てて共有することはできない。個人が身内に公開する規模(数十〜数千リクエスト/日程度)を想定している。

## オフライン・クイックスタート

実 API キーなしで、依存ゼロの擬似 Anthropic サーバーに向けて一通り動かせる。

```bash
cd projects/sekimori
npm install

# 1. 擬似上流(Anthropic Messages API のスタブ)を :9999 で起動
node examples/mock-upstream.mjs 9999
```

別ターミナルで:

```bash
# 2. config を用意して sekimori を起動(擬似上流に向ける)
cp sekimori.config.example.json sekimori.config.json
# sekimori.config.json の upstream.baseUrl を "http://localhost:9999" に変更する

# ANTHROPIC_API_KEY は擬似上流には使われないのでダミー値でよい
ANTHROPIC_API_KEY=dummy SEKIMORI_ADMIN_KEY=change-me npx tsx src/main.ts sekimori.config.json
```

```bash
# 3. curl でトークン発行
curl -s -X POST http://localhost:8787/admin/tokens \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","dailyUsd":1}'
# => {"id":"...","token":"smk_..."}

TOKEN=smk_xxxxxxxx  # 上のレスポンスの token をここに

# 非ストリーム
curl -s -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'

# ストリーム(SSE)
curl -sN -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

```bash
# 4. examples/chat.html をブラウザで試す(file:// だと CORS で弾かれるので簡易サーバーで配信する)
python3 -m http.server 8000 --directory examples
# ブラウザで http://localhost:8000/chat.html を開き、ベース URL・招待トークン・モデル名を入力して送信
```

`examples/chat.html` を実際に使う場合は、`sekimori.config.json` の `cors.allowedOrigins` に配信元(上の例では `"http://localhost:8000"`)を追加してからサーバーを再起動すること。

## テスト・型チェック

```bash
cd projects/sekimori
npm test          # node:test。オフラインのモック上流を内包しており実 API キー不要
npm run typecheck # npx tsc --noEmit
```

## curl コマンド一覧

### 利用者向け

```bash
# メッセージ送信(非ストリーム)
curl -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'

# メッセージ送信(ストリーム / SSE)
curl -N -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}'

# 自分のトークンの利用状況
curl http://localhost:8787/v1/usage -H "Authorization: Bearer $TOKEN"

# ヘルスチェック(認証不要)
curl http://localhost:8787/healthz
```

### 管理者向け(`Authorization: Bearer $SEKIMORI_ADMIN_KEY`)

```bash
# トークン発行(token 平文はこのレスポンスでしか返らない)
curl -X POST http://localhost:8787/admin/tokens \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"friend-1","dailyUsd":2}'

# トークン一覧(平文・ハッシュは含まれない)
curl http://localhost:8787/admin/tokens -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"

# トークン失効(物理削除ではなく revokedAt を立てる)
curl -X DELETE http://localhost:8787/admin/tokens/$TOKEN_ID \
  -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"

# 全体の利用状況
curl http://localhost:8787/admin/usage -H "Authorization: Bearer $SEKIMORI_ADMIN_KEY"
```

エラーはすべて `{ "error": { "type": string, "message": string } }` 形式で返る。

## 設定リファレンス(`sekimori.config.json`)

起動時の第1引数でパスを指定する(既定 `./sekimori.config.json`)。テンプレートは [sekimori.config.example.json](sekimori.config.example.json)。秘密情報は config に書かず環境変数で渡す。

| キー | 説明 |
|---|---|
| `port` | listen ポート。省略時 `8787` |
| `upstream.baseUrl` | 上流(Anthropic Messages API 互換)のベース URL |
| `upstream.apiKeyEnv` | 上流 API キーを読む**環境変数名**(値そのものは config に書かない) |
| `models` | 許可リスト兼価格表。`{ "<model名>": { "inputPerMTok": USD, "outputPerMTok": USD } }`。ここに無いモデルは `403` |
| `budget.monthlyUsd` | 全体の月次上限(キルスイッチ)。超過すると全トークンが `429` |
| `budget.defaultDailyPerTokenUsd` | トークン発行時に `dailyUsd` を指定しなかった場合の既定値 |
| `rateLimit.requestsPerMinute` | トークンごとの固定ウィンドウ・レート制限 |
| `pinnedSystemPrompt` | 文字列を設定すると、クライアントが送った `system` を無視してこの値で強制上書きする。`null` なら素通し |
| `cors.allowedOrigins` | 許可する Origin の配列。空 `[]` の場合 CORS ヘッダを一切出さない(`*` の暗黙許可はしない) |
| `logging.logBodies` | `false`(既定)ではリクエスト/レスポンス本文を一切ログに出さない |
| `store.type` | `"memory"`(プロセス終了で消える)または `"file"`(JSON ファイルへ永続化) |
| `store.path` | `store.type: "file"` のときの保存先パス |

必須の環境変数: `upstream.apiKeyEnv` で指定した名前の環境変数(上流 API キー)、`SEKIMORI_ADMIN_KEY`(管理キー)。どちらか欠けていれば起動時にエラーで終了する(fail-closed)。

## LiteLLM で足りる人へ

複数プロバイダの統合・チーム運用・Postgres を使った本格的な予算管理が要るなら、[LiteLLM Proxy](https://github.com/BerriAI/litellm) の方が適している。sekimori はその手前、「Anthropic だけ・個人が身内に公開するだけ・依存は hono だけ」という一点に絞った道具で、LiteLLM が過剰装備に感じる規模のためのものだと考えてほしい。

## 実装上の判断メモ(fail-closed / 仕様の細部)

仕様(`docs/02-mvp-spec.md`)で明記されていない細部は、以下のように安全側(遮断側)に倒して実装した。

- **ストア書き込み失敗時の 503 の範囲**: 仕様は「予算会計の記録に失敗したら以後 503」とだけ述べているが、本実装ではストアが unhealthy になった時点で `/healthz` 以外の**全エンドポイント**(`/v1/messages` `/v1/usage` `/admin/*`)を 503 にしている。ストアが壊れている状況でトークン発行・失効などの管理操作を続けさせるのはより危険と判断したため。
- **モデル許可リストの照合**: `model in config.models` ではなく `Object.hasOwn` で照合している。`in` 演算子だと `toString` / `constructor` のようなモデル名がプロトタイプ継承経由ですり抜ける可能性があったため、fail-closed 側で塞いだ。
- **`GET /v1/usage` / `GET /admin/usage` の `monthUsd`**: `budget.monthlyUsd` は全トークン共通のキルスイッチという仕様上の位置づけなので、`monthUsd` は呼び出しトークンだけでなく**全トークン合算**の当月実績を返す。トークン個別の月次上限は仕様に存在しない。
- **`logging.logBodies: true` の挙動**: 非ストリーム応答についてはリクエスト本文・レスポンス本文をログに含める。ストリーミング応答については、SSE の複製ストリームをさらに二重にバッファする実装複雑化を避けるため、レスポンス本文はログに含めない(リクエスト本文のみ)。既定値 `false` ではいずれの場合も本文を一切ログに出さない。
- **管理キー比較**: `crypto.timingSafeEqual` で定数時間比較している(仕様に明記はないが、タイミング攻撃への基本的な備えとして採用)。
- **`config` の任意項目の既定値**: 検証必須項目(`models` の非空・価格の正数性・`apiKeyEnv` と `SEKIMORI_ADMIN_KEY` の存在)以外(`port` `rateLimit` `cors` `logging` `store.path`)は、省略時に妥当な既定値で補って起動を許可している。
- **`DELETE /admin/tokens/:id` で未知の id を指定した場合**: 仕様に応答コードの指定がないため `404` を返す(サイレントに成功扱いしない)。

## 実装しないこと

リトライ、キャッシュ、OpenAI 互換、Workers/KV、ダッシュボード、DB、Docker、CI 設定は MVP のスコープ外(`docs/02-mvp-spec.md` §10)。

## 体制

- 設計: Claude(Fable 5)
- MVP 実装: Claude(Sonnet 5)
- 公開・デプロイ・命名の最終決定: 人間(yktsnd)

## ステータス

- 2026-07: MVP 実装完了(`npm test` / `npx tsc --noEmit` グリーン)
- 名称 `sekimori` は仮。公開前に npm / GitHub / 商標の正式チェックを行う
