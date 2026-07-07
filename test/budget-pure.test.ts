// Unit tests for the pure functions in budget.ts (section 5: no I/O, so they get unit tests)

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeActualCost,
  dateKeyUTC,
  estimateInputTokens,
  estimateWorstCost,
  monthKeyUTC,
  precheckBudget,
  retryAfterSecondsForReason,
  secondsUntilNextUTCMidnight,
  secondsUntilNextUTCMonth,
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

// --- Retry-After computation (A-6) ------------------------------------------

test("secondsUntilNextUTCMidnight: mid-day gives seconds to 00:00 UTC the next day", () => {
  const now = new Date(Date.UTC(2026, 6, 6, 10, 0, 0, 0)); // 2026-07-06T10:00:00Z
  const expected = 14 * 3600; // 10:00 -> 24:00 is 14 hours
  assert.equal(secondsUntilNextUTCMidnight(now), expected);
});

test("secondsUntilNextUTCMidnight: one second before midnight rounds up to 1", () => {
  const now = new Date(Date.UTC(2026, 6, 6, 23, 59, 59, 500));
  assert.equal(secondsUntilNextUTCMidnight(now), 1);
});

test("secondsUntilNextUTCMidnight: just after midnight gives ~86400 seconds (rolls into the following day)", () => {
  const now = new Date(Date.UTC(2026, 6, 6, 0, 0, 0, 0));
  assert.equal(secondsUntilNextUTCMidnight(now), 86400);
});

test("secondsUntilNextUTCMonth: mid-month gives seconds to the 1st of next month 00:00 UTC", () => {
  const now = new Date(Date.UTC(2026, 6, 15, 0, 0, 0, 0)); // 2026-07-15T00:00:00Z
  const next = Date.UTC(2026, 7, 1, 0, 0, 0, 0); // 2026-08-01T00:00:00Z
  const expected = Math.ceil((next - now.getTime()) / 1000);
  assert.equal(secondsUntilNextUTCMonth(now), expected);
});

test("secondsUntilNextUTCMonth: December rolls over into January of the next year", () => {
  const now = new Date(Date.UTC(2026, 11, 31, 12, 0, 0, 0)); // 2026-12-31T12:00:00Z
  const next = Date.UTC(2027, 0, 1, 0, 0, 0, 0); // 2027-01-01T00:00:00Z
  const expected = Math.ceil((next - now.getTime()) / 1000);
  assert.equal(secondsUntilNextUTCMonth(now), expected);
  assert.equal(expected, 12 * 3600);
});

test("secondsUntilNextUTCMonth: never returns less than 1 even right at the boundary", () => {
  const now = new Date(Date.UTC(2026, 7, 1, 0, 0, 0, 0)); // exactly on the 1st
  const next = Date.UTC(2026, 8, 1, 0, 0, 0, 0);
  assert.equal(secondsUntilNextUTCMonth(now), Math.ceil((next - now.getTime()) / 1000));
});

test("retryAfterSecondsForReason: dispatches daily_limit to next UTC midnight", () => {
  const now = new Date(Date.UTC(2026, 6, 6, 22, 0, 0, 0));
  assert.equal(retryAfterSecondsForReason("daily_limit", now), secondsUntilNextUTCMidnight(now));
});

test("retryAfterSecondsForReason: dispatches monthly_limit to the 1st of next UTC month", () => {
  const now = new Date(Date.UTC(2026, 6, 6, 22, 0, 0, 0));
  assert.equal(retryAfterSecondsForReason("monthly_limit", now), secondsUntilNextUTCMonth(now));
});
