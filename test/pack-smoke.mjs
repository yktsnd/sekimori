// pack-smoke.mjs - cross-platform package acceptance test.
//
// Packs the repository (whose prepack hook performs a clean build), installs
// that exact tarball into a fresh temporary project, runs the installed bin,
// demo, and doctor, and makes a real HTTP round trip through the installed
// gateway. It deliberately uses
// only Node built-ins so Windows
// contributors do not need Git Bash, curl, tar, or jq.

import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const MODEL = "claude-haiku-4-5-20251001";
const ADMIN_KEY = "pack-smoke-admin-key-32-bytes-minimum-0001";

let step = 0;

function note(message) {
  step += 1;
  console.log(`[${step}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs a subprocess and includes captured output in failures. */
function run(command, args, options = {}) {
  const { cwd = REPO_ROOT, env = process.env, shell = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})\n${output}`));
    });
  });
}

/**
 * npm is normally on PATH. Allow the runtime that invokes this script to pass
 * an explicit JS CLI (for hermetic development environments that use pnpm)
 * without imposing pnpm on contributors or package consumers.
 */
function packageManager() {
  const cli = process.env.SEKIMORI_PACKAGE_MANAGER_CLI ?? process.env.npm_execpath;
  if (cli) return { command: process.execPath, prefix: [cli], shell: false };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: process.platform === "win32" };
}

async function runPackageManager(args, cwd, env = process.env) {
  const manager = packageManager();
  const path = [dirname(process.execPath), env.PATH].filter(Boolean).join(delimiter);
  return run(manager.command, [...manager.prefix, ...args], {
    cwd,
    shell: manager.shell,
    env: { ...env, PATH: path },
  });
}

function start(command, args, options = {}) {
  const { cwd = REPO_ROOT, env = process.env } = options;
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  return { child, log: () => log };
}

async function stop(started) {
  if (!started || started.child.exitCode !== null || started.child.signalCode !== null) return;
  started.child.kill();
  await Promise.race([
    new Promise((resolve) => started.child.once("exit", resolve)),
    sleep(2_000),
  ]);
  if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGKILL");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a local port");
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return address.port;
}

