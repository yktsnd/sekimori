#!/usr/bin/env node
// demo.mjs - cross-platform, offline scenario demo for sekimori.
//
// This is the Node.js counterpart to demo.sh. It deliberately uses only
// Node 20+ built-ins so Windows users do not need Bash or curl to verify the
// product's core safety story. demo.sh remains available for existing POSIX
// workflows.

import { access, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const exampleDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(exampleDir);
const upstreamPort = Number(process.env.SEKIMORI_DEMO_UPSTREAM_PORT ?? 19999);
const sekimoriPort = Number(process.env.SEKIMORI_DEMO_PORT ?? 18787);
const adminKey = "demo-admin-key-32-bytes-minimum-0001";
const model = "claude-haiku-4-5-20251001";
const disallowedModel = "claude-opus-4-1-20250805";

function isPort(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

if (!isPort(upstreamPort) || !isPort(sekimoriPort) || upstreamPort === sekimoriPort) {
  throw new Error(
    "SEKIMORI_DEMO_UPSTREAM_PORT and SEKIMORI_DEMO_PORT must be different integer ports from 1 through 65535",
  );
}

let step = 0;
let tempDir;
let upstream;
let gateway;

function act(title) {
  console.log(`\n=== ${title} ===`);
}

function note(message) {
  step += 1;
  console.log(`  [${step}] ${message}`);
}

function assertStatus(description, expected, result) {
  step += 1;
  if (result.status !== expected) {
    throw new Error(
      `[${step}] ${description}: expected HTTP ${expected}, got ${result.status}\nresponse body: ${result.bodyText}`,
    );
  }
  console.log(`  [${step}] OK   ${description} (HTTP ${result.status})`);
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function parseJson(result) {
  try {
    return JSON.parse(result.bodyText);
  } catch {
    return {};
  }
}

async function request(method, path, bearer, body) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${sekimoriPort}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, bodyText: await response.text() };
}

async function waitForHttp(url) {
  let latestError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`timed out waiting for ${url}: ${latestError instanceof Error ? latestError.message : latestError}`);
}

async function startNode(script, args, env, logPath) {
  const log = await open(logPath, "w");
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env,
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
  });
  // The child inherited the descriptor. Closing the parent descriptor does
  // not stop writes and prevents a descriptor leak during repeated demos.
  await log.close();
  return child;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the gateway process without assuming a development checkout.
 * `npm run demo` uses src/main.ts through the locally installed tsx, while
 * `sekimori demo` and a directly invoked packaged example use dist/main.js.
 */
