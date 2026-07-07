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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInit, parseInitArgs, type InitIO } from "../src/init.js";
import { validateConfig } from "../src/config.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules/.bin/tsx");
const MAIN_TS = join(REPO_ROOT, "src/main.ts");

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
  assert.deepEqual(parsed, { path: "./sekimori.config.json", force: false, yes: false });
});

test("init: parseInitArgs reads a positional path and flags in any order", () => {
  const parsed = parseInitArgs(["--force", "custom.config.json", "--yes"]);
  assert.deepEqual(parsed, { path: "custom.config.json", force: true, yes: true });
});

test("init: parseInitArgs rejects unknown flags", () => {
  const parsed = parseInitArgs(["--bogus"]);
  assert.ok("error" in parsed);
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
  assert.equal(parsed.upstream.baseUrl, "https://api.anthropic.com");
  assert.equal(parsed.upstream.apiKeyEnv, "ANTHROPIC_API_KEY");
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
  process.env.SEKIMORI_ADMIN_KEY = "admin-test-dummy";
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

test("init: interactive prompts (simulated TTY) accept typed answers and defaults", async (t) => {
  const dir = tmpDir("sekimori-init-interactive-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const input = new PassThrough();
  const captured = capturingOutput();

  // Scripted answers, one per line, in prompt order:
  //  port, upstream URL, include-default-model(Y), input price, output price,
  //  add-another-model(empty=stop), monthly budget, daily budget, rate limit,
  //  store type, store path, cors origins, pinned system prompt.
  const answers = [
    "9999", // port
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

// ---------------------------------------------------------------------------
// Real CLI spawns (`tsx src/main.ts init ...`) - the acceptance criteria
// explicitly require exercising the real entry point, not just the module.
// ---------------------------------------------------------------------------

test("init: real CLI - `sekimori init <path> --yes` writes a valid config and exits 0", { skip: !existsSync(TSX_BIN) }, (t) => {
  const dir = tmpDir("sekimori-init-cli-yes-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, "sekimori.config.json");

  const result = spawnSync(TSX_BIN, [MAIN_TS, "init", cfgPath, "--yes"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(existsSync(cfgPath));
  const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.ok(Object.keys(parsed.models).length > 0);
});

test(
  "init: real CLI - non-TTY stdin without --yes exits non-zero and never hangs",
  { skip: !existsSync(TSX_BIN) },
  (t) => {
    const dir = tmpDir("sekimori-init-cli-notty-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cfgPath = join(dir, "sekimori.config.json");

    // Piping empty stdin in (rather than inheriting the test runner's TTY,
    // which may or may not be one) reproduces `printf '' | ... init` from
    // the acceptance criteria: stdin is a pipe, never a TTY.
    const result = spawnSync(TSX_BIN, [MAIN_TS, "init", cfgPath], {
      cwd: REPO_ROOT,
      input: "",
      encoding: "utf8",
      timeout: 20_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--yes/);
    assert.ok(!existsSync(cfgPath));
  },
);
