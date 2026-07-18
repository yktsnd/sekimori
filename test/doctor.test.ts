// doctor.test.ts - `sekimori doctor` non-interactive installation self-check (issue #14).
//
// Offline, no API key required, no network calls. Covers the doctor module
// functions directly, plus a real CLI spawn (`tsx src/main.ts doctor ...
// --json`) for the process-boundary behavior an agent actually depends on:
// exit code and parsed stdout.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDoctor, runDoctorChecks, parseDoctorArgs, DOCTOR_CHECK_NAMES, DOCTOR_HELP_TEXT } from "../src/doctor.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAIN_TS = join(REPO_ROOT, "src/main.ts");

const TEST_KEY_ENV = "SEKIMORI_DOCTOR_TEST_KEY";

const ORIGINAL_TEST_KEY = process.env[TEST_KEY_ENV];
const ORIGINAL_ADMIN_KEY = process.env.SEKIMORI_ADMIN_KEY;

function resetEnv(): void {
  if (ORIGINAL_TEST_KEY === undefined) delete process.env[TEST_KEY_ENV];
  else process.env[TEST_KEY_ENV] = ORIGINAL_TEST_KEY;
  if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.SEKIMORI_ADMIN_KEY;
  else process.env.SEKIMORI_ADMIN_KEY = ORIGINAL_ADMIN_KEY;
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseConfigObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    port: 8787,
    upstream: { baseUrl: "http://localhost:9999", apiKeyEnv: TEST_KEY_ENV },
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 5 } },
    budget: { monthlyUsd: 30, defaultDailyPerTokenUsd: 0.5 },
    rateLimit: { requestsPerMinute: 10 },
    pinnedSystemPrompt: null,
    cors: { allowedOrigins: [] },
    logging: { logBodies: false },
    store: { type: "file", path: "state.json" },
    ...overrides,
  };
}

function writeConfig(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "sekimori.config.json");
  writeFileSync(path, JSON.stringify(baseConfigObject(overrides), null, 2));
  return path;
}

function capturingOutput(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
  });
  return { stream, text: () => buf };
}

function checkNames(checks: { name: string }[]): string[] {
  return checks.map((c) => c.name);
}

// ---------------------------------------------------------------------------
// parseDoctorArgs
// ---------------------------------------------------------------------------

test("doctor: parseDoctorArgs defaults path and --json", () => {
  assert.deepEqual(parseDoctorArgs([]), { configPath: "./sekimori.config.json", json: false });
});

test("doctor: parseDoctorArgs reads a positional path and --json in any order", () => {
  assert.deepEqual(parseDoctorArgs(["--json", "custom.config.json"]), { configPath: "custom.config.json", json: true });
});

test("doctor: parseDoctorArgs rejects unknown flags", () => {
  const parsed = parseDoctorArgs(["--bogus"]);
  assert.ok("error" in parsed);
});

test("doctor: parseDoctorArgs --help wins even with other args present", () => {
  assert.deepEqual(parseDoctorArgs(["--bogus", "--help"]), { help: true });
});

// ---------------------------------------------------------------------------
// runDoctorChecks - happy path
// ---------------------------------------------------------------------------

test("doctor: happy path - all checks ok, ok:true, stable check names", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-happy-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });
  const result = runDoctorChecks(configPath);

  assert.equal(result.ok, true);
  assert.deepEqual(checkNames(result.checks), [...DOCTOR_CHECK_NAMES]);
  for (const check of result.checks) {
    assert.notEqual(check.status, "fail", `${check.name}: ${check.detail}`);
  }
  // JSON round-trips cleanly (this is exactly what --json prints).
  const parsed = JSON.parse(JSON.stringify({ ok: result.ok, checks: result.checks }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checks.length, DOCTOR_CHECK_NAMES.length);
});

test("doctor: never prints env var values, only names", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-secret-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-super-secret-value-should-not-appear";
  process.env.SEKIMORI_ADMIN_KEY = "admin-super-secret-value-should-not-appear";

  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });
  const result = runDoctorChecks(configPath);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("sk-super-secret-value-should-not-appear"));
  assert.ok(!serialized.includes("admin-super-secret-value-should-not-appear"));
});

// ---------------------------------------------------------------------------
// Missing / invalid config
// ---------------------------------------------------------------------------

