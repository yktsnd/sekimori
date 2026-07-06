// §8-4: ストリーミング — SSE が改変なくクライアントに届き、かつ usage が会計されること

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, sseMessagesHandler, buildSseBody } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, getUsage, issueToken, messagesRequest, waitFor } from "./helpers/test-app.js";

test("streaming: SSE bytes are relayed byte-for-byte and usage is accounted afterwards", async (t) => {
  const usageOpts = { inputTokens: 50, outputTokens: 20 };
  const upstream = await startMockUpstream(sseMessagesHandler(usageOpts));
  t.after(() => upstream.close());
  const config = buildTestConfig(upstream.baseUrl, {
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1 } },
  });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

  const text = await res.text();
  assert.equal(text, buildSseBody(usageOpts), "SSE body must be relayed unmodified");

  const expectedCost = (usageOpts.inputTokens / 1_000_000) * 1 + (usageOpts.outputTokens / 1_000_000) * 1;
  await waitFor(async () => {
    const usage = await getUsage(app, issued.token);
    return Math.abs(usage.todayUsd - expectedCost) < 1e-9;
  });
});
