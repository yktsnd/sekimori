# sekimori(関守)

> AI プロトタイプを、API キーを晒さず・予算を溶かさず・悪用されずに公開するための、最小のセルフホスト型ゲートウェイ。

**「週末に作った AI プロトタイプを、友人・SNS・β ユーザーに触らせたい」瞬間のための道具。** あなたのアプリと Anthropic Messages API の間に立ち、**設定ファイル 1 枚 + プロセス 1 個**で、キー秘匿・確実に効く予算上限・招待トークン認証・レート制限・system プロンプトのサーバー側固定・SSE 素通しを提供する。

名前は江戸時代の関所の番人(関守)から。通行手形(トークン)を検め、通行量(予算)を管理する。

**単一プロセス前提**: レート制限・メモリストアはプロセス内メモリで完結する。水平スケールには対応せず、チーム/企業の本番運用は対象外。個人が身内に公開する規模(数十〜数千リクエスト/日)のための設計。

## まず 1 コマンドで全部見る

sekimori が守っている 6 つの瞬間(トークンなし侵入の遮断・予算超過・レート制限・許可外モデル拒否・トークン失効・その間も正当な利用者は普通に使える)を、実 API キーなし・課金ゼロで通しで見られる:

```bash
npm install        # 初回のみ
bash examples/demo.sh
```

擬似上流と sekimori を一時 config で起動し、`alice`(普通の利用者)と `mallory`(すぐ上限に達する設定)のトークンで全シナリオを実行し、各ステップの期待 HTTP ステータスを検証して必ず後片付けする。不一致が 1 つでもあれば非ゼロ終了する(E2E スモークテストを兼ねる)。実 API を使うおまけモード: `SEKIMORI_DEMO_REAL=1 ANTHROPIC_API_KEY=sk-... bash examples/demo.sh`(既定は必ずオフライン)。

## クイックスタート(オフライン・実キー不要)

```bash
npm install

# 1. 擬似上流(Anthropic Messages API のスタブ)を :9999 で起動
node examples/mock-upstream.mjs 9999
```

別ターミナルで:

```bash
# 2. スタブに向けた config を用意して sekimori を起動
cp sekimori.config.example.json sekimori.config.json
#    sekimori.config.json の upstream.baseUrl を "http://localhost:9999" に変更

ANTHROPIC_API_KEY=dummy SEKIMORI_ADMIN_KEY=change-me npx tsx src/main.ts sekimori.config.json
```

```bash
# 3. 招待トークンを発行してゲートウェイ越しに会話する
curl -s -X POST http://localhost:8787/admin/tokens \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","dailyUsd":1}'
# => {"id":"...","token":"smk_..."}

TOKEN=smk_xxxxxxxx  # 上のレスポンスの token

curl -s -X POST http://localhost:8787/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":100,"messages":[{"role":"user","content":"hello"}]}'
```

本番に向けるには `upstream.baseUrl` を `https://api.anthropic.com` にし、実際の `ANTHROPIC_API_KEY` を設定する。

ブラウザから試す場合は [`examples/chat.html`](examples/chat.html) を配信し(例: `python3 -m http.server 8000 --directory examples`)、配信元 Origin を `cors.allowedOrigins` に追加して再起動する。`chat.html` は**自分のアプリの出発点としてコピーする前提のリファレンスクライアント**: 開発者が編集する `CONFIG` ブロック、エンドユーザーの入力は招待トークンのみ(`localStorage` 保持)、使用量の常時表示、`error.type` ごとの利用者向けエラー文言を備える。

## ドキュメント

| したいこと | 読む場所 |
|---|---|
| 設定する | [docs/configuration.md](docs/configuration.md) |
| API を呼ぶ・管理する(全エンドポイント・curl 例・エラー型・`Retry-After`) | [docs/api.md](docs/api.md) |
| 設計制約を理解する(fail-closed の判断・拡張点) | [docs/design.md](docs/design.md) |
| 今後の予定を知る | [ROADMAP.md](ROADMAP.md) |
| 貢献する | [CONTRIBUTING.md](CONTRIBUTING.md) |
| なぜこう作ったかの経緯(ラウンド記録・日本語) | [docs/history/](docs/history/) |

一次言語は英語([README.md](README.md))。本ファイルはその日本語版で、内容が食い違う場合は英語版を正とする。

## テスト・型チェック

```bash
npm test          # node:test。モック上流を内包しており実 API キー不要
npm run typecheck # tsc --noEmit
```

## LiteLLM で足りる人へ

複数プロバイダ統合・チーム運用・Postgres ベースの予算管理が要るなら [LiteLLM Proxy](https://github.com/BerriAI/litellm) の方が適している。sekimori はその手前、「Anthropic だけ・個人が身内に公開するだけ・依存は hono だけ」という一点に絞った道具。

## 実装しないこと(非目標)

マルチテナント SaaS、課金代行、ダッシュボード、プロンプト管理、キャッシュ、リトライ、100+ プロバイダ対応、水平スケール。詳細は [docs/design.md](docs/design.md) と [CONTRIBUTING.md](CONTRIBUTING.md)。あなたの PR の時間を無駄にしないための宣言である。

## 体制

- 設計・レビュー: Claude(Fable 5)
- 実装: Claude(Sonnet 5)へ issue 単位で委託
- 公開・デプロイ・命名の最終決定: 人間([@yktsnd](https://github.com/yktsnd))

## ステータス

- 2026-07: MVP + DX レビュー対応完了、独立リポジトリ化。現在は v0.2 "distribution-ready"([ROADMAP.md](ROADMAP.md))を進行中。
