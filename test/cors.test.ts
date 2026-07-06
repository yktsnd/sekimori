// §7: CORS — allowedOrigins に列挙された Origin のみ許可（* を暗黙で出さない）

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp } from "./helpers/test-app.js";

test("cors: empty allowedOrigins emits no CORS headers at all", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const { app } = buildApp(buildTestConfig(upstream.baseUrl, { cors: { allowedOrigins: [] } }));

  const res = await app.fetch(
    new Request("http://localhost/healthz", { headers: { Origin: "https://example.com" } }),
  );
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("cors: only listed origins get Access-Control-Allow-Origin, others get none", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const { app } = buildApp(
    buildTestConfig(upstream.baseUrl, { cors: { allowedOrigins: ["https://allowed.example.com"] } }),
  );

  const allowedRes = await app.fetch(
    new Request("http://localhost/healthz", { headers: { Origin: "https://allowed.example.com" } }),
  );
  assert.equal(allowedRes.headers.get("access-control-allow-origin"), "https://allowed.example.com");

  const disallowedRes = await app.fetch(
    new Request("http://localhost/healthz", { headers: { Origin: "https://not-allowed.example.com" } }),
  );
  assert.equal(disallowedRes.headers.get("access-control-allow-origin"), null);
});
