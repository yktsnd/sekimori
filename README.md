# sekimori(関守)

> AI プロトタイプを、API キーを晒さず・予算を溶かさず・悪用されずに公開するための、最小のセルフホスト型ゲートウェイ。

「週末に作った AI プロトタイプを、友人・SNS・β ユーザーに触らせたい」段階の個人開発者向け。設定ファイル 1 枚 + プロセス 1 個で、キー秘匿・予算上限・招待トークン認証・レート制限・system プロンプト固定・SSE 素通しを提供する。背景は [docs/00-background.md](docs/00-background.md)、コンセプトは [docs/01-concept.md](docs/01-concept.md)、実装契約は [docs/02-mvp-spec.md](docs/02-mvp-spec.md)、DX レビューは [docs/03-dx-review.md](docs/03-dx-review.md)、デモ設計は [docs/04-demo-design.md](docs/04-demo-design.md) を参照。

**単一プロセス前提**: sekimori は水平スケールに対応していない。レート制限・トークンストア(memory 時)はプロセス内メモリで完結する設計であり、複数インスタンスを同時に立てて共有することはできない。個人が身内に公開する規模(数十〜数千リクエスト/日程度)を想定している。

### ドキュメント一覧(読む順序)

初めてこのプロジェクトをレビューする場合は上から順に。**現在の挙動の一次情報源は本 README とソースコード**であり、`docs/` 配下は各ラウンドの設計判断の記録(なぜその形にしたか)。

| # | 文書 | ステータス |
|---|---|---|
| 00 | [背景](docs/00-background.md) | 確定(manabi-repeat 収束の経緯) |
| 01 | [コンセプト](docs/01-concept.md) | 確定(随時ロードマップのみ更新) |
| 02 | [MVP 仕様(実装契約)](docs/02-mvp-spec.md) | **凍結済みの歴史文書**(以後の変更は未反映。現状は本 README を参照) |
| 03 | [DX レビュー](docs/03-dx-review.md) | 確定(「今すぐ直す」項目は本 README に反映済み。「公開前必須」は未着手) |
| 04 | [デモ設計](docs/04-demo-design.md) | 確定・実装済み(`examples/demo.sh` / `examples/chat.html`) |

## まず 1 コマンドで全部見る

sekimori が守っている 6 つの瞬間(トークンなし侵入の遮断・予算超過・レート制限・許可外モデル拒否・トークン失効・その間も正当な利用者は普通に使える)を、実 API キーなし・課金ゼロで 1 コマンドのまま通しで見られる。

```bash
npm install        # 初回のみ
bash examples/demo.sh
```

擬似上流と sekimori 本体を一時ディレクトリの config で起動し、`alice`(普通の利用者)と `mallory`(すぐ上限に達する設定の利用者)のトークンで一通りのシナリオを実行したあと、必ず後片付けして終了する。各ステップは期待 HTTP ステータスを検証しており、1 つでも不一致なら非ゼロ終了する(スモークテストを兼ねる)。詳しい設計は [docs/04-demo-design.md](docs/04-demo-design.md) を参照。実 API を使うおまけモードもある: `SEKIMORI_DEMO_REAL=1 ANTHROPIC_API_KEY=sk-... bash examples/demo.sh`(既定は必ずオフライン)。

## オフライン・クイックスタート

`demo.sh` は自動シナリオだが、ここでは自分の手で `curl` を叩きながら一つずつ確認できる。実 API キーなしで、依存ゼロの擬似 Anthropic サーバーに向けて一通り動かせる。

```bash
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
# ブラウザで http://localhost:8000/chat.html を開き、招待トークンを入力して送信
```

`examples/chat.html` を実際に使う場合は、`sekimori.config.json` の `cors.allowedOrigins` に配信元(上の例では `"http://localhost:8000"`)を追加してからサーバーを再起動すること。

## `examples/chat.html` — リファレンスクライアント

`chat.html` は「動くチャット画面」ではなく、**自分のアプリの出発点としてそのままコピーする前提のファイル**(DX レビュー A-4、設計は [docs/04-demo-design.md](docs/04-demo-design.md) §2)。依存ゼロ・単一ファイル・ビルドなしのまま、次の形にしてある。

