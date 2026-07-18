// init.test.ts - `sekimori init` interactive config generator (issue #7).
//
// Offline, no API key required. Covers the init module functions directly
// (fast, easy to assert on) plus real CLI spawns via `tsx src/main.ts init`
// for the two behaviors that only make sense as an actual process boundary:
// non-TTY-without---yes must exit non-zero without hanging, and the real
// entry point must produce a file identical in shape to what the direct
// calls produce.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInit, parseInitArgs, parseModelSpec, INIT_HELP_TEXT, type InitIO } from "../src/init.js";
import { validateConfig } from "../src/config.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAIN_TS = join(REPO_ROOT, "src/main.ts");
// Windows process startup can be slow under antivirus while node:test runs
// multiple files concurrently. Keep real-CLI checks bounded without turning a
// busy but healthy CI runner into a false failure.
const REAL_CLI_TIMEOUT_MS = 60_000;

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function silentIO(overrides: Partial<InitIO> = {}): InitIO {
  return {
    input: new PassThrough(),
    output: new PassThrough(), // drained implicitly; nothing asserts on it unless captured below
    isTTY: false,
    ...overrides,
  };
}

/** Captures everything written to an output stream into a string. */
function capturingOutput(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
  });
  return { stream, text: () => buf };
}

const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_ADMIN_KEY = process.env.SEKIMORI_ADMIN_KEY;

