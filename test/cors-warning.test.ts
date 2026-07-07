// A-5: 許可されていない Origin からのリクエストを受けた際、サーバー stdout に 1 行警告を出す。
// 遮断そのもの（CORS ヘッダを出さないこと）は cors.test.ts で確認済みなので、ここでは
// 警告ログの有無だけを見る。

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
