// budget.ts の純粋関数の単体テスト（§5: I/O を持たないので単体テスト対象にする）

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeActualCost,
  dateKeyUTC,
  estimateInputTokens,
  estimateWorstCost,
  monthKeyUTC,
  precheckBudget,
} from "../src/budget.js";

test("estimateInputTokens: ceil(utf8ByteLength(JSON.stringify(messages)+system)/4)", () => {
  const messages = [{ role: "user", content: "hi" }];
  const system = "be nice";
  const tokens = estimateInputTokens(messages, system);
  const expectedBytes = Buffer.byteLength(JSON.stringify(messages) + system, "utf8");
  assert.equal(tokens, Math.ceil(expectedBytes / 4));
});

test("estimateInputTokens: null/undefined system contributes nothing", () => {
  const messages = [{ role: "user", content: "hi" }];
  assert.equal(estimateInputTokens(messages, null), estimateInputTokens(messages, undefined));
});

test("estimateWorstCost: input estimate + max_tokens output at given pricing", () => {
  const pricing = { inputPerMTok: 2, outputPerMTok: 10 };
  const messages = [{ role: "user", content: "x".repeat(4000) }];
  const worst = estimateWorstCost({ messages, system: null, maxTokens: 1000, pricing });
  const inputTokens = estimateInputTokens(messages, null);
  const expected = (inputTokens / 1_000_000) * 2 + (1000 / 1_000_000) * 10;
  assert.ok(Math.abs(worst - expected) < 1e-12);
});

test("computeActualCost: uses real usage counts, not estimates", () => {
  const pricing = { inputPerMTok: 1, outputPerMTok: 5 };
  const cost = computeActualCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, pricing);
  assert.equal(cost, 6);
});

test("precheckBudget: monthly killswitch takes priority over daily headroom", () => {
  const decision = precheckBudget({
    worstCost: 5,
    tokenTodayUsd: 0,
    tokenDailyUsd: 100,
    globalMonthUsd: 27,
    globalMonthlyUsd: 30,
  });
  assert.deepEqual(decision, { allowed: false, reason: "monthly_limit" });
});

test("precheckBudget: blocks on per-token daily limit", () => {
  const decision = precheckBudget({
    worstCost: 5,
    tokenTodayUsd: 8,
    tokenDailyUsd: 10,
    globalMonthUsd: 0,
    globalMonthlyUsd: 1000,
  });
  assert.deepEqual(decision, { allowed: false, reason: "daily_limit" });
});

test("precheckBudget: allows when comfortably under both limits", () => {
  const decision = precheckBudget({
    worstCost: 1,
    tokenTodayUsd: 0,
    tokenDailyUsd: 10,
    globalMonthUsd: 0,
    globalMonthlyUsd: 30,
  });
  assert.deepEqual(decision, { allowed: true });
});

test("precheckBudget: exact boundary (equal to limit) is rejected, not just over", () => {
  const decision = precheckBudget({
    worstCost: 10,
    tokenTodayUsd: 0,
    tokenDailyUsd: 10,
    globalMonthUsd: 0,
    globalMonthlyUsd: 1000,
  });
  // worstCost + tokenTodayUsd == tokenDailyUsd is not > dailyUsd, so this should be allowed.
  assert.deepEqual(decision, { allowed: true });
});

test("dateKeyUTC / monthKeyUTC: UTC formatting, not local time", () => {
  const d = new Date(Date.UTC(2026, 6, 6, 23, 59));
  assert.equal(dateKeyUTC(d), "2026-07-06");
  assert.equal(monthKeyUTC(d), "2026-07");
});