test("doctor: missing config file - config_file fails, dependent checks skip, exit 1", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-missing-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missingPath = join(dir, "does-not-exist.json");

  const result = runDoctorChecks(missingPath);
  assert.equal(result.ok, false);
  assert.deepEqual(checkNames(result.checks), [...DOCTOR_CHECK_NAMES]);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("config_file")?.status, "fail");
  assert.equal(byName.get("config_valid")?.status, "fail");
  assert.match(byName.get("config_valid")?.detail ?? "", /skipped/);
  for (const name of ["upstream_key_env", "admin_key_env", "store_writable", "logging"]) {
    assert.equal(byName.get(name)?.status, "fail");
    assert.match(byName.get(name)?.detail ?? "", /skipped/);
  }

  const { stream, text } = capturingOutput();
  const exitCode = runDoctor([missingPath], { output: stream });
  assert.equal(exitCode, 1);
  assert.match(text(), /FAIL\s+config_file/);
});

test("doctor: invalid config (empty models) - config_valid fails, dependents skip, exit 1", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-invalid-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = writeConfig(dir, { models: {} });

  const result = runDoctorChecks(configPath);
  assert.equal(result.ok, false);
  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("config_file")?.status, "ok");
  assert.equal(byName.get("config_valid")?.status, "fail");
  assert.match(byName.get("config_valid")?.detail ?? "", /models/);
  assert.match(byName.get("upstream_key_env")?.detail ?? "", /skipped/);

  const { stream } = capturingOutput();
  const exitCode = runDoctor([configPath], { output: stream });
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// Env var checks
// ---------------------------------------------------------------------------

test("doctor: missing upstream key env var - upstream_key_env fails, config_valid still ok", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-noenv-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  delete process.env[TEST_KEY_ENV];
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });
  const result = runDoctorChecks(configPath);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("config_valid")?.status, "ok");
  assert.equal(byName.get("upstream_key_env")?.status, "fail");
  assert.match(byName.get("upstream_key_env")?.detail ?? "", new RegExp(TEST_KEY_ENV));
  assert.equal(result.ok, false);
});

test("doctor: missing admin key env var - admin_key_env fails", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-noadmin-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  delete process.env.SEKIMORI_ADMIN_KEY;

  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });
  const result = runDoctorChecks(configPath);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("admin_key_env")?.status, "fail");
  assert.match(byName.get("admin_key_env")?.detail ?? "", /SEKIMORI_ADMIN_KEY/);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// store_writable / logging - warn cases (still ok:true)
// ---------------------------------------------------------------------------

test("doctor: memory store - store_writable warns, ok stays true, exit 0", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-memory-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir, { store: { type: "memory", path: "" } });
  const result = runDoctorChecks(configPath);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("store_writable")?.status, "warn");
  assert.match(byName.get("store_writable")?.detail ?? "", /resets on every restart/);
  assert.equal(result.ok, true);

  const { stream } = capturingOutput();
  const exitCode = runDoctor([configPath], { output: stream });
  assert.equal(exitCode, 0);
});

test("doctor: logBodies true - logging warns, ok stays true", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-logbodies-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir, {
    logging: { logBodies: true },
    store: { type: "file", path: join(dir, "state.json") },
  });
  const result = runDoctorChecks(configPath);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("logging")?.status, "warn");
  assert.match(byName.get("logging")?.detail ?? "", /will be logged/);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// store_writable - unwritable directory (fail)
// ---------------------------------------------------------------------------

test("doctor: file store with unwritable directory - store_writable fails, exit 1", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-bit test is not reliable on Windows or as root");
    return;
  }
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-unwritable-");
  const readonlyDir = join(dir, "readonly");
  mkdirSync(readonlyDir);
  t.after(() => {
    chmodSync(readonlyDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  chmodSync(readonlyDir, 0o555); // r-x r-x r-x: no write permission

  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir, { store: { type: "file", path: join(readonlyDir, "state.json") } });
  const result = runDoctorChecks(configPath);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("store_writable")?.status, "fail");
  assert.equal(result.ok, false);

  const { stream } = capturingOutput();
  const exitCode = runDoctor([configPath], { output: stream });
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// store_writable - existing state file must never be touched by the probe
// ---------------------------------------------------------------------------

test("doctor: probing an existing state file never modifies its content", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-existing-state-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const statePath = join(dir, "state.json");
  const originalContent = JSON.stringify({
    tokens: [{ id: "keep-me", tokenHash: "c".repeat(64), dailyUsd: 1, createdAt: "2026-01-01T00:00:00.000Z" }],
    usage: {},
    reservations: {},
  });
  writeFileSync(statePath, originalContent);

  const configPath = writeConfig(dir, { store: { type: "file", path: statePath } });
  const result = runDoctorChecks(configPath);

  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("store_writable")?.status, "ok");
  assert.equal(readFileSync(statePath, "utf8"), originalContent, "doctor must never modify the real state file");
  // No temporary probe directory should have been left behind next to it either.
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".sekimori-doctor-")), []);
});

