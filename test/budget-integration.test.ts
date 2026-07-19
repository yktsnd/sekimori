// Design doc 8-3: budget - the precheck blocks (429) on both the daily and
// the monthly limit, and the mock response's usage is recorded as actual spend.
// A-6: the 429 carries Retry-After - seconds until the next UTC midnight for
// daily, until the 1st of the next month UTC for monthly.

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, getUsage, issueToken, messagesRequest } from "./helpers/test-app.js";
import { monthKeyUTC, secondsUntilNextUTCMidnight, secondsUntilNextUTCMonth } from "../src/budget.js";
import { MAX_NON_STREAM_RESPONSE_BYTES } from "../src/proxy.js";

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
  // Must match the monthly-specific function (secondsUntilNextUTCMonth), which
  // doubles as a check that it wasn't confused with the daily one (secondsUntilNextUTCMidnight).
  const expected = secondsUntilNextUTCMonth(before);
  assert.ok(Math.abs(retryAfter - expected) <= 2, `expected ~${expected}, got ${retryAfter}`);
});

test("budget: successful call records actual usage cost from upstream response, not the worst-case estimate", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 100, outputTokens: 100 }));
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
  // 100 input tok * $1/MTok + 100 output tok * $2/MTok = $0.0003
  assert.ok(Math.abs(usage.todayUsd - 0.0003) < 1e-12);
});

test("budget: provider usage above the reservation trips a fail-closed accounting circuit", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 10_000, output_tokens: 10_000 } }));
  });
  t.after(() => upstream.close());
  const { app, adminKey, store } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  const body = { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const first = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(first.status, 503);
  assert.equal(((await first.json()) as { error: { type: string } }).error.type, "accounting_unavailable_error");
  assert.ok((await store.getGlobalMonthlyUsage(monthKeyUTC())) > 0.01, "actual reported cost remains charged");

  const second = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(second.status, 503);
  assert.equal(upstreamCalls, 1);
});

test("budget: an ambiguous upstream 424 keeps its reservation and then blocks at the local cap", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(424, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "model_error", message: "model processing failed" } }));
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const body = { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const first = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(first.status, 502);
  assert.equal(((await first.json()) as { error: { type: string } }).error.type, "upstream_error");
  assert.equal(first.headers.get("retry-after"), null, "provider rate/budget semantics must not leak into local controls");
  assert.ok((await getUsage(app, issued.token)).todayUsd > 1, "worst-case reservation must remain after an ambiguous 424");

  // The same request is now blocked locally. The gateway cannot prove that a
  // provider-side model-processing failure was unbilled, so it fails closed.
  const second = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(second.status, 429);
  assert.equal(upstreamCalls, 1);
  assert.ok((await getUsage(app, issued.token)).todayUsd > 1);
});

test("budget: reserves atomically so concurrent calls cannot both pass one daily cap", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "test-model",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
      );
    }, 100);
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const body = { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const responses = await Promise.all([
    app.fetch(messagesRequest(issued.token, body)),
    app.fetch(messagesRequest(issued.token, body)),
  ]);
  assert.deepEqual(
    responses.map((res) => res.status).sort(),
    [200, 429],
  );
  assert.equal(upstreamCalls, 1);
});

test("budget: large request fields outside messages are included in the precheck", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1_000_000, outputPerMTok: 1 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 100 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      system: "x".repeat(1_000),
    }),
  );
  assert.equal(res.status, 429);
  assert.equal(upstreamCalls, 0);
});

test("budget: provider-managed paid features are rejected before upstream and budget reservation", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  );

  assert.equal(res.status, 400);
  assert.equal(upstreamCalls, 0);
  assert.equal((await getUsage(app, issued.token)).todayUsd, 0);
});

test("budget: an unsafe max_tokens integer is rejected before upstream and budget reservation", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: Number.MAX_SAFE_INTEGER + 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  );

  assert.equal(res.status, 400);
  assert.equal(upstreamCalls, 0);
  assert.equal((await getUsage(app, issued.token)).todayUsd, 0);
});

