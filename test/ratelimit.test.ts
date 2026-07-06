// §8-7: レート制限 — 上限+1 回目が 429

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";

test("rate limit: (N+1)th request within the same window returns 429 with Retry-After", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, { rateLimit: { requestsPerMinute: 2 } });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const body = { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  const r1 = await app.fetch(messagesRequest(issued.token, body));
  const r2 = await app.fetch(messagesRequest(issued.token, body));
  const r3 = await app.fetch(messagesRequest(issued.token, body));

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.ok(r3.headers.get("retry-after"), "429 response must include Retry-After header");
  const json = (await r3.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "rate_limit_error");
});

test("rate limit: is scoped per token, not global", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, { rateLimit: { requestsPerMinute: 1 } });
  const { app, adminKey } = buildApp(config);
  const tokenA = await issueToken(app, adminKey, { dailyUsd: 100 });
  const tokenB = await issueToken(app, adminKey, { dailyUsd: 100 });

  const body = { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  const a1 = await app.fetch(messagesRequest(tokenA.token, body));
  const a2 = await app.fetch(messagesRequest(tokenA.token, body));
  const b1 = await app.fetch(messagesRequest(tokenB.token, body));

  assert.equal(a1.status, 200);
  assert.equal(a2.status, 429);
  assert.equal(b1.status, 200);
});
