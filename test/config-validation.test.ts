// Validation rules in config.ts (section 2): violations fail startup (fail-closed)

import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, validateConfig } from "../src/config.js";

const ORIGINAL_TEST_KEY_ENV = process.env.TEST_KEY_ENV;
const ORIGINAL_ADMIN_KEY = process.env.SEKIMORI_ADMIN_KEY;
const TEST_ADMIN_KEY = "admin-test-key-32-bytes-minimum-0001";

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
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const config = validateConfig(baseConfig());
  assert.equal(config.upstream.baseUrl, "http://localhost:9999");
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.upstream.timeoutMs, 120_000);
});

test("config: empty models is rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  cfg.models = {};
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test("config: non-positive price is rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  cfg.models = { "test-model": { inputPerMTok: 0, outputPerMTok: 1 } };
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test("config: missing apiKeyEnv environment variable is rejected", (t) => {
  t.after(resetEnv);
  delete process.env.TEST_KEY_ENV;
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  assert.throws(() => validateConfig(baseConfig()), ConfigError);
});

test("config: missing SEKIMORI_ADMIN_KEY is rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  delete process.env.SEKIMORI_ADMIN_KEY;
  assert.throws(() => validateConfig(baseConfig()), ConfigError);
});

test("config: SEKIMORI_ADMIN_KEY must have at least 32 visible ASCII characters", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";

  process.env.SEKIMORI_ADMIN_KEY = "too-short";
  assert.throws(() => validateConfig(baseConfig()), /at least 32 visible ASCII/);

  process.env.SEKIMORI_ADMIN_KEY = ` ${TEST_ADMIN_KEY} `;
  assert.throws(() => validateConfig(baseConfig()), /visible ASCII/);

  process.env.SEKIMORI_ADMIN_KEY = "関".repeat(16);
  assert.throws(() => validateConfig(baseConfig()), /visible ASCII/);

  process.env.SEKIMORI_ADMIN_KEY = `${TEST_ADMIN_KEY.slice(0, 10)}\n${TEST_ADMIN_KEY.slice(10)}`;
  assert.throws(() => validateConfig(baseConfig()), /visible ASCII/);

  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  process.env.TEST_KEY_ENV = "upstream\nkey";
  assert.throws(() => validateConfig(baseConfig()), /visible ASCII/);
});

test("config: malformed pinned system prompt fails closed instead of silently disabling pinning", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  cfg.pinnedSystemPrompt = { not: "a string" };
  assert.throws(() => validateConfig(cfg), ConfigError);
});

test("config: unknown keys fail closed so security-setting typos cannot be ignored", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;

  const topLevelTypo = baseConfig();
  topLevelTypo.pinnedSystemPromt = "must not be silently ignored";
  assert.throws(() => validateConfig(topLevelTypo), /unknown key.*pinnedSystemPromt/);

  const nestedTypo = baseConfig();
  nestedTypo.budget = { monthlyUsd: 30, defaultDailyPerTokenUSd: 0.5 };
  assert.throws(() => validateConfig(nestedTypo), /unknown key.*defaultDailyPerTokenUSd/);

  const priceTypo = baseConfig();
  priceTypo.models = { "test-model": { inputPerMTok: 1, outputPerMToken: 1 } };
  assert.throws(() => validateConfig(priceTypo), /unknown key.*outputPerMToken/);
});

test("config: provider and admin credentials must use separate variables and values", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "same-secret-value-32-bytes-minimum-0001";
  process.env.SEKIMORI_ADMIN_KEY = "same-secret-value-32-bytes-minimum-0001";

  assert.throws(() => validateConfig(baseConfig()), /must have different values/);

  const sharedVariable = baseConfig();
  sharedVariable.upstream = { baseUrl: "https://upstream.example", apiKeyEnv: "SEKIMORI_ADMIN_KEY" };
  assert.throws(() => validateConfig(sharedVariable), /must not be SEKIMORI_ADMIN_KEY/);
});

test("config: non-finite prices and budgets are rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;

  const infinitePrice = baseConfig();
  infinitePrice.models = { "test-model": { inputPerMTok: Infinity, outputPerMTok: 1 } };
  assert.throws(() => validateConfig(infinitePrice), ConfigError);

  const infiniteBudget = baseConfig();
  infiniteBudget.budget = { monthlyUsd: Infinity, defaultDailyPerTokenUsd: 1 };
  assert.throws(() => validateConfig(infiniteBudget), ConfigError);

  const unsafeMagnitude = baseConfig();
  unsafeMagnitude.budget = { monthlyUsd: 1_000_000_001, defaultDailyPerTokenUsd: 1 };
  assert.throws(() => validateConfig(unsafeMagnitude), /no greater than 1000000000/);
});

