// Section 7: CORS - only Origins listed in allowedOrigins are allowed (no implicit *)

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp } from "./helpers/test-app.js";
import { MemoryStore } from "../src/store.js";

const CORS_RESPONSE_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
] as const;

test("cors: empty allowedOrigins emits no CORS headers at all", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const { app } = buildApp(buildTestConfig(upstream.baseUrl, { cors: { allowedOrigins: [] } }));

  const res = await app.fetch(
    new Request("http://localhost/healthz", { headers: { Origin: "https://example.com" } }),
  );
  for (const header of CORS_RESPONSE_HEADERS) assert.equal(res.headers.get(header), null);

  const preflight = await app.fetch(
    new Request("http://localhost/healthz", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "GET" },
    }),
  );
  assert.equal(preflight.status, 404);
  for (const header of CORS_RESPONSE_HEADERS) assert.equal(preflight.headers.get(header), null);
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
  assert.equal(allowedRes.headers.get("access-control-expose-headers"), "Retry-After");

  const disallowedRes = await app.fetch(
    new Request("http://localhost/healthz", { headers: { Origin: "https://not-allowed.example.com" } }),
  );
  assert.equal(disallowedRes.headers.get("access-control-allow-origin"), null);
});

test("cors: preflight cannot turn an unknown route into a 204", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const origin = "https://allowed.example.com";
  const { app } = buildApp(buildTestConfig(upstream.baseUrl, { cors: { allowedOrigins: [origin] } }));

  const res = await app.fetch(
    new Request("http://localhost/not-a-route", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    }),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { type: string } }).error.type, "not_found_error");
  for (const header of CORS_RESPONSE_HEADERS) assert.equal(res.headers.get(header), null);
});

test("cors: preflight cannot bypass a fail-closed storage gate", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const origin = "https://allowed.example.com";
  class UnhealthyStore extends MemoryStore {
    override isHealthy(): boolean {
      return false;
    }
  }
  const { app } = buildApp(
    buildTestConfig(upstream.baseUrl, { cors: { allowedOrigins: [origin] } }),
    new UnhealthyStore(),
  );

  const res = await app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    }),
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { error: { type: string } }).error.type, "storage_unavailable_error");
});
