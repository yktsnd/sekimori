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
