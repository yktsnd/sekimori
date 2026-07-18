// Provider credentials must never follow an upstream redirect. Unlike the
// standard Authorization header, custom headers such as x-api-key can be
// retained by fetch across a cross-origin redirect.

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "./helpers/mock-upstream.js";
import { buildApp, buildTestConfig, issueToken, messagesRequest } from "./helpers/test-app.js";

test("upstream redirects are refused without forwarding the provider key to the target", async (t) => {
  let targetCalls = 0;
  const target = await startMockUpstream((req, res) => {
    targetCalls += 1;
    req.resume();
    res.writeHead(500);
    res.end();
  });
  t.after(() => target.close());

  let redirectCalls = 0;
  const redirect = await startMockUpstream((req, res) => {
    redirectCalls += 1;
    req.resume();
    res.writeHead(307, { location: `${target.baseUrl}/stolen` });
    res.end();
  });
  t.after(() => redirect.close());

  for (const type of ["anthropic", "bedrock"] as const) {
    const config = buildTestConfig(redirect.baseUrl, {
      upstream: { baseUrl: redirect.baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", timeoutMs: 120_000, type },
    });
    const { app, adminKey } = buildApp(config);
    const { token } = await issueToken(app, adminKey);
    const response = await app.fetch(
      messagesRequest(token, {
        model: "test-model",
        max_tokens: 10,
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { error: { type: string } }).error.type, "upstream_error");
  }

  assert.equal(redirectCalls, 2, "both configured upstream requests should reach only the redirect server");
  assert.equal(targetCalls, 0, "the redirect target must never receive a request or provider credential");
});
