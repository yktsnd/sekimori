#!/usr/bin/env node
// main.ts - entry point (load config, then start the server)

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfigFromFile, ConfigError, type SekimoriConfig } from "./config.js";
import { FileStore, MemoryStore, type Store } from "./store.js";
import { runInit, INIT_HELP_TEXT } from "./init.js";
import { runDoctor } from "./doctor.js";

// Brief top-level usage (issue #13): `sekimori --help` / `sekimori help`.
// Deliberately short - `sekimori init --help` (INIT_HELP_TEXT) and
// `sekimori doctor --help` cover their own flags in full; this just points
// to the commands that exist.
const TOP_LEVEL_HELP_TEXT = `sekimori - a minimal self-hosted gateway for Anthropic-compatible LLM APIs.

Usage:
  sekimori [configPath]          Start the server (default: ./sekimori.config.json)
  sekimori init [path] [flags]   Generate a config file (interactive, or non-interactive with --yes)
  sekimori init --help           Show init flags and examples
  sekimori doctor [config] [--json]
                                  Non-interactive installation self-check (default: ./sekimori.config.json)
  sekimori doctor --help         Show doctor flags and examples
  sekimori --help                Show this help

Examples:
  sekimori
  sekimori ./my.config.json
  sekimori init --yes
  sekimori init --yes --port 3000 --model claude-haiku-4-5-20251001=1,5 --monthly-usd 10
  sekimori doctor
  sekimori doctor ./my.config.json --json
`;

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
    `[sekimori]   upstream.baseUrl: ${config.upstream.baseUrl}`,
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

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[sekimori] listening on http://localhost:${info.port} (upstream: ${config.upstream.baseUrl})`);
  });
}

// CLI dispatch. Today there are two commands: the implicit default ("serve"),
// where the sole positional argument, if present, is a config file path; and
// `init` (issue #7), an interactive config generator. This function is the
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

  const configPath = args[0] ?? "./sekimori.config.json";
  await runServe(configPath);
}

run(process.argv).catch((err) => {
  console.error("[sekimori] fatal error:", err);
  process.exit(1);
});