test("budget: oversized requests are rejected before they can enter an unmodeled long-context price tier", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(70_000) }],
    }),
  );

  assert.equal(res.status, 413);
  assert.equal(upstreamCalls, 0);
  assert.equal((await getUsage(app, issued.token)).todayUsd, 0);
});

test("budget: raw body limit applies before a pinned system prompt can replace it", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, { pinnedSystemPrompt: "short server prompt" });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      system: "x".repeat(70_000),
    }),
  );

  assert.equal(res.status, 413);
  assert.equal(upstreamCalls, 0);
  assert.equal((await getUsage(app, issued.token)).todayUsd, 0);
});

test("budget: deeply nested JSON is rejected without recursion or upstream I/O", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  let nested: unknown = "x";
  for (let i = 0; i < 80; i += 1) nested = [nested];

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      metadata: { nested },
    }),
  );

  assert.equal(res.status, 400);
  assert.match(await res.text(), /nesting is too deep/);
  assert.equal(upstreamCalls, 0);
  assert.equal((await getUsage(app, issued.token)).todayUsd, 0);
});

test("budget: a pinned system prompt cannot hide a deep submitted tree from logging", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  t.after(() => upstream.close());

  const { app, adminKey } = buildApp(
    buildTestConfig(upstream.baseUrl, { pinnedSystemPrompt: "short server prompt", logging: { logBodies: true } }),
  );
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  let nested: unknown = "x";
  for (let i = 0; i < 80; i += 1) nested = [nested];

  const rejected = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
      system: nested,
    }),
  );
  assert.equal(rejected.status, 400);
  assert.equal(upstreamCalls, 0);

  const normal = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 1,
      messages: [{ role: "user", content: "still healthy" }],
    }),
  );
  assert.equal(normal.status, 200);
  assert.equal(upstreamCalls, 1);
});

test("budget: an ambiguous upstream network failure retains the worst-case reservation", async () => {
  const config = buildTestConfig("http://127.0.0.1:1", {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });

  const res = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 502);
  assert.ok((await getUsage(app, issued.token)).todayUsd >= 1, "worst-case reservation must remain after an ambiguous failure");
});

test("budget: an oversized upstream response is rejected without releasing the worst-case reservation", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    // Chunked encoding keeps this test on the actual incremental byte-limit
    // path rather than relying solely on the Content-Length preflight.
    res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
    res.end(Buffer.alloc(MAX_NON_STREAM_RESPONSE_BYTES + 1, 0x78));
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const body = { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const first = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(first.status, 502);
  assert.match(await first.text(), /response exceeded the gateway safety limit/);
  assert.ok((await getUsage(app, issued.token)).todayUsd > 1);

  const second = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(second.status, 429);
  assert.equal(upstreamCalls, 1);
});

test("budget: upstream response-header timeout is bounded and keeps the worst-case reservation", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((req, _res) => {
    upstreamCalls += 1;
    // Consume the request, then deliberately never send response headers.
    req.resume();
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    upstream: { baseUrl: upstream.baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", timeoutMs: 1_000, type: "anthropic" },
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const body = { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const startedAt = Date.now();
  const first = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(first.status, 502);
  assert.ok(Date.now() - startedAt < 3_000, "response-header timeout must bound the request");
  assert.ok((await getUsage(app, issued.token)).todayUsd > 1);

  const second = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(second.status, 429);
  assert.equal(upstreamCalls, 1);
});

test("budget: non-streaming response-body timeout is bounded and keeps the worst-case reservation", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((req, res) => {
    upstreamCalls += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    // Deliberately never finish the response body.
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    upstream: { baseUrl: upstream.baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", timeoutMs: 1_000, type: "anthropic" },
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1_000_000 } },
    budget: { monthlyUsd: 100, defaultDailyPerTokenUsd: 1.5 },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 1.5 });
  const body = { model: "test-model", max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const startedAt = Date.now();
  const first = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(first.status, 502);
  assert.ok(Date.now() - startedAt < 3_000, "response-body timeout must bound the request");
  assert.ok((await getUsage(app, issued.token)).todayUsd > 1);

  const second = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(second.status, 429);
  assert.equal(upstreamCalls, 1);
});