- **開発者が触る場所とエンドユーザーが触る場所を分離**: ファイル冒頭の `<script>` に `CONFIG`(`baseUrl` / `model` / `appName` / `maxTokens`)を置いてあり、自分のアプリにするにはここだけ書き換える。エンドユーザーに URL やモデル名を入力させる UI は存在しない
- **エンドユーザーが持つのは招待トークンだけ**: 初回にトークンを入力すると `localStorage` に保存され、以後は入力欄を出さない。「トークンを変更」リンクでいつでも再入力できる
- **複数ターンの会話**: 送受信のたびに `messages` 配列をページ内で積み上げて送る(リロードで消えてよい)
- **使用量を常時表示**: 送信のたびに `GET /v1/usage` を取得し「今日の利用: $0.012 / $1.000」を小さく表示し続ける
- **エラーは `error.type` ごとに利用者の言葉で表示**(生の HTTP ステータスや JSON は既定では見せず、`<details>` に折りたたみ表示するのみ):
  - `authentication_error` → 「招待トークンが無効です。配布元に確認してください」+ トークン再入力欄を自動表示
  - `budget_exceeded_error` → 「今日の利用上限に達しました。あと約◯時間で再開します」(`Retry-After` から計算)
  - `rate_limit_error` → 「送信が速すぎます。◯秒待ってください」(`Retry-After` をそのまま秒数表示)
  - その他・通信エラー → 「接続できません。運営者に連絡してください」

## テスト・型チェック

```bash
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

**`Retry-After`(A-6)**: 予算超過(`budget_exceeded_error`)とレート制限(`rate_limit_error`)の `429` には `Retry-After` ヘッダ(秒数)が付く。

- 日次上限超過 → 次の UTC 深夜(`00:00:00 UTC`)までの秒数
- 月次上限超過(全体のキルスイッチ) → 翌月 1 日 `00:00:00 UTC` までの秒数
- レート制限超過 → 現在の 1 分ウィンドウが終わるまでの秒数

いずれも `src/budget.ts` の純粋関数(`secondsUntilNextUTCMidnight` / `secondsUntilNextUTCMonth` / `retryAfterSecondsForReason`)で計算しており、単体テストで境界(月またぎ・年またぎ)を確認している。

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
- **非許可 Origin 警告のスロットリング(A-5)**: DX レビューは「1 行の警告を出す」とだけ述べており頻度は規定していない。本実装ではリクエストごとに毎回警告する(同一 Origin から連打されると stdout が埋まり得る)。運営者に「気づかせる」という目的は満たすため、デデュープ等の抑制ロジックは今回のスコープ外とした。
- **`examples/demo.sh` のレート制限シナリオ**: 設計([04-demo-design.md](docs/04-demo-design.md) §1 手順 12)は「alice が 6 連打 → 6 回目が 429」と書かれているが、実装ではレート制限のカウンタが `/v1/messages` へのリクエストごと(モデル拒否で弾かれた分も含む)に消費されるため、同一スクリプト内で alice が事前に行った呼び出し(非ストリーム・ストリーム・許可外モデル拒否の 3 回)も同じ 1 分ウィンドウの消費に数える。よって「ちょうど 6 回目」を固定で assert すると実行順に依存して壊れる。本実装では「6 回連打するうちに `rate_limit_error` + `Retry-After` が必ず 1 回は発生すること」を検証しており、何回目で発生したかは画面に表示するに留めている。
- **`examples/demo.sh` の mallory 予算超過の起こし方**: `dailyUsd: 0.001` という極小値そのものだけでは、JSON シリアライズのバイト数に依存する見積もり計算が微妙な境界になり脆い。そこで既存の `test/budget-integration.test.ts` と同じ手法(1 回目は小さい `max_tokens`、2 回目は非現実的に大きい `max_tokens` を渡してワーストケース見積もりを確実に上限突破させる)を採用し、決定的に「1 回目成功・2 回目 429」を再現している。

## 実装しないこと

リトライ、キャッシュ、OpenAI 互換、Workers/KV、ダッシュボード、DB、Docker、CI 設定は MVP のスコープ外(`docs/02-mvp-spec.md` §10)。

## 体制

- 設計: Claude(Fable 5)
- MVP 実装・DX レビュー対応実装: Claude(Sonnet 5)
- 公開・デプロイ・命名の最終決定: 人間(yktsnd)

## ステータス

- 2026-07: MVP 実装完了(`npm test` / `npx tsc --noEmit` グリーン)
- 2026-07: DX レビュー([03-dx-review.md](docs/03-dx-review.md))の「今すぐ直す」7 件に対応(起動サマリ・config 不在時の案内・`Retry-After`・非許可 Origin 警告・`chat.html` のリファレンスクライアント化・`examples/demo.sh`)。`npm test` / `npx tsc --noEmit` グリーン、`bash examples/demo.sh` オフライン完走を確認
- 2026-07: 独立リポジトリ `yktsnd/sekimori` として切り出し(コミット履歴込み)。公開前必須項目(npm 配布・英語一次言語化・CONTRIBUTING・CI・デプロイガイド・商標チェック)は `docs/03-dx-review.md` の該当節を参照
