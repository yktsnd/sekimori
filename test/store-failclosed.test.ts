// Design doc 8-6: fail-closed - inject a FileStore write failure -> 503 from then on

import test from "node:test";
import assert from "node:assert/strict";
import { FileStore, type FileStoreFS } from "../src/store.js";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";

/** FileStoreFS that avoids the real disk and can inject failures. DI so tests don't depend on root/permissions. */
function makeControllableFs(): { fs: FileStoreFS; setShouldFail(v: boolean): void } {
  const files = new Map<string, string>();
  let shouldFail = false;
  const fs: FileStoreFS = {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    },
    async writeFile(path, data) {
      if (shouldFail) throw new Error("simulated disk write failure");
      files.set(path, data);
    },
    async mkdir() {
      // no-op: virtual filesystem, no directories to create
    },
  };
  return { fs, setShouldFail: (v: boolean) => (shouldFail = v) };
}

test("fail-closed: once FileStore write fails, all subsequent requests are 503 (process keeps running)", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());

  const { fs, setShouldFail } = makeControllableFs();
  const store = new FileStore("/virtual/state.json", fs);
  await store.init();
  assert.equal(store.isHealthy(), true);

  const config = buildTestConfig(upstream.baseUrl, { store: { type: "file", path: "/virtual/state.json" } });
  const { app, adminKey } = buildApp(config, store);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const body = { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  // works fine while the disk is healthy
  const res1 = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(res1.status, 200);
  assert.equal(store.isHealthy(), true);

  // inject a write failure (accounting write for this very call fails)
  setShouldFail(true);
  const res2 = await app.fetch(messagesRequest(issued.token, body));
  // the upstream call itself already succeeded; sekimori still returns it to the client,
  // but the store is now marked unhealthy because it could not persist the usage record.
  assert.equal(res2.status, 200);
  assert.equal(store.isHealthy(), false);

  // subsequent requests are blocked with 503, without even reaching the upstream/budget logic
  const res3 = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(res3.status, 503);
  const json3 = (await res3.json()) as { error: { type: string; message: string } };
  assert.equal(json3.error.type, "storage_unavailable_error");

  const usageRes = await app.fetch(new Request("http://localhost/v1/usage", { headers: { Authorization: `Bearer ${issued.token}` } }));
  assert.equal(usageRes.status, 503);

  const adminRes = await app.fetch(
    new Request("http://localhost/admin/usage", { headers: { Authorization: `Bearer ${adminKey}` } }),
  );
  assert.equal(adminRes.status, 503);

  // /healthz keeps responding even in the degraded state, since it doesn't depend on the store.
  const healthRes = await app.fetch(new Request("http://localhost/healthz"));
  assert.equal(healthRes.status, 200);
});
