// §8-1: 認証 — トークンなし/不正/失効 → 401

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";

test("auth: missing bearer token returns 401", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());
  const { app } = buildApp(buildTestConfig(upstream.baseUrl));

  const res = await app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", max_tokens: 10, messages: [] }),
    }),
  );
  assert.equal(res.status, 401);
  const json = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "authentication_error");
});

test("auth: unknown token returns 401", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());
  const { app } = buildApp(buildTestConfig(upstream.baseUrl));

  const res = await app.fetch(messagesRequest("smk_totally-bogus-token", { model: "test-model", max_tokens: 10, messages: [] }));
  assert.equal(res.status, 401);
});

test("auth: revoked token returns 401 after previously succeeding", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());
  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));

  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });
  const body = { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  const okRes = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(okRes.status, 200);

  const revokeRes = await app.fetch(
    new Request(`http://localhost/admin/tokens/${issued.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminKey}` },
    }),
  );
  assert.equal(revokeRes.status, 200);

  const afterRevokeRes = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(afterRevokeRes.status, 401);
});
