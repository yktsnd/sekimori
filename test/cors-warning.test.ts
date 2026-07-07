// A-5: a request from a disallowed Origin emits a one-line warning on server
// stdout. The blocking itself (no CORS headers) is covered by cors.test.ts,
// so this only checks for the warning log.

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp } from "./helpers/test-app.js";

test("cors warning: disallowed Origin triggers a one-line stdout warning, allowed Origin does not", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 1, outputTokens: 1 }));
  t.after(() => upstream.close());
  const { app } = buildApp(
    buildTestConfig(upstream.baseUrl, { cors: { allowedOrigins: ["https://allowed.example.com"] } }),
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  await app.fetch(new Request("http://localhost/healthz", { headers: { Origin: "https://not-allowed.example.com" } }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /blocked origin: https:\/\/not-allowed\.example\.com/);

  warnings.length = 0;
  await app.fetch(new Request("http://localhost/healthz", { headers: { Origin: "https://allowed.example.com" } }));
  assert.equal(warnings.length, 0, "allowed origin must not trigger a warning");

  warnings.length = 0;
  await app.fetch(new Request("http://localhost/healthz"));
  assert.equal(warnings.length, 0, "no Origin header must not trigger a warning");
});
