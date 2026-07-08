// bedrock.test.ts - Amazon Bedrock upstream (issue #17): Bearer auth,
// non-streaming InvokeModel body transform, and fail-closed streaming
// rejection before any budget is consumed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  startMockUpstream,
  bedrockInvokeModelHandler,
  type BedrockCapture,
} from "./helpers/mock-upstream.js";
import {
  buildTestConfig,
  buildApp,
  getUsage,
  issueToken,
  messagesRequest,
  TEST_UPSTREAM_API_KEY,
} from "./helpers/test-app.js";

test("bedrock: non-streaming round trip - URL, headers, body transform, response passthrough, usage accounted", async (t) => {
  const captures: BedrockCapture[] = [];
  const upstream = await startMockUpstream(bedrockInvokeModelHandler(captures, { inputTokens: 40, outputTokens: 15 }));
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    upstream: { baseUrl: upstream.baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", type: "bedrock" },
    models: { "global.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMTok: 1, outputPerMTok: 5 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);

  assert.equal(captures.length, 1);
  const captured = captures[0];
  if (!captured) throw new Error("expected a captured request");

  // URL contains the URL-encoded model id.
  assert.equal(captured.method, "POST");
  assert.ok(
    captured.path.includes(encodeURIComponent("global.anthropic.claude-haiku-4-5-20251001-v1:0")),
    `path should contain the encoded model id, got: ${captured.path}`,
  );
  assert.match(captured.path, /^\/model\//);
  assert.ok(captured.path.endsWith("/invoke"));

  // Headers: Bearer <upstream api key>, content-type json, no x-api-key / anthropic-version.
  assert.equal(captured.headers.authorization, `Bearer ${TEST_UPSTREAM_API_KEY}`);
  assert.equal(captured.headers["content-type"], "application/json");
  assert.equal(captured.headers["x-api-key"], undefined);
  assert.equal(captured.headers["anthropic-version"], undefined);

  // Body transform: anthropic_version added, model + stream removed, rest passed through.
  const body = captured.body as Record<string, unknown>;
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.ok(!("model" in body), "model must be removed from the upstream body");
  assert.ok(!("stream" in body), "stream must be removed from the upstream body");
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);

  // Response is relayed unchanged (Anthropic-shaped JSON).
  const json = (await res.json()) as { content: { type: string; text: string }[]; usage: unknown };
  assert.equal(json.content[0]?.text, "hello from bedrock");

  // Usage was accounted.
  const expectedCost = (40 / 1_000_000) * 1 + (15 / 1_000_000) * 5;
  const usage = await getUsage(app, issued.token);
  assert.ok(Math.abs(usage.todayUsd - expectedCost) < 1e-9, `expected ~${expectedCost}, got ${usage.todayUsd}`);
});

test("bedrock: stream:true is rejected fail-closed before any upstream call or budget consumption", async (t) => {
  const captures: BedrockCapture[] = [];
  const upstream = await startMockUpstream(bedrockInvokeModelHandler(captures));
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    upstream: { baseUrl: upstream.baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", type: "bedrock" },
    models: { "global.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMTok: 1, outputPerMTok: 5 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 400);
  const json = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "invalid_request_error");
  assert.match(json.error.message, /bedrock/i);
  assert.match(json.error.message, /stream/i);

  // No call ever reached the mock upstream.
  assert.equal(captures.length, 0);

  // No spend was recorded either.
  const usage = await getUsage(app, issued.token);
  assert.equal(usage.todayUsd, 0);
});

test("bedrock: missing usage in the upstream response falls back to worst-cost accounting (unchanged behavior)", async (t) => {
  const captures: BedrockCapture[] = [];
  const upstream = await startMockUpstream((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      captures.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: { ...req.headers },
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_bedrock_no_usage",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "no usage field here" }],
          model: "test-model",
          stop_reason: "end_turn",
        }),
      );
    })();
  });
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, {
    upstream: { baseUrl: upstream.baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", type: "bedrock" },
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 5 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);

  // worstCost accounting applies unchanged: some non-zero cost was recorded
  // even though the mock upstream sent no usage field.
  const usage = await getUsage(app, issued.token);
  assert.ok(usage.todayUsd > 0, "expected worst-cost fallback to record a non-zero cost");
});
