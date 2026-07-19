# Design history (frozen records)

These documents record **why** sekimori was shaped the way it is — one record
per design/review round, written in Japanese (the working language of the
original rounds). They are frozen: they describe the state of the project at
the time they were written and are **not** updated as the code evolves.

For the current behavior of sekimori, see the primary sources:

- [README](../../README.md) — what it is, quickstart
- [docs/configuration.md](../configuration.md) — config reference
- [docs/api.md](../api.md) — endpoint & error reference
- [docs/design.md](../design.md) — design principles and fail-closed decisions
- [ROADMAP.md](../../ROADMAP.md) — where the project is going

| # | Record | Round |
|---|---|---|
| 00 | [背景](00-background.md) | Why this problem (post manabi-repeat) |
| 01 | [コンセプト](01-concept.md) | Concept, target user, non-goals, alternatives considered |
| 02 | [MVP 仕様](02-mvp-spec.md) | Implementation contract for the MVP |
| 03 | [DX レビュー](03-dx-review.md) | Friction review: user & contributor journeys |
| 04 | [デモ設計](04-demo-design.md) | Design of `examples/demo.sh` and the reference client |
| 05 | [サステナビリティ・レビュー](05-sustainability-review.md) | Longevity analysis that produced the v0.2/v0.3 plan |
| 06 | [エージェント・オペレーター・レビュー](06-agent-operator-review.md) | Re-derivation for agent-operated use: owner/operator/end-user roles, v0.3 "agent-ready" plan |
| 07 | [オーナー・オンボーディング・レビュー](07-owner-onboarding-review.md) | Triggered by the owner's real questions; owner guide + Bedrock upstream, v0.4 "owner-ready" plan |
