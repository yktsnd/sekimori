// Design doc 8-8: admin - token issue -> use -> revoke -> 401 lifecycle

import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, messagesRequest } from "./helpers/test-app.js";

test("admin: token issue -> use -> revoke -> 401 lifecycle", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 5, outputTokens: 5 }));
  t.after(() => upstream.close());
  const { app, adminKey } = buildApp(buildTestConfig(upstream.baseUrl));

  // wrong admin key is rejected
  const badAuthRes = await app.fetch(
    new Request("http://localhost/admin/tokens", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-key", "content-type": "application/json" },
      body: JSON.stringify({ name: "friend" }),
    }),
  );
  assert.equal(badAuthRes.status, 401);

  // issue
  const issueRes = await app.fetch(
    new Request("http://localhost/admin/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "friend", dailyUsd: 2 }),
    }),
  );
  assert.equal(issueRes.status, 201);
  const issued = (await issueRes.json()) as { id: string; token: string };
  assert.ok(issued.id);
  assert.ok(issued.token.startsWith("smk_"));

  // list: plaintext token and hash must not leak
  const listRes = await app.fetch(new Request("http://localhost/admin/tokens", { headers: { Authorization: `Bearer ${adminKey}` } }));
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as { tokens: Array<Record<string, unknown>> };
  const listed = listJson.tokens.find((t) => t.id === issued.id);
  assert.ok(listed);
  assert.equal(listed?.name, "friend");
  assert.equal(listed?.dailyUsd, 2);
  assert.equal("token" in (listed ?? {}), false);
  assert.equal("tokenHash" in (listed ?? {}), false);

  // use: the invite token works against /v1/messages
  const useRes = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(useRes.status, 200);

  // revoke
  const revokeRes = await app.fetch(
    new Request(`http://localhost/admin/tokens/${issued.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${adminKey}` } }),
  );
  assert.equal(revokeRes.status, 200);
  const revokeJson = (await revokeRes.json()) as { id: string; revokedAt?: string };
  assert.equal(revokeJson.id, issued.id);
  assert.ok(revokeJson.revokedAt);

  // revoking an unknown id is a 404, not silently ok
  const revokeMissingRes = await app.fetch(
    new Request("http://localhost/admin/tokens/does-not-exist", { method: "DELETE", headers: { Authorization: `Bearer ${adminKey}` } }),
  );
  assert.equal(revokeMissingRes.status, 404);

  // list reflects revocation (record kept, not physically deleted)
  const listAfterRes = await app.fetch(new Request("http://localhost/admin/tokens", { headers: { Authorization: `Bearer ${adminKey}` } }));
  const listAfterJson = (await listAfterRes.json()) as { tokens: Array<Record<string, unknown>> };
  const listedAfter = listAfterJson.tokens.find((t) => t.id === issued.id);
  assert.ok(listedAfter?.revokedAt);

  // 401 after revoke
  const afterRevokeRes = await app.fetch(
    messagesRequest(issued.token, { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  );
  assert.equal(afterRevokeRes.status, 401);
});
