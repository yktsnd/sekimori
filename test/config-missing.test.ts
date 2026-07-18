// A-2: when the config file is missing, the ConfigError must point at how to
// copy the example and the relevant README section (not a bare I/O error).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfigFromFile } from "../src/config.js";

test("config: missing file produces a friendly, actionable ConfigError", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sekimori-config-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missingPath = join(dir, "sekimori.config.json");

  assert.throws(
    () => loadConfigFromFile(missingPath),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, "must throw ConfigError, not a raw fs error");
      assert.match((err as Error).message, /sekimori\.config\.example\.json/, "must point to the example config");
      assert.match((err as Error).message, /README/, "must point to the README quickstart");
      assert.match((err as Error).message, new RegExp(missingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    },
  );
});

test("config: JSON parse error keeps the plain (non-ENOENT) message form", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sekimori-config-invalid-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const badPath = join(dir, "sekimori.config.json");
  writeFileSync(badPath, "{ not valid json");

  assert.throws(() => loadConfigFromFile(badPath), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match((err as Error).message, /invalid JSON/);
    return true;
  });
});

test("config: a relative file-store path is resolved from the config file directory", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sekimori-config-relative-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldUpstreamKey = process.env.SEKIMORI_RELATIVE_STORE_TEST_KEY;
  const oldAdminKey = process.env.SEKIMORI_ADMIN_KEY;
  t.after(() => {
    if (oldUpstreamKey === undefined) delete process.env.SEKIMORI_RELATIVE_STORE_TEST_KEY;
    else process.env.SEKIMORI_RELATIVE_STORE_TEST_KEY = oldUpstreamKey;
    if (oldAdminKey === undefined) delete process.env.SEKIMORI_ADMIN_KEY;
    else process.env.SEKIMORI_ADMIN_KEY = oldAdminKey;
  });
  process.env.SEKIMORI_RELATIVE_STORE_TEST_KEY = "upstream-test-key";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-key-32-bytes-minimum-0001";

  const configPath = join(dir, "sekimori.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      upstream: { baseUrl: "http://localhost:9999", apiKeyEnv: "SEKIMORI_RELATIVE_STORE_TEST_KEY" },
      models: { "test-model": { inputPerMTok: 1, outputPerMTok: 5 } },
      budget: { monthlyUsd: 30 },
      store: { type: "file", path: "state/budget.json" },
    }),
  );

  assert.equal(loadConfigFromFile(configPath).store.path, join(dir, "state", "budget.json"));
});
