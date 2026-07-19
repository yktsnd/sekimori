import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "./helpers/mock-upstream.js";
import { buildApp, buildTestConfig, getUsage, issueToken, messagesRequest } from "./helpers/test-app.js";

test("request validation: malformed ordinary-text fields are rejected before reservation or upstream", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startMockUpstream((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500).end();
  });
  t.after(() => upstream.close());
  const { app, adminKey } = buildApp(
    buildTestConfig(upstream.baseUrl, { rateLimit: { requestsPerMinute: 100 } }),
  );
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  const base = { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  const malformed: Array<Record<string, unknown>> = [
    { ...base, messages: "typo" },
    { ...base, messages: [] },
    { ...base, messages: [{ role: "tool", content: "hi" }] },
    { ...base, messages: [{ role: "user", content: [{ type: "image", source: "x" }] }] },
    { ...base, system: 42 },
    { ...base, stream: "true" },
    { ...base, stop_sequences: "stop" },
    { ...base, temperature: 2 },
    { ...base, top_p: -1 },
    { ...base, top_k: 1.5 },
    { ...base, metadata: { unexpected: "value" } },
    { ...base, max_tokens: Number.MAX_SAFE_INTEGER },
  ];

  for (const body of malformed) {
    const res = await app.fetch(messagesRequest(issued.token, body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(((await res.json()) as { error: { type: string } }).error.type, "invalid_request_error");
    assert.equal((await getUsage(app, issued.token)).todayUsd, 0);
  }
  assert.equal(upstreamCalls, 0);
});