function resetRealEnv(): void {
  if (ORIGINAL_ANTHROPIC_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_KEY;
  if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.SEKIMORI_ADMIN_KEY;
  else process.env.SEKIMORI_ADMIN_KEY = ORIGINAL_ADMIN_KEY;
}

// ---------------------------------------------------------------------------
// parseInitArgs
// ---------------------------------------------------------------------------

test("init: parseInitArgs defaults path, force, yes", () => {
  const parsed = parseInitArgs([]);
  assert.deepEqual(parsed, { path: "./sekimori.config.json", force: false, yes: false, overrides: {} });
});

test("init: parseInitArgs reads a positional path and flags in any order", () => {
  const parsed = parseInitArgs(["--force", "custom.config.json", "--yes"]);
  assert.deepEqual(parsed, { path: "custom.config.json", force: true, yes: true, overrides: {} });
});

test("init: parseInitArgs rejects unknown flags", () => {
  const parsed = parseInitArgs(["--bogus"]);
  assert.ok("error" in parsed);
});

// ---------------------------------------------------------------------------
// parseModelSpec
// ---------------------------------------------------------------------------

test("init: parseModelSpec parses name=input,output", () => {
  const parsed = parseModelSpec("claude-haiku-4-5-20251001=1,5");
  assert.deepEqual(parsed, {
    name: "claude-haiku-4-5-20251001",
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
  });
});

test("init: parseModelSpec accepts decimal prices and trims whitespace", () => {
  const parsed = parseModelSpec("my-model = 0.25 , 1.5 ");
  assert.deepEqual(parsed, { name: "my-model", pricing: { inputPerMTok: 0.25, outputPerMTok: 1.5 } });
});

for (const bad of [
  "no-equals-sign",
  "=1,5", // empty name
  "name=1", // missing output price
  "name=1,2,3", // too many parts
  "name=abc,5", // non-numeric input price
  "name=1,-5", // non-positive output price
  "name=0,5", // zero input price
]) {
  test(`init: parseModelSpec rejects "${bad}"`, () => {
    const parsed = parseModelSpec(bad);
    assert.ok("error" in parsed, `expected an error for "${bad}"`);
  });
}

// ---------------------------------------------------------------------------
// parseInitArgs: per-setting flags (issue #13)
// ---------------------------------------------------------------------------

test("init: parseInitArgs --help short-circuits regardless of position or other errors", () => {
  assert.deepEqual(parseInitArgs(["--help"]), { help: true });
  assert.deepEqual(parseInitArgs(["-h"]), { help: true });
  assert.deepEqual(parseInitArgs(["--bogus", "--help"]), { help: true });
  assert.deepEqual(parseInitArgs(["--port", "not-a-number", "--help"]), { help: true });
});

test("init: parseInitArgs parses every per-setting flag", () => {
  const parsed = parseInitArgs([
    "--yes",
    "--port",
    "3000",
    "--listen-host",
    "0.0.0.0",
    "--upstream-url",
    "https://upstream.example.com",
    "--upstream-timeout-ms",
    "5000",
    "--model",
    "claude-haiku-4-5-20251001=1,5",
    "--monthly-usd",
    "10",
    "--daily-usd",
    "2",
    "--rate-limit",
    "42",
    "--store",
    "memory",
    "--cors-origin",
    "https://example.com",
    "--pinned-system",
    "You are a pirate.",
  ]);
  assert.ok(!("error" in parsed) && !("help" in parsed));
  if ("error" in parsed || "help" in parsed) return;
  assert.deepEqual(parsed.overrides, {
    port: 3000,
    listenHost: "0.0.0.0",
    upstreamUrl: "https://upstream.example.com",
    upstreamTimeoutMs: 5000,
    models: { "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 } },
    monthlyUsd: 10,
    dailyUsd: 2,
    rateLimit: 42,
    storeType: "memory",
    corsOrigins: ["https://example.com"],
    pinnedSystem: "You are a pirate.",
  });
});

test("init: parseInitArgs --model is repeatable and later duplicates win", () => {
  const parsed = parseInitArgs(["--model", "a=1,2", "--model", "b=3,4", "--model", "a=9,9"]);
  assert.ok(!("error" in parsed) && !("help" in parsed));
  if ("error" in parsed || "help" in parsed) return;
  assert.deepEqual(parsed.overrides.models, {
    a: { inputPerMTok: 9, outputPerMTok: 9 },
    b: { inputPerMTok: 3, outputPerMTok: 4 },
  });
});

test("init: parseInitArgs --cors-origin is repeatable and preserves order", () => {
  const parsed = parseInitArgs(["--cors-origin", "https://a.example", "--cors-origin", "https://b.example"]);
  assert.ok(!("error" in parsed) && !("help" in parsed));
  if ("error" in parsed || "help" in parsed) return;
  assert.deepEqual(parsed.overrides.corsOrigins, ["https://a.example", "https://b.example"]);
});

test("init: parseInitArgs rejects an invalid --port", () => {
  const parsed = parseInitArgs(["--port", "not-a-number"]);
  assert.ok("error" in parsed);
  const parsedZero = parseInitArgs(["--port", "0"]);
  assert.ok("error" in parsedZero);
  const parsedFloat = parseInitArgs(["--port", "80.5"]);
  assert.ok("error" in parsedFloat);
  const parsedTooBig = parseInitArgs(["--port", "70000"]);
  assert.ok("error" in parsedTooBig);
});

test("init: parseInitArgs rejects an invalid or unsafe --upstream-url", () => {
  for (const value of ["not a url", "ftp://upstream.example", "https://user:pass@upstream.example", "https://upstream.example?key=x"]) {
    assert.ok("error" in parseInitArgs(["--upstream-url", value]), value);
  }
});

// ---------------------------------------------------------------------------
// --upstream-type (issue #17: Amazon Bedrock upstream)
// ---------------------------------------------------------------------------

test("init: parseInitArgs accepts --upstream-type anthropic or bedrock", () => {
  const anthropic = parseInitArgs(["--upstream-type", "anthropic"]);
  assert.ok(!("error" in anthropic) && !("help" in anthropic));
  if ("error" in anthropic || "help" in anthropic) return;
  assert.equal(anthropic.overrides.upstreamType, "anthropic");

  const bedrock = parseInitArgs(["--upstream-type", "bedrock"]);
  assert.ok(!("error" in bedrock) && !("help" in bedrock));
  if ("error" in bedrock || "help" in bedrock) return;
  assert.equal(bedrock.overrides.upstreamType, "bedrock");
});

test("init: parseInitArgs rejects an invalid --upstream-type value", () => {
  const parsed = parseInitArgs(["--upstream-type", "openai"]);
  assert.ok("error" in parsed);
});

test("init: parseInitArgs rejects a malformed --model spec", () => {
  const parsed = parseInitArgs(["--model", "just-a-name"]);
  assert.ok("error" in parsed);
});

test("init: parseInitArgs rejects an unknown --store value", () => {
  const parsed = parseInitArgs(["--store", "s3"]);
  assert.ok("error" in parsed);
});

test("init: parseInitArgs rejects invalid numeric budget and rate-limit values", () => {
  assert.ok("error" in parseInitArgs(["--monthly-usd", "0"]));
  assert.ok("error" in parseInitArgs(["--daily-usd", "-1"]));
  assert.ok("error" in parseInitArgs(["--rate-limit", "abc"]));
  assert.ok("error" in parseInitArgs(["--rate-limit", "1.5"]));
});

test("init: parseInitArgs rejects a flag with a missing value", () => {
  const parsed = parseInitArgs(["--port"]);
  assert.ok("error" in parsed);
});

test("init: parseInitArgs rejects --store-path combined with --store memory", () => {
  const parsed = parseInitArgs(["--store", "memory", "--store-path", "./state.json"]);
  assert.ok("error" in parsed);
});

test("init: parseInitArgs accepts --store-path with --store file (or no --store flag)", () => {
  const withFile = parseInitArgs(["--store", "file", "--store-path", "./state.json"]);
  assert.ok(!("error" in withFile) && !("help" in withFile));
  const withoutStoreFlag = parseInitArgs(["--store-path", "./state.json"]);
  assert.ok(!("error" in withoutStoreFlag) && !("help" in withoutStoreFlag));
});

test("init: parseInitArgs rejects an invalid --listen-host or --upstream-timeout-ms", () => {
  for (const host of ["example.com", "http://127.0.0.1", "*"]) {
    assert.ok("error" in parseInitArgs(["--listen-host", host]), host);
  }
  for (const timeout of ["999", "900001", "1.5", "not-a-number"]) {
    assert.ok("error" in parseInitArgs(["--upstream-timeout-ms", timeout]), timeout);
  }
});

test("init: parseInitArgs rejects malformed CORS origins and an empty file-store path", () => {
  for (const origin of ["*", "https://example.com/", "ftp://example.com"]) {
    assert.ok("error" in parseInitArgs(["--cors-origin", origin]), origin);
  }
  assert.ok("error" in parseInitArgs(["--store-path", "   "]));
});

// ---------------------------------------------------------------------------
// runInit: direct calls (no child process)
// ---------------------------------------------------------------------------

test("init: --yes writes a default config that validateConfig accepts (env vars aside)", async (t) => {
  const dir = tmpDir("sekimori-init-yes-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const exitCode = await runInit([cfgPath, "--yes"], silentIO());
  assert.equal(exitCode, 0);
  assert.ok(existsSync(cfgPath));

  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.port, 8787);
  assert.equal(parsed.listenHost, "127.0.0.1");
  assert.equal(parsed.upstream.baseUrl, "https://api.anthropic.com");
  assert.equal(parsed.upstream.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(parsed.upstream.timeoutMs, 120_000);
  assert.ok(Object.keys(parsed.models).length > 0);
  assert.equal(parsed.budget.monthlyUsd, 30);
  assert.equal(parsed.budget.defaultDailyPerTokenUsd, 0.5);
  assert.equal(parsed.rateLimit.requestsPerMinute, 10);
  assert.equal(parsed.store.type, "file");
  assert.equal(parsed.store.path, ".sekimori/state.json");
  assert.deepEqual(parsed.cors.allowedOrigins, []);
  assert.equal(parsed.pinnedSystemPrompt, null);

  // The generated file must pass the *real* validateConfig once the two
  // required env vars are actually set (init only skips demanding they be
  // set *during generation* - see src/init.ts's validateGeneratedConfig doc
  // comment).
  t.after(resetRealEnv);
  process.env.ANTHROPIC_API_KEY = "sk-test-dummy";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-dummy-32-bytes-minimum-0001";
  assert.doesNotThrow(() => validateConfig(parsed));
});

test("init: --yes does not require ANTHROPIC_API_KEY / SEKIMORI_ADMIN_KEY to be set", async (t) => {
  const dir = tmpDir("sekimori-init-noenv-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedAdmin = process.env.SEKIMORI_ADMIN_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SEKIMORI_ADMIN_KEY;
  t.after(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedAdmin === undefined) delete process.env.SEKIMORI_ADMIN_KEY;
    else process.env.SEKIMORI_ADMIN_KEY = savedAdmin;
  });

  const exitCode = await runInit([cfgPath, "--yes"], silentIO());
  assert.equal(exitCode, 0);
  assert.ok(existsSync(cfgPath));
  // Env vars must be left exactly as they were (unset) afterwards.
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(process.env.SEKIMORI_ADMIN_KEY, undefined);
});

test("init: refuses to overwrite an existing file without --force", async (t) => {
  const dir = tmpDir("sekimori-init-noforce-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");
  writeFileSync(cfgPath, '{"marker":"pre-existing"}');

  const captured = capturingOutput();
  const exitCode = await runInit([cfgPath, "--yes"], silentIO({ output: captured.stream }));
  assert.notEqual(exitCode, 0);
  assert.match(captured.text(), /refus.*overwrite/i);
  // File must be untouched.
  assert.equal(readFileSync(cfgPath, "utf8"), '{"marker":"pre-existing"}');
});

test("init: refuses a file created while interactive answers are being collected", async (t) => {
  const dir = tmpDir("sekimori-init-late-file-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");
  const input = new PassThrough();
  const captured = capturingOutput();

  const resultPromise = runInit([cfgPath], { input, output: captured.stream, isTTY: true });
  assert.match(captured.text(), /interactive config generator/);

  const marker = '{"marker":"created-after-init-started"}';
  writeFileSync(cfgPath, marker);

  const answers = [
    "9999",
    "",
    "",
    "",
    "2.0",
    "",
    "",
    "50",
    "",
    "20",
    "memory",
    "https://example.com,https://foo.example",
    "You are a pirate.",
  ];
  const feeder = (async () => {
    for (const line of answers) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.write(`${line}\n`);
    }
  })();

  const exitCode = await resultPromise;
  await feeder;
  assert.notEqual(exitCode, 0);
  assert.match(captured.text(), /refus.*overwrite/i);
  assert.equal(readFileSync(cfgPath, "utf8"), marker);
});

test("init: --force overwrites an existing file", async (t) => {
  const dir = tmpDir("sekimori-init-force-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");
  writeFileSync(cfgPath, '{"marker":"pre-existing"}');

  const exitCode = await runInit([cfgPath, "--yes", "--force"], silentIO());
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.port, 8787);
});