test("doctor: malformed existing state fails without modifying it", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-invalid-state-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const statePath = join(dir, "state.json");
  const originalContent = "{ not valid JSON";
  writeFileSync(statePath, originalContent);
  const configPath = writeConfig(dir, { store: { type: "file", path: statePath } });

  const result = runDoctorChecks(configPath);
  const byName = new Map(result.checks.map((c) => [c.name, c]));
  assert.equal(byName.get("store_writable")?.status, "fail");
  assert.equal(readFileSync(statePath, "utf8"), originalContent);
});

test("doctor: a missing state file is never created and leaves no probe artifacts", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-missing-state-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const statePath = join(dir, "state.json");
  const configPath = writeConfig(dir, { store: { type: "file", path: statePath } });
  const result = runDoctorChecks(configPath);
  const byName = new Map(result.checks.map((c) => [c.name, c]));

  assert.equal(byName.get("store_writable")?.status, "ok");
  assert.equal(existsSync(statePath), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".sekimori-doctor-")), []);
});

test("doctor: a relative store path is checked relative to the config file", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-relative-state-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir); // store.path is the relative "state.json"
  const result = runDoctorChecks(configPath);
  const storeCheck = result.checks.find((check) => check.name === "store_writable");

  assert.equal(storeCheck?.status, "ok");
  assert.match(storeCheck?.detail ?? "", new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(existsSync(join(dir, "state.json")), false, "doctor must not create the relative state file");
});

test("doctor: a directory at the configured state-file path fails the self-check", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-state-dir-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const statePath = join(dir, "state.json");
  mkdirSync(statePath);
  const configPath = writeConfig(dir, { store: { type: "file", path: statePath } });
  const result = runDoctorChecks(configPath);
  const byName = new Map(result.checks.map((c) => [c.name, c]));

  assert.equal(byName.get("store_writable")?.status, "fail");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Human-mode output: Protection summary only appears when ok
// ---------------------------------------------------------------------------

test("doctor: human output includes a Protection summary only when ok", (t) => {
  t.after(resetEnv);
  const dir = tmpDir("sekimori-doctor-summary-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env[TEST_KEY_ENV] = "sk-test-value";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-value-32-bytes-minimum-0001";

  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });
  const { stream, text } = capturingOutput();
  const exitCode = runDoctor([configPath], { output: stream });
  assert.equal(exitCode, 0);
  assert.match(text(), /Protection summary/);
  assert.match(text(), /Allowed models: test-model/);
  assert.match(text(), /Monthly spending cap: \$30/);

  delete process.env[TEST_KEY_ENV];
  const { stream: stream2, text: text2 } = capturingOutput();
  const exitCode2 = runDoctor([configPath], { output: stream2 });
  assert.equal(exitCode2, 1);
  assert.ok(!text2().includes("Protection summary"));
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

test("doctor: --help prints usage and exits 0", () => {
  const { stream, text } = capturingOutput();
  const exitCode = runDoctor(["--help"], { output: stream });
  assert.equal(exitCode, 0);
  assert.equal(text(), DOCTOR_HELP_TEXT);
});

// ---------------------------------------------------------------------------
// Real CLI spawn (issue #14 acceptance: agents run `tsx src/main.ts doctor
// ... --json` and parse stdout).
// ---------------------------------------------------------------------------

test("doctor: real CLI, env vars set - exit 0, --json prints ok:true and every check name", (t) => {
  const dir = tmpDir("sekimori-doctor-cli-happy-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });

  const res = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "doctor", configPath, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      [TEST_KEY_ENV]: "sk-test-value",
      SEKIMORI_ADMIN_KEY: "admin-test-value-32-bytes-minimum-0001",
    },
  });

  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(checkNames(parsed.checks), [...DOCTOR_CHECK_NAMES]);
});

test("doctor: real CLI, env vars unset - exit 1, --json prints ok:false with env checks failing", (t) => {
  const dir = tmpDir("sekimori-doctor-cli-noenv-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = writeConfig(dir, { store: { type: "file", path: join(dir, "state.json") } });

  const env = { ...process.env };
  delete env[TEST_KEY_ENV];
  delete env.SEKIMORI_ADMIN_KEY;

  const res = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "doctor", configPath, "--json"], { encoding: "utf8", env });

  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout) as { ok: boolean; checks: { name: string; status: string; detail: string }[] };
  assert.equal(parsed.ok, false);
  const byName = new Map(parsed.checks.map((c) => [c.name, c] as const));
  assert.equal(byName.get("upstream_key_env")?.status, "fail");
  assert.equal(byName.get("admin_key_env")?.status, "fail");
});
