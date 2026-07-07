// Design doc 8-2: allow list - unknown model -> 403 (doubles as proof that unpriced models can't pass)

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";

test("model allowlist: unknown/unpriced model returns 403", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());
  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "claude-not-in-config",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 403);
  const json = (await res.json()) as { error: { type: string; message: string } };
  assert.equal(json.error.type, "permission_error");
});

test("model allowlist: prototype-polluting model names are rejected too", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());
  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  for (const badModel of ["toString", "constructor", "hasOwnProperty"]) {
    const res = await app.fetch(
      messagesRequest(issued.token, { model: badModel, max_tokens: 10, messages: [] }),
    );
    assert.equal(res.status, 403, `expected 403 for model=${badModel}`);
  }
});

test("model allowlist: allowed model passes through to upstream", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());
  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(res.status, 200);
});
