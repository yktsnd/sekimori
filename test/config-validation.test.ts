// Validation rules in config.ts (section 2): violations fail startup (fail-closed)

import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, validateConfig } from "../src/config.js";

const ORIGINAL_TEST_KEY_ENV = process.env.TEST_KEY_ENV;
const ORIGINAL_ADMIN_KEY = process.env.SEKIMORI_ADMIN_KEY;

function resetEnv(): void {
  if (ORIGINAL_TEST_KEY_ENV === undefined) delete process.env.TEST_KEY_ENV;
  else process.env.TEST_KEY_ENV = ORIGINAL_TEST_KEY_ENV;
  if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.SEKIMORI_ADMIN_KEY;
  else process.env.SEKIMORI_ADMIN_KEY = ORIGINAL_ADMIN_KEY;
}

function baseConfig(): Record<string, unknown> {
  return {
    port: 8787,
    upstream: { baseUrl: "http://localhost:9999", apiKeyEnv: "TEST_KEY_ENV" },
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 1 } },
    budget: { monthlyUsd: 30, defaultDailyPerTokenUsd: 0.5 },
    rateLimit: { requestsPerMinute: 10 },
    pinnedSystemPrompt: null,
    cors: { allowedOrigins: [] },
    logging: { logBodies: false },
    store: { type: "memory", path: "" },
  };
}

test("config: valid config with env vars set passes validation", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test";
  const config = validateConfig(baseConfig());
  assert.equal(config.upstream.baseUrl, "http://localhost:9999");
});

test("config: empty models is rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test";
  const cfg = baseConfig();
  cfg.models = {};
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test("config: non-positive price is rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test";
  const cfg = baseConfig();
  cfg.models = { "test-model": { inputPerMTok: 0, outputPerMTok: 1 } };
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test("config: missing apiKeyEnv environment variable is rejected", (t) => {
  t.after(resetEnv);
  delete process.env.TEST_KEY_ENV;
  process.env.SEKIMORI_ADMIN_KEY = "admin-test";
  assert.throws(() => validateConfig(baseConfig()), ConfigError);
});

test("config: missing SEKIMORI_ADMIN_KEY is rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  delete process.env.SEKIMORI_ADMIN_KEY;
  assert.throws(() => validateConfig(baseConfig()), ConfigError);
});
