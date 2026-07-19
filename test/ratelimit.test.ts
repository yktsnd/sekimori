// Design doc 8-7: rate limit - request N+1 gets 429

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";
import { RateLimiter } from "../src/ratelimit.js";

test("rate limit: rolling window prevents a 2N burst across a wall-clock minute boundary", () => {
  const limiter = new RateLimiter(2);
  assert.equal(limiter.check("token", 59_998).allowed, true);
  limiter.release("token");
  assert.equal(limiter.check("token", 59_999).allowed, true);
  limiter.release("token");

  const boundaryBurst = limiter.check("token", 60_000);
  assert.equal(boundaryBurst.allowed, false);
  assert.equal(boundaryBurst.retryAfterSeconds, 60);
});

test("rate limit: active request slots are bounded and released independently of the rolling count", () => {
  const limiter = new RateLimiter(2);
  assert.equal(limiter.check("token", 1_000).allowed, true);
  assert.equal(limiter.check("token", 1_001).allowed, true);
  assert.deepEqual(limiter.check("token", 61_001), { allowed: false, retryAfterSeconds: 1 });

  limiter.release("token");
  assert.equal(limiter.check("token", 61_001).allowed, true);
});

test("rate limit: process-wide active requests are bounded across invite tokens", () => {
  const limiter = new RateLimiter(10, 2);
  assert.equal(limiter.check("token-a", 0).allowed, true);
  assert.equal(limiter.check("token-b", 0).allowed, true);
  assert.deepEqual(limiter.check("token-c", 0), { allowed: false, retryAfterSeconds: 1 });

  limiter.release("token-a");
  assert.equal(limiter.check("token-c", 0).allowed, true);
});

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