test(
  "init: --force replaces a config symlink without writing through to its target",
  async (t) => {
    const dir = tmpDir("sekimori-init-force-symlink-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const victimPath = join(dir, "unrelated.json");
    const cfgPath = join(dir, "sekimori.config.json");
    const marker = '{"marker":"must remain unchanged"}';
    writeFileSync(victimPath, marker);
    try {
      symlinkSync(victimPath, cfgPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        t.skip(`file symlinks are not permitted in this Windows environment (${code})`);
        return;
      }
      throw err;
    }

    const exitCode = await runInit([cfgPath, "--yes", "--force"], silentIO());

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(victimPath, "utf8"), marker);
    assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).port, 8787);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.startsWith("sekimori.config.json.tmp-")),
      [],
    );
  },
);

test("init: --force replaces a config hard link without changing its other name", async (t) => {
  const dir = tmpDir("sekimori-init-force-hardlink-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const victimPath = join(dir, "unrelated.json");
  const cfgPath = join(dir, "sekimori.config.json");
  const marker = '{"marker":"must remain unchanged"}';
  writeFileSync(victimPath, marker);
  linkSync(victimPath, cfgPath);

  const exitCode = await runInit([cfgPath, "--yes", "--force"], silentIO());

  assert.equal(exitCode, 0);
  assert.equal(readFileSync(victimPath, "utf8"), marker);
  assert.equal(JSON.parse(readFileSync(cfgPath, "utf8")).port, 8787);
});

test("init: non-TTY without --yes exits non-zero with a hint, without hanging", async (t) => {
  const dir = tmpDir("sekimori-init-notty-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const captured = capturingOutput();
  const exitCode = await runInit([cfgPath], silentIO({ output: captured.stream, isTTY: false }));
  assert.notEqual(exitCode, 0);
  assert.match(captured.text(), /--yes/);
  assert.ok(!existsSync(cfgPath));
});

test("init: non-TTY without --yes is refused even when flags are present (no partial-flags escape hatch)", async (t) => {
  const dir = tmpDir("sekimori-init-notty-flags-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const captured = capturingOutput();
  const exitCode = await runInit(
    [cfgPath, "--port", "3000", "--monthly-usd", "10"],
    silentIO({ output: captured.stream, isTTY: false }),
  );
  assert.notEqual(exitCode, 0);
  assert.match(captured.text(), /--yes/);
  assert.ok(!existsSync(cfgPath));
});

// ---------------------------------------------------------------------------
// runInit: per-setting flags with --yes (issue #13)
// ---------------------------------------------------------------------------

test("init: --yes with per-setting flags writes exactly those values, defaults elsewhere", async (t) => {
  const dir = tmpDir("sekimori-init-flags-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const exitCode = await runInit(
    [
      cfgPath,
      "--yes",
      "--port",
      "3000",
      "--listen-host",
      "0.0.0.0",
      "--upstream-url",
      "https://upstream.example.com",
      "--upstream-timeout-ms",
      "5000",
      "--model",
      "claude-haiku-4-5-20251001=1,5",
      "--monthly-usd",
      "10",
      "--daily-usd",
      "0.25",
      "--rate-limit",
      "42",
      "--store",
      "file",
      "--store-path",
      "custom/state.json",
      "--cors-origin",
      "https://example.com",
      "--cors-origin",
      "https://foo.example",
      "--pinned-system",
      "You are a pirate.",
    ],
    silentIO(),
  );
  assert.equal(exitCode, 0);

  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.listenHost, "0.0.0.0");
  assert.equal(parsed.upstream.baseUrl, "https://upstream.example.com");
  assert.equal(parsed.upstream.timeoutMs, 5000);
  assert.deepEqual(parsed.models, { "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 } });
  assert.equal(parsed.budget.monthlyUsd, 10);
  assert.equal(parsed.budget.defaultDailyPerTokenUsd, 0.25);
  assert.equal(parsed.rateLimit.requestsPerMinute, 42);
  assert.equal(parsed.store.type, "file");
  assert.equal(parsed.store.path, "custom/state.json");
  assert.deepEqual(parsed.cors.allowedOrigins, ["https://example.com", "https://foo.example"]);
  assert.equal(parsed.pinnedSystemPrompt, "You are a pirate.");
});

test("init: --yes with --model given replaces the default model list entirely", async (t) => {
  const dir = tmpDir("sekimori-init-flags-models-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const exitCode = await runInit(
    [cfgPath, "--yes", "--model", "custom-model=2,7"],
    silentIO(),
  );
  assert.equal(exitCode, 0);

  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.deepEqual(parsed.models, { "custom-model": { inputPerMTok: 2, outputPerMTok: 7 } });
  assert.ok(!("claude-haiku-4-5-20251001" in parsed.models));
});

test("init: --yes --upstream-type bedrock writes the bedrock defaults (baseUrl, apiKeyEnv, model id)", async (t) => {
  const dir = tmpDir("sekimori-init-bedrock-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const exitCode = await runInit([cfgPath, "--yes", "--upstream-type", "bedrock"], silentIO());
  assert.equal(exitCode, 0);
  assert.ok(existsSync(cfgPath));

  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.upstream.type, "bedrock");
  assert.equal(parsed.upstream.baseUrl, "https://bedrock-runtime.us-east-1.amazonaws.com");
  assert.equal(parsed.upstream.apiKeyEnv, "AWS_BEARER_TOKEN_BEDROCK");
  assert.deepEqual(parsed.models, {
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  });

  // Generated config passes real validateConfig once the bedrock env vars are set.
  t.after(resetRealEnv);
  const ORIGINAL_BEDROCK_KEY = process.env.AWS_BEARER_TOKEN_BEDROCK;
  t.after(() => {
    if (ORIGINAL_BEDROCK_KEY === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = ORIGINAL_BEDROCK_KEY;
  });
  process.env.AWS_BEARER_TOKEN_BEDROCK = "dummy";
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-dummy-32-bytes-minimum-0001";
  assert.doesNotThrow(() => validateConfig(parsed));
});

test("init: --yes --upstream-type anthropic (or omitted) keeps the anthropic defaults unchanged", async (t) => {
  const dir = tmpDir("sekimori-init-anthropic-explicit-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const exitCode = await runInit([cfgPath, "--yes", "--upstream-type", "anthropic"], silentIO());
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.upstream.type, "anthropic");
  assert.equal(parsed.upstream.baseUrl, "https://api.anthropic.com");
  assert.equal(parsed.upstream.apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.ok("claude-haiku-4-5-20251001" in parsed.models);
});

test("init: an invalid --upstream-type value is rejected with non-zero exit and nothing written", async (t) => {
  const dir = tmpDir("sekimori-init-bedrock-invalid-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const captured = capturingOutput();
  const exitCode = await runInit(
    [cfgPath, "--yes", "--upstream-type", "openai"],
    silentIO({ output: captured.stream }),
  );
  assert.notEqual(exitCode, 0);
  assert.ok(!existsSync(cfgPath));
  assert.match(captured.text(), /--upstream-type/);
});

test("init: --yes without flags still writes pure defaults (regression guard)", async (t) => {
  const dir = tmpDir("sekimori-init-flags-none-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const exitCode = await runInit([cfgPath, "--yes"], silentIO());
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.port, 8787);
  assert.equal(parsed.budget.monthlyUsd, 30);
});

test("init: invalid flag values are rejected with non-zero exit and nothing written", async (t) => {
  const dir = tmpDir("sekimori-init-flags-invalid-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const cases = [
    ["--port", "not-a-number"],
    ["--model", "malformed-spec"],
    ["--store", "s3"],
    ["--upstream-url", "not a url"],
    ["--monthly-usd", "-5"],
    ["--upstream-type", "openai"],
  ];

  for (const flagArgs of cases) {
    const captured = capturingOutput();
    const exitCode = await runInit(
      [cfgPath, "--yes", ...flagArgs],
      silentIO({ output: captured.stream }),
    );
    assert.notEqual(exitCode, 0, `expected failure for ${flagArgs.join(" ")}`);
    assert.ok(!existsSync(cfgPath), `expected no file written for ${flagArgs.join(" ")}`);
  }
});

// ---------------------------------------------------------------------------
// runInit: --help (issue #13)
// ---------------------------------------------------------------------------

test("init: --help prints usage and exits 0 without writing a file", async (t) => {
  const dir = tmpDir("sekimori-init-help-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const captured = capturingOutput();
  const exitCode = await runInit([cfgPath, "--help"], silentIO({ output: captured.stream, isTTY: false }));
  assert.equal(exitCode, 0);
  assert.ok(!existsSync(cfgPath));
  assert.match(captured.text(), /Usage: sekimori init/);
  assert.match(captured.text(), /--model name=in,out/);
  assert.equal(captured.text(), INIT_HELP_TEXT);
});

test("init: --help wins even alongside a non-TTY refusal or bad flags", async (t) => {
  const captured = capturingOutput();
  const exitCode = await runInit(["--bogus-flag", "--help"], silentIO({ output: captured.stream, isTTY: false }));
  assert.equal(exitCode, 0);
});

test("init: interactive prompts (simulated TTY) accept typed answers and defaults", async (t) => {
  const dir = tmpDir("sekimori-init-interactive-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const input = new PassThrough();
  const captured = capturingOutput();

  // Scripted answers, one per line, in prompt order:
  //  port, upstream type, upstream URL, include-default-model(Y), input price, output price,
  //  add-another-model(empty=stop), monthly budget, daily budget, rate limit,
  //  store type, store path, cors origins, pinned system prompt.
  const answers = [
    "9999", // port
    "", // upstream type -> default anthropic
    "", // upstream base URL -> default
    "", // include default model? -> default (yes)
    "2.0", // input price override
    "", // output price -> default
    "", // add another model? -> stop
    "50", // monthly budget
    "", // daily per-token budget -> default
    "20", // rate limit
    "memory", // store type
    "https://example.com,https://foo.example", // cors origins
    "You are a pirate.", // pinned system prompt
  ];
  // Feed answers one line at a time with a small delay between writes rather
  // than writing them all up front: readline only attaches a 'line' listener
  // once a question() call is pending, so a single write containing every
  // answer would deliver all "line" events in one synchronous burst - the
  // first is consumed by the first pending question, and the rest fire with
  // no listener attached and are lost, hanging every question after that.
  const feeder = (async () => {
    for (const line of answers) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.write(`${line}\n`);
    }
  })();

  const exitCode = await runInit([cfgPath], { input, output: captured.stream, isTTY: true });
  await feeder;
  assert.equal(exitCode, 0, captured.text());

  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.port, 9999);
  assert.equal(parsed.upstream.baseUrl, "https://api.anthropic.com");
  assert.equal(parsed.models["claude-haiku-4-5-20251001"].inputPerMTok, 2.0);
  assert.equal(parsed.models["claude-haiku-4-5-20251001"].outputPerMTok, 5.0);
  assert.equal(parsed.budget.monthlyUsd, 50);
  assert.equal(parsed.budget.defaultDailyPerTokenUsd, 0.5);
  assert.equal(parsed.rateLimit.requestsPerMinute, 20);
  assert.equal(parsed.store.type, "memory");
  assert.equal(parsed.store.path, "");
  assert.deepEqual(parsed.cors.allowedOrigins, ["https://example.com", "https://foo.example"]);
  assert.equal(parsed.pinnedSystemPrompt, "You are a pirate.");

  assert.match(captured.text(), /REFERENCE VALUES/);
});

test("init: interactive mode pre-answers flagged settings (prints an ack, no prompt) and still prompts for the rest", async (t) => {
  const dir = tmpDir("sekimori-init-interactive-flags-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const input = new PassThrough();
  const captured = capturingOutput();

  // port, models, monthly budget, store type, store path are pre-answered via
  // flags below and must NOT be prompted for. Remaining prompts, in order:
  // upstream type, upstream URL, daily budget, rate limit, cors origins, pinned system.
  const answers = [
    "", // upstream type -> default anthropic
    "", // upstream base URL -> default
    "0.75", // daily per-token budget
    "15", // rate limit
    "https://example.com", // cors origins
    "hello", // pinned system prompt
  ];
  const feeder = (async () => {
    for (const line of answers) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.write(`${line}\n`);
    }
  })();

  const exitCode = await runInit(
    [
      cfgPath,
      "--port",
      "3000",
      "--model",
      "custom-model=2,3",
      "--monthly-usd",
      "15",
      "--store",
      "file",
      "--store-path",
      "custom/path.json",
    ],
    { input, output: captured.stream, isTTY: true },
  );
  await feeder;
  assert.equal(exitCode, 0, captured.text());

  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.upstream.baseUrl, "https://api.anthropic.com");
  assert.deepEqual(parsed.models, { "custom-model": { inputPerMTok: 2, outputPerMTok: 3 } });
  assert.equal(parsed.budget.monthlyUsd, 15);
  assert.equal(parsed.budget.defaultDailyPerTokenUsd, 0.75);
  assert.equal(parsed.rateLimit.requestsPerMinute, 15);
  assert.equal(parsed.store.type, "file");
  assert.equal(parsed.store.path, "custom/path.json");
  assert.deepEqual(parsed.cors.allowedOrigins, ["https://example.com"]);
  assert.equal(parsed.pinnedSystemPrompt, "hello");

  const text = captured.text();
  assert.match(text, /port: 3000 \(from --port\)/);
  assert.match(text, /models: custom-model \(from --model\)/);
  assert.match(text, /monthly budget USD: 15 \(from --monthly-usd\)/);
  assert.match(text, /store: file \(from --store\)/);
  assert.match(text, /store file path: custom\/path\.json \(from --store-path\)/);
  // promptModels' interactive-only banner must NOT appear - models was
  // pre-answered, so that prompt path never ran.
  assert.doesNotMatch(text, /REFERENCE VALUES/);
});

// ---------------------------------------------------------------------------
// Real CLI spawns (`tsx src/main.ts init ...`) - the acceptance criteria
// explicitly require exercising the real entry point, not just the module.
// ---------------------------------------------------------------------------

test("init: real CLI - `sekimori init <path> --yes` writes a valid config and exits 0", { skip: !existsSync(TSX_CLI) }, (t) => {
  const dir = tmpDir("sekimori-init-cli-yes-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const result = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "init", cfgPath, "--yes"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: REAL_CLI_TIMEOUT_MS,
  });

  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(existsSync(cfgPath));
  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.ok(Object.keys(parsed.models).length > 0);
});

test(
  "init: real CLI - non-TTY stdin without --yes exits non-zero and never hangs",
  { skip: !existsSync(TSX_CLI) },
  (t) => {
    const dir = tmpDir("sekimori-init-cli-notty-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cfgPath = join(dir, "sekimori.config.json");

    // Piping empty stdin in (rather than inheriting the test runner's TTY,
    // which may or may not be one) reproduces `printf '' | ... init` from
    // the acceptance criteria: stdin is a pipe, never a TTY.
    const result = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "init", cfgPath], {
      cwd: REPO_ROOT,
      input: "",
      encoding: "utf8",
      timeout: REAL_CLI_TIMEOUT_MS,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--yes/);
    assert.ok(!existsSync(cfgPath));
  },
);

test("init: real CLI - `sekimori init --help` exits 0 and prints usage", { skip: !existsSync(TSX_CLI) }, () => {
  const result = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "init", "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: REAL_CLI_TIMEOUT_MS,
  });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /Usage: sekimori init/);
});

test("init: real CLI - `sekimori --help` and `sekimori help` exit 0 and print top-level usage", { skip: !existsSync(TSX_CLI) }, () => {
  for (const helpArg of ["--help", "help"]) {
    const result = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, helpArg], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: REAL_CLI_TIMEOUT_MS,
    });
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /sekimori init/);
  }
});

