// Design doc 8-9: pinnedSystemPrompt actually replaces system in the upstream request

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, capturingJsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";

test("pinnedSystemPrompt: client-supplied system is forcibly replaced before forwarding upstream", async (t) => {
  const capture: { body?: Record<string, unknown> } = {};
  const upstream = await startMockUpstream(capturingJsonMessagesHandler(capture, { inputTokens: 5, outputTokens: 5 }));
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, { pinnedSystemPrompt: "PINNED SYSTEM PROMPT" });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 10,
      system: "client tries to override the system prompt",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(capture.body?.system, "PINNED SYSTEM PROMPT");
});

test("pinnedSystemPrompt: null (default) leaves client-supplied system untouched", async (t) => {
  const capture: { body?: Record<string, unknown> } = {};
  const upstream = await startMockUpstream(capturingJsonMessagesHandler(capture, { inputTokens: 5, outputTokens: 5 }));
  t.after(() => upstream.close());

  const config = buildTestConfig(upstream.baseUrl, { pinnedSystemPrompt: null });
  const { app, adminKey } = buildApp(config);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const res = await app.fetch(
    messagesRequest(issued.token, {
      model: "test-model",
      max_tokens: 10,
      system: "client's own system prompt",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(capture.body?.system, "client's own system prompt");
});
