#!/usr/bin/env node
// main.ts - entry point (load config, then start the server)

import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfigFromFile, ConfigError, type SekimoriConfig } from "./config.js";
import { FileStore, MemoryStore, type Store } from "./store.js";
import { runInit, INIT_HELP_TEXT } from "./init.js";
import { runDoctor } from "./doctor.js";

// Brief top-level usage (issue #13): `sekimori --help` / `sekimori help`.
// Deliberately short - `sekimori init --help` (INIT_HELP_TEXT) and
// `sekimori doctor --help` cover their own flags in full; this just points
// to the commands that exist.
const TOP_LEVEL_HELP_TEXT = `sekimori - a minimal self-hosted access and budget gateway for Anthropic or Amazon Bedrock.

Usage:
  sekimori [configPath]          Start the server (default: ./sekimori.config.json)
  sekimori demo                  Run the 18-step offline safety demo (no API key, zero spend)
  sekimori init [path] [flags]   Generate a config file (interactive, or non-interactive with --yes)
  sekimori init --help           Show init flags and examples
  sekimori doctor [config] [--json]
                                  Non-interactive installation self-check (default: ./sekimori.config.json)
  sekimori doctor --help         Show doctor flags and examples
  sekimori --help                Show this help
  sekimori --version             Show the installed version

Examples:
  sekimori demo
  sekimori
  sekimori ./my.config.json
  sekimori init --yes
  sekimori init --yes --port 3000 --model claude-haiku-4-5-20251001=1,5 --monthly-usd 10
  sekimori doctor
  sekimori doctor ./my.config.json --json
`;

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package.json does not contain a valid version");
  }
  return manifest.version;
}

// A-3: print a summary of the effective settings at startup. Never prints
// secrets (the upstream API key or the admin key values). Lets the operator
// confirm right after boot that their settings (budget / models / CORS) took
// effect. Display-only: its only side effect is console.log.
function formatStartupSummary(config: SekimoriConfig): string[] {
  const models = Object.keys(config.models).join(", ") || "(none)";
  const cors =
    config.cors.allowedOrigins.length > 0 ? config.cors.allowedOrigins.join(", ") : "CORS disabled (allowedOrigins is empty)";
  const store = config.store.type === "file" ? `file (${config.store.path})` : "memory";

  return [
    "[sekimori] startup settings summary:",
    `[sekimori]   port: ${config.port}`,
    `[sekimori]   listenHost: ${config.listenHost}`,
    `[sekimori]   upstream.baseUrl: ${config.upstream.baseUrl}`,
    `[sekimori]   upstream.timeoutMs: ${config.upstream.timeoutMs}`,
    `[sekimori]   models (allow list): ${models}`,
    `[sekimori]   budget.monthlyUsd: $${config.budget.monthlyUsd}`,
    `[sekimori]   budget.defaultDailyPerTokenUsd: $${config.budget.defaultDailyPerTokenUsd}`,
    `[sekimori]   rateLimit.requestsPerMinute: ${config.rateLimit.requestsPerMinute}`,
    `[sekimori]   cors.allowedOrigins: ${cors}`,
    `[sekimori]   store: ${store}`,
    `[sekimori]   logging.logBodies: ${config.logging.logBodies}`,
  ];
}

async function runServe(configPath: string): Promise<void> {
  let config;
  try {
    config = loadConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[sekimori] config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const store: Store = config.store.type === "file" ? new FileStore(config.store.path) : new MemoryStore();
  await store.init();

  const upstreamApiKey = process.env[config.upstream.apiKeyEnv];
  const adminKey = process.env.SEKIMORI_ADMIN_KEY;
  if (!upstreamApiKey || !adminKey) {
    // Already validated inside loadConfigFromFile, but double-check here to be safe (fail-closed).
    console.error("[sekimori] required environment variables are missing");
    process.exit(1);
  }

  const app = createApp({ config, store, upstreamApiKey, adminKey });

  for (const line of formatStartupSummary(config)) {
    console.log(line);
  }

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.listenHost }, (info) => {
    const displayHost = config.listenHost.includes(":") ? `[${config.listenHost}]` : config.listenHost;
    console.log(`[sekimori] listening on http://${displayHost}:${info.port} (upstream: ${config.upstream.baseUrl})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[sekimori] ${signal} received; shutting down`);
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    });
    const forcedExit = setTimeout(() => process.exit(1), 10_000);
    forcedExit.unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

// CLI dispatch. The implicit default ("serve") treats its sole positional
// argument, if present, as a config file path. Recognized subcommands are
// handled before that fallback. This function is the
// seam for future subcommands - add a branch here for a recognized args[0]
// before it falls through to being treated as a config path, so `serve`
// behavior never has to change.
async function run(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    process.stdout.write(TOP_LEVEL_HELP_TEXT);
    process.exit(0);
    return;
  }

  if (args[0] === "init") {
    const exitCode = await runInit(args.slice(1), {
      input: process.stdin,
      output: process.stdout,
      isTTY: process.stdin.isTTY === true,
    });
    process.exit(exitCode);
    return;
  }

  if (args[0] === "doctor") {
    const exitCode = runDoctor(args.slice(1), { output: process.stdout });
    process.exit(exitCode);
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    process.exit(0);
    return;
  }

  if (args[0] === "demo") {
    // The same demo works from a source clone and from the published package.
    // When this compiled entry point launches it, tell the script to spawn
    // this exact dist/main.js for the nested gateway process. Under tsx the
    // entry still ends in .ts, so the script deliberately falls back to the
    // source + tsx path instead.
    const currentEntry = fileURLToPath(import.meta.url);
    if (currentEntry.endsWith(".js")) {
      process.env.SEKIMORI_DEMO_GATEWAY_ENTRY = currentEntry;
    }
    await import(new URL("../examples/demo.mjs", import.meta.url).href);
    return;
  }

  const configPath = args[0] ?? "./sekimori.config.json";
  await runServe(configPath);
}

run(process.argv).catch((err) => {
  console.error("[sekimori] fatal error:", err);
  process.exit(1);
});