test(
  "init: real CLI - per-setting flags with --yes write exactly those values through the real entry point",
  { skip: !existsSync(TSX_CLI) },
  (t) => {
    const dir = tmpDir("sekimori-init-cli-flags-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cfgPath = join(dir, "sekimori.config.json");

    const result = spawnSync(
      process.execPath,
      [
        TSX_CLI,
        MAIN_TS,
        "init",
        cfgPath,
        "--yes",
        "--port",
        "3000",
        "--model",
        "claude-haiku-4-5-20251001=1,5",
        "--monthly-usd",
        "10",
        "--cors-origin",
        "https://example.com",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: REAL_CLI_TIMEOUT_MS },
    );

    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(parsed.port, 3000);
    assert.deepEqual(parsed.models, { "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 } });
    assert.equal(parsed.budget.monthlyUsd, 10);
    assert.deepEqual(parsed.cors.allowedOrigins, ["https://example.com"]);
  },
);

test(
  "init: real CLI - a bedrock config from `init --upstream-type bedrock` passes `doctor` with the bedrock env vars set (issue #17)",
  { skip: !existsSync(TSX_CLI) },
  (t) => {
    const dir = tmpDir("sekimori-init-cli-bedrock-doctor-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cfgPath = join(dir, "sekimori.config.json");

    const initResult = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "init", cfgPath, "--yes", "--upstream-type", "bedrock"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: REAL_CLI_TIMEOUT_MS,
    });
    assert.equal(initResult.status, 0, `stdout: ${initResult.stdout}\nstderr: ${initResult.stderr}`);

    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(parsed.upstream.type, "bedrock");
    assert.equal(parsed.upstream.apiKeyEnv, "AWS_BEARER_TOKEN_BEDROCK");

    const doctorResult = spawnSync(process.execPath, [TSX_CLI, MAIN_TS, "doctor", cfgPath, "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: REAL_CLI_TIMEOUT_MS,
      env: {
        ...process.env,
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-upstream-test-key",
        SEKIMORI_ADMIN_KEY: "bedrock-admin-key-32-bytes-minimum-0001",
      },
    });
    assert.equal(doctorResult.status, 0, `stdout: ${doctorResult.stdout}\nstderr: ${doctorResult.stderr}`);
    const doctorJson = JSON.parse(doctorResult.stdout) as { ok: boolean };
    assert.equal(doctorJson.ok, true);
  },
);