async function resolveGatewayLaunch() {
  const explicitEntry = process.env.SEKIMORI_DEMO_GATEWAY_ENTRY;
  if (explicitEntry) return { script: explicitEntry, prefixArgs: [] };

  const sourceEntry = join(root, "src", "main.ts");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if ((await exists(sourceEntry)) && (await exists(tsxCli))) {
    return { script: tsxCli, prefixArgs: [sourceEntry] };
  }

  const compiledEntry = join(root, "dist", "main.js");
  if (await exists(compiledEntry)) return { script: compiledEntry, prefixArgs: [] };

  throw new Error("could not find a runnable sekimori entry point (expected src/main.ts + tsx or dist/main.js)");
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function printLogsOnFailure(error) {
  if (!tempDir) return;
  const labels = [
    ["mock upstream", join(tempDir, "mock-upstream.log")],
    ["sekimori", join(tempDir, "sekimori.log")],
  ];
  for (const [label, path] of labels) {
    try {
      console.error(`--- ${label} log ---`);
      console.error(await readFile(path, "utf8"));
    } catch {
      // Nothing to add if a process never started.
    }
  }
  console.error(error instanceof Error ? error.message : error);
}

async function main() {
  tempDir = await mkdtemp(join(tmpdir(), "sekimori-demo-"));
  const configPath = join(tempDir, "sekimori.config.json");
  const upstreamLog = join(tempDir, "mock-upstream.log");
  const gatewayLog = join(tempDir, "sekimori.log");

  act("Act 1: Going live");

  note("starting the mock upstream (examples/mock-upstream.mjs) - it stands in for the real Anthropic API");
  upstream = await startNode(join(exampleDir, "mock-upstream.mjs"), [String(upstreamPort)], process.env, upstreamLog);
  await waitForHttp(`http://127.0.0.1:${upstreamPort}/healthz-not-a-real-path`);
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const upstreamApiKeyEnv = "SEKIMORI_DEMO_UPSTREAM_KEY";
  const aliceMaxTokens = 50;
  const mallorySmallMaxTokens = 50;
  const malloryHugeMaxTokens = 200_000;

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        port: sekimoriPort,
        upstream: { baseUrl: upstreamBaseUrl, apiKeyEnv: upstreamApiKeyEnv },
        models: { [model]: { inputPerMTok: 1, outputPerMTok: 5 } },
        budget: { monthlyUsd: 5, defaultDailyPerTokenUsd: 0.5 },
        rateLimit: { requestsPerMinute: 5 },
        pinnedSystemPrompt: null,
        cors: { allowedOrigins: [] },
        logging: { logBodies: false },
        store: { type: "memory", path: "" },
      },
      null,
      2,
    )}\n`,
  );

  const gatewayLaunch = await resolveGatewayLaunch();
  note("starting sekimori (monthly cap $5, rate limit 5 req/min, a single model)");
  gateway = await startNode(gatewayLaunch.script, [...gatewayLaunch.prefixArgs, configPath], {
    ...process.env,
    SEKIMORI_ADMIN_KEY: adminKey,
    SEKIMORI_DEMO_UPSTREAM_KEY: "dummy-mock-key",
  }, gatewayLog);
  await waitForHttp(`http://127.0.0.1:${sekimoriPort}/healthz`);

  note("the startup summary prints as-is:");
  for (const line of (await readFile(gatewayLog, "utf8")).trimEnd().split("\n")) console.log(`        ${line}`);

  act("Act 2: Inviting people");
  let result = await request("POST", "/admin/tokens", adminKey, { name: "alice", dailyUsd: 1 });
  assertStatus("issue a token for alice (dailyUsd: $1.0 - a normal user)", 201, result);
  const aliceToken = valueAtPath(parseJson(result), "token");

  result = await request("POST", "/admin/tokens", adminKey, { name: "mallory", dailyUsd: 0.002 });
  assertStatus("issue a token for mallory (dailyUsd: $0.002 - set up to hit her cap immediately)", 201, result);
  const malloryToken = valueAtPath(parseJson(result), "token");
  const malloryId = valueAtPath(parseJson(result), "id");

  result = await request("POST", "/v1/messages", aliceToken, {
    model,
    max_tokens: aliceMaxTokens,
    messages: [{ role: "user", content: "hello from alice" }],
  });
  assertStatus("alice makes one non-streaming round trip -> gets a response", 200, result);

  result = await request("POST", "/v1/messages", aliceToken, {
    model,
    max_tokens: aliceMaxTokens,
    stream: true,
    messages: [{ role: "user", content: "hello again" }],
  });
  assertStatus("alice makes one streaming round trip -> text streams back", 200, result);

  result = await request("GET", "/v1/usage", aliceToken);
  assertStatus("alice checks /v1/usage -> her spend is recorded", 200, result);
  const usage = parseJson(result);
  console.log(`        alice's usage today: $${usage.todayUsd} / $${usage.dailyLimitUsd}`);

  act("Act 3: The guard kicks in");
  result = await request("POST", "/v1/messages", undefined, {
    model,
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  });
  assertStatus("/v1/messages without a token -> sekimori does not become a free-for-all proxy", 401, result);

  result = await request("POST", "/v1/messages", aliceToken, {
    model: disallowedModel,
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  });
  assertStatus("alice requests a non-allowlisted model -> no sneaking onto pricier models", 403, result);

  result = await request("POST", "/v1/messages", malloryToken, {
    model,
    max_tokens: mallorySmallMaxTokens,
    messages: [{ role: "user", content: "hi" }],
  });
  assertStatus("mallory uses her token once -> still under her cap, so it succeeds", 200, result);

  result = await request("POST", "/v1/messages", malloryToken, {
    model,
    max_tokens: malloryHugeMaxTokens,
    messages: [{ role: "user", content: "hi" }],
  });
  assertStatus("mallory tries again -> budget_exceeded_error (daily) + Retry-After", 429, result);
  if (!result.headers.get("retry-after") || valueAtPath(parseJson(result), "error.type") !== "budget_exceeded_error") {
    throw new Error("budget response must include Retry-After and budget_exceeded_error");
  }

  note("alice fires 6 rapid requests -> hits the rate limit (5 req/min)");
  let rateLimited = false;
  for (let index = 1; index <= 6; index += 1) {
    result = await request("POST", "/v1/messages", aliceToken, {
      model,
      max_tokens: aliceMaxTokens,
      messages: [{ role: "user", content: `burst ${index}` }],
    });
    if (
      result.status === 429 &&
      valueAtPath(parseJson(result), "error.type") === "rate_limit_error" &&
      result.headers.get("retry-after")
    ) {
      rateLimited = true;
      console.log(`        request ${index} got 429 rate_limit_error (Retry-After: ${result.headers.get("retry-after")}s)`);
      break;
    }
  }
  step += 1;
  if (!rateLimited) throw new Error(`[${step}] no rate_limit_error within 6 rapid requests`);
  console.log(`  [${step}] OK   rate_limit_error + Retry-After occurred within the 6 rapid requests`);

  result = await request("GET", "/admin/usage", adminKey);
  assertStatus("the operator checks /admin/usage -> mallory's spend is visible", 200, result);
  if (!(parseJson(result).tokens ?? []).some((token) => token.name === "mallory")) {
    throw new Error("mallory is missing from the /admin/usage listing");
  }

  result = await request("DELETE", `/admin/tokens/${malloryId}`, adminKey);
  assertStatus("the operator revokes mallory's token", 200, result);

  result = await request("POST", "/v1/messages", malloryToken, {
    model,
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  });
  assertStatus("mallory's next request after revocation is immediately 401 (uninviting works)", 401, result);

  note("Summary: only legitimate requests reached the upstream; the API key never left the server.");
  console.log(`\nAll ${step} steps completed. Exit code 0.`);
}

try {
  await main();
} catch (error) {
  await printLogsOnFailure(error);
  process.exitCode = 1;
} finally {
  await stop(gateway);
  await stop(upstream);
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