test("config: port, rate limit, CORS, upstream URL, and environment variable names use strict fail-closed validation", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;

  const invalidPort = baseConfig();
  invalidPort.port = 0;
  assert.throws(() => validateConfig(invalidPort), ConfigError);

  const invalidRate = baseConfig();
  invalidRate.rateLimit = { requestsPerMinute: 1.5 };
  assert.throws(() => validateConfig(invalidRate), ConfigError);

  const excessiveRate = baseConfig();
  excessiveRate.rateLimit = { requestsPerMinute: 10_001 };
  assert.throws(() => validateConfig(excessiveRate), /1 through 10000/);

  const wildcardCors = baseConfig();
  wildcardCors.cors = { allowedOrigins: ["*"] };
  assert.throws(() => validateConfig(wildcardCors), ConfigError);

  const unsafeUpstream = baseConfig();
  unsafeUpstream.upstream = { baseUrl: "https://user:pass@upstream.example?key=x", apiKeyEnv: "TEST_KEY_ENV" };
  assert.throws(() => validateConfig(unsafeUpstream), ConfigError);

  const invalidEnvName = baseConfig();
  invalidEnvName.upstream = { baseUrl: "https://upstream.example", apiKeyEnv: "NOT A VALID ENV NAME" };
  assert.throws(() => validateConfig(invalidEnvName), ConfigError);

  const unsafeListenHost = baseConfig();
  unsafeListenHost.listenHost = "gateway.example";
  assert.throws(() => validateConfig(unsafeListenHost), ConfigError);

  const invalidTimeout = baseConfig();
  invalidTimeout.upstream = { baseUrl: "https://upstream.example", apiKeyEnv: "TEST_KEY_ENV", timeoutMs: 999 };
  assert.throws(() => validateConfig(invalidTimeout), ConfigError);
});

test("config: public HTTP upstream and CORS origins are rejected", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;

  const publicHttpUpstream = baseConfig();
  publicHttpUpstream.upstream = { baseUrl: "http://upstream.example", apiKeyEnv: "TEST_KEY_ENV" };
  assert.throws(() => validateConfig(publicHttpUpstream), /must use https/);

  const publicHttpCors = baseConfig();
  publicHttpCors.cors = { allowedOrigins: ["http://app.example"] };
  assert.throws(() => validateConfig(publicHttpCors), /must use https/);
});

test("config: HTTP remains available for exact loopback upstreams and CORS origins", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;

  for (const origin of ["http://localhost:3000", "http://127.0.0.42:3000", "http://[::1]:3000"]) {
    const cfg = baseConfig();
    cfg.upstream = { baseUrl: origin, apiKeyEnv: "TEST_KEY_ENV" };
    cfg.cors = { allowedOrigins: [origin] };
    const validated = validateConfig(cfg);
    assert.equal(validated.upstream.baseUrl, origin);
    assert.deepEqual(validated.cors.allowedOrigins, [origin]);
  }
});

test("config: explicit network listen hosts and bounded upstream timeout are accepted", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  cfg.listenHost = "0.0.0.0";
  cfg.upstream = { baseUrl: "https://upstream.example", apiKeyEnv: "TEST_KEY_ENV", timeoutMs: 5_000 };
  const config = validateConfig(cfg);
  assert.equal(config.listenHost, "0.0.0.0");
  assert.equal(config.upstream.timeoutMs, 5_000);
});

test("config: upstream URLs are canonicalized before request paths are appended", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  cfg.upstream = { baseUrl: "http://localhost:9999/api/", apiKeyEnv: "TEST_KEY_ENV" };
  assert.equal(validateConfig(cfg).upstream.baseUrl, "http://localhost:9999/api");
});

// ---------------------------------------------------------------------------
// upstream.type (issue #17: Amazon Bedrock upstream)
// ---------------------------------------------------------------------------

test("config: upstream.type omitted defaults to \"anthropic\"", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const config = validateConfig(baseConfig());
  assert.equal(config.upstream.type, "anthropic");
});

test("config: upstream.type \"anthropic\" is accepted", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  (cfg.upstream as Record<string, unknown>).type = "anthropic";
  const config = validateConfig(cfg);
  assert.equal(config.upstream.type, "anthropic");
});

test("config: upstream.type \"bedrock\" is accepted", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  (cfg.upstream as Record<string, unknown>).type = "bedrock";
  const config = validateConfig(cfg);
  assert.equal(config.upstream.type, "bedrock");
});

test("config: an unknown upstream.type value fails closed with ConfigError", (t) => {
  t.after(resetEnv);
  process.env.TEST_KEY_ENV = "sk-test";
  process.env.SEKIMORI_ADMIN_KEY = TEST_ADMIN_KEY;
  const cfg = baseConfig();
  (cfg.upstream as Record<string, unknown>).type = "openai";
  assert.throws(() => validateConfig(cfg), ConfigError);
});