async function waitForHttp(url) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }
  throw new Error(`timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function expectFile(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`packed tarball is missing ${path}`);
  }
}

async function expectMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`packed tarball unexpectedly contains ${path}`);
}

async function main() {
  const packDir = await mkdtemp(join(tmpdir(), "sekimori-pack-"));
  const projectDir = await mkdtemp(join(tmpdir(), "sekimori-pack-project-"));
  let mock;
  let gateway;

  try {
    note("packing the repository (prepack performs a clean canonical build)");
    await runPackageManager(["pack", "--silent", "--pack-destination", packDir], REPO_ROOT);
    const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.join(", ") || "none"}`);
    const tarball = join(packDir, tarballs[0]);

    note("installing that tarball into a fresh temporary project");
    await writeFile(join(projectDir, "package.json"), '{"private":true}\n', "utf8");
    // Keep the invocation portable across npm and the optional pnpm-backed
    // hermetic test environment. (pnpm intentionally does not accept npm's
    // --no-audit / --no-fund switches.)
    await runPackageManager(["install", tarball], projectDir);

    const installedRoot = join(projectDir, "node_modules", "sekimori");
    const expectedFiles = [
      "docs/configuration.md",
      "docs/api.md",
      "docs/security-model.md",
      "examples/chat.html",
      "examples/demo.mjs",
      "sekimori.config.example.json",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "SUPPORT.md",
      "GOVERNANCE.md",
      "CODE_OF_CONDUCT.md",
      "RELEASING.md",
      "ROADMAP.md",
      "dist/main.js",
    ];
    await Promise.all(expectedFiles.map((relative) => expectFile(join(installedRoot, relative))));
    const forbiddenPaths = [
      ".env",
      ".github",
      "coverage",
      "docs/history",
      "scripts",
      "sekimori.config.json",
      "src",
      "state",
      "test",
      "usage.json",
    ];
    await Promise.all(forbiddenPaths.map((relative) => expectMissing(join(installedRoot, relative))));

    const installedManifest = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
    if (installedManifest.bin?.sekimori !== "dist/main.js") throw new Error("packed manifest has an invalid sekimori bin target");
    if (installedManifest.scripts?.start !== "node dist/main.js") throw new Error("packed manifest has a broken start script");
    if (installedManifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
      throw new Error("packed manifest has an unexpected publish registry");
    }
    if (installedManifest.publishConfig?.access !== "public" || installedManifest.publishConfig?.provenance !== true) {
      throw new Error("packed manifest must require public access and provenance");
    }

    const installedBin = join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "sekimori.cmd" : "sekimori");
    await expectFile(installedBin);
    note("executing the installed bin shim");
    const helpOutput = await runPackageManager(["exec", "--", "sekimori", "--help"], projectDir);
    if (!helpOutput.includes("Usage:") || !helpOutput.includes("Amazon Bedrock")) {
      throw new Error(`installed bin returned unexpected help\n${helpOutput}`);
    }
    const versionOutput = await runPackageManager(["exec", "--", "sekimori", "--version"], projectDir);
    if (versionOutput.trim() !== installedManifest.version) {
      throw new Error(`installed bin version ${versionOutput.trim()} does not match ${installedManifest.version}`);
    }

    const packagedDemoUpstreamPort = await freePort();
    let packagedDemoGatewayPort = await freePort();
    while (packagedDemoGatewayPort === packagedDemoUpstreamPort) packagedDemoGatewayPort = await freePort();
    note("running `sekimori demo` through the installed bin shim");
    const demoOutput = await runPackageManager(
      ["exec", "--", "sekimori", "demo"],
      projectDir,
      {
        ...process.env,
        SEKIMORI_DEMO_UPSTREAM_PORT: String(packagedDemoUpstreamPort),
        SEKIMORI_DEMO_PORT: String(packagedDemoGatewayPort),
        // A legacy opt-in once enabled a billable provider path. Keep this
        // hostile-environment regression guard: the public demo must remain
        // offline even if an old shell still exports that variable.
        SEKIMORI_DEMO_REAL: "1",
        ANTHROPIC_API_KEY: "",
      },
    );
    if (!demoOutput.includes("All 18 steps completed. Exit code 0.")) {
      throw new Error(`installed \`sekimori demo\` did not complete its 18 steps\n${demoOutput}`);
    }

    const upstreamPort = await freePort();
    const gatewayPort = await freePort();
    note("starting the packaged mock upstream")
    mock = start(process.execPath, [join(installedRoot, "examples", "mock-upstream.mjs"), String(upstreamPort)]);
    await waitForHttp(`http://127.0.0.1:${upstreamPort}/healthz-not-a-real-path`);
    const oversizedMockResponse = await fetch(`http://127.0.0.1:${upstreamPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(70 * 1024) }] }),
    });
    if (oversizedMockResponse.status !== 413) {
      throw new Error(`packaged mock upstream accepted an oversized body (${oversizedMockResponse.status})`);
    }

    const configPath = join(packDir, "sekimori.config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          port: gatewayPort,
          upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKeyEnv: "SEKIMORI_PACK_UPSTREAM_KEY" },
          models: { [MODEL]: { inputPerMTok: 1, outputPerMTok: 5 } },
          budget: { monthlyUsd: 5, defaultDailyPerTokenUsd: 0.5 },
          rateLimit: { requestsPerMinute: 10 },
          pinnedSystemPrompt: null,
          cors: { allowedOrigins: [] },
          logging: { logBodies: false },
          store: { type: "memory", path: "" },
        },
        null,
        2,
      ),
      "utf8",
    );
    const packagedEnv = {
      ...process.env,
      SEKIMORI_ADMIN_KEY: ADMIN_KEY,
      SEKIMORI_PACK_UPSTREAM_KEY: "dummy-mock-key",
    };
    note("running `sekimori doctor --json` from the installed package");
    const doctorOutput = await run(
      process.execPath,
      [join(installedRoot, "dist", "main.js"), "doctor", configPath, "--json"],
      { cwd: projectDir, env: packagedEnv },
    );
    const doctor = JSON.parse(doctorOutput);
    const doctorChecks = new Set(doctor.checks?.map((check) => check.name));
    const expectedChecks = [
      "config_file",
      "config_valid",
      "upstream_key_env",
      "admin_key_env",
      "store_writable",
      "logging",
    ];
    if (!doctor.ok || expectedChecks.some((name) => !doctorChecks.has(name))) {
      throw new Error(`installed doctor did not pass with every stable check name\n${doctorOutput}`);
    }

    note("starting the installed sekimori entry point");
    gateway = start(process.execPath, [join(installedRoot, "dist", "main.js"), configPath], {
      cwd: projectDir,
      env: packagedEnv,
    });
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/healthz`);

    const base = `http://127.0.0.1:${gatewayPort}`;
    note("GET /healthz from the installed gateway")
    const health = await fetch(`${base}/healthz`);
    if (health.status !== 200 || !(await health.json()).ok) throw new Error("installed /healthz did not return { ok: true }");

    note("issuing an invite token through the installed admin API")
    const issued = await fetch(`${base}/admin/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "pack-smoke", dailyUsd: 1 }),
    });
    if (issued.status !== 201) throw new Error(`installed /admin/tokens returned ${issued.status}: ${await issued.text()}`);
    const token = (await issued.json()).token;
    if (typeof token !== "string" || token.length === 0) throw new Error("installed /admin/tokens did not return a token");

    note("making a Messages round trip through the installed gateway")
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 50, messages: [{ role: "user", content: "hello from pack-smoke" }] }),
    });
    if (response.status !== 200) throw new Error(`installed /v1/messages returned ${response.status}: ${await response.text()}`);

    console.log(`All ${step} steps completed. Exit code 0.`);
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    if (mock) console.error(`--- mock-upstream.log ---\n${mock.log()}`);
    if (gateway) console.error(`--- sekimori.log ---\n${gateway.log()}`);
    throw err;
  } finally {
    await stop(gateway);
    await stop(mock);
    await rm(packDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
}

await main();
