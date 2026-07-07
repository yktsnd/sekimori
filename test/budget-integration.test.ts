// §8-3: 予算 — 日次上限・月次上限それぞれでプリチェック遮断（429）。
// モック応答の usage が実績として加算されること。
// A-6: 429 には Retry-After が付き、日次は次の UTC 深夜まで、月次は翌月 1 日 UTC までの秒数になること。

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, getUsage, issueToken, messagesRequest } from "./helpers/test-app.js";
import { secondsUntilNextUTCMidnight, secondsUntilNextUTCMonth } from "../src/budget.js";

test("budget: per-token daily limit blocks with 429 before calling upstream, with Retry-After until next UTC midnight", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 100, outputTokens: 100 }));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1 } },
    budget: { monthlyUsd: 1000, defaultDailyPerTokenUsd: 0.5 },
  });
  const { app, adminKey } = buildApp(config);
  // tiny daily budget: any realistic max_tokens worst-case estimate blows through it
  const issued = await issueToken(app, adminKey, { dailyUsd: 0.000001 });

  const before = new Date();
  const res = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 1_000_000, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 429);
  const json = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "budget_exceeded_error");

  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter), "Retry-After header must be a number");
  const expected = secondsUntilNextUTCMidnight(before);
  assert.ok(Math.abs(retryAfter - expected) <= 2, `expected ~${expected}, got ${retryAfter}`);
  assert.ok(retryAfter <= 86400);
});

test("budget: global monthly killswitch blocks with 429 even with daily headroom, with Retry-After until 1st of next UTC month", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 100, outputTokens: 100 }));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1 } },
    budget: { monthlyUsd: 0.000001, defaultDailyPerTokenUsd: 1000 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1000 });

  const before = new Date();
  const res = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 429);
  const json = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "budget_exceeded_error");

  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter), "Retry-After header must be a number");
  // 月次専用の計算関数（secondsUntilNextUTCMonth）の値と一致すること = 日次計算(secondsUntilNextUTCMidnight)
  // と取り違えていないことの確認を兼ねる。
  const expected = secondsUntilNextUTCMonth(before);
  assert.ok(Math.abs(retryAfter - expected) <= 2, `expected ~${expected}, got ${retryAfter}`);
});

test("budget: successful call records actual usage cost from upstream response, not the worst-case estimate", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 2 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  // max_tokens is huge, so worstCost would be far bigger than the actual accounted cost
  // if worstCost were (wrongly) recorded instead of actual usage.
  const res = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 999_999, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 200);

  const usage = await getUsage(app, issued.token);
  // 1,000,000 input tok * $1/MTok + 1,000,000 output tok * $2/MTok = $3
  assert.equal(usage.todayUsd, 3);
});
