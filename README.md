# sekimori(関守)

> AI プロトタイプを、API キーを晒さず・予算を溶かさず・悪用されずに公開するための、最小のセルフホスト型ゲートウェイ。

manabi-repeat の PoC 収束([経緯](docs/00-background.md))から出発した新プロジェクト。「AI を使える」と「AI アプリとして出せる」の間の障壁を、設定ファイル 1 枚 + プロセス 1 個で埋める。

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/00-background.md](docs/00-background.md) | manabi-repeat 収束の判断と、このテーマに至った経緯 |
| [docs/01-concept.md](docs/01-concept.md) | 課題・想定ユーザー・既存ツールとの差分・非目標・ロードマップ |
| [docs/02-mvp-spec.md](docs/02-mvp-spec.md) | MVP の実装契約(スコープ・API・予算ロジック・テスト・受け入れ条件) |

## 体制

- 設計: Claude(Fable 5)
- MVP 実装: Claude(Sonnet 5)— 上記実装契約に従う
- 公開・デプロイ・命名の最終決定: 人間(yktsnd)

## ステータス

- 2026-07: コンセプト・MVP 仕様を確定、MVP 実装中
- 名称 `sekimori` は仮。公開前に npm / GitHub / 商標の正式チェックを行う
