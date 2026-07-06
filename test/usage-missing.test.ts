// §8-5: usage 欠落時に worstCost が計上されること

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandlerWithoutUsage } from "./helpers/mock-upstream.js";
import { estimateInputTokens } from "../src/budget.js";
import { buildTestConfig, buildApp, getUsage, issueToken, messagesRequest } from "./helpers/test-app.js";

test("usage missing from upstream response: worstCost is recorded as the actual charge", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandlerWithoutUsage());
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 3, outputPerMTok: 7 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const messages = [{ role: "user", content: "hi" }];
  const maxTokens = 50;

  const res = await app.fetch(messagesRequest(issued.token, { model: "test-model", max_tokens: maxTokens, messages }));
  assert.equal(res.status, 200);

  const usage = await getUsage(app, issued.token);
  const inputTokens = estimateInputTokens(messages, undefined);
  const expectedWorst = (inputTokens / 1_000_000) * 3 + (maxTokens / 1_000_000) * 7;
  assert.ok(Math.abs(usage.todayUsd - expectedWorst) < 1e-9, `expected ~${expectedWorst}, got ${usage.todayUsd}`);
});
