// main.ts - entry point (load config, then start the server)

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfigFromFile, ConfigError, type SekimoriConfig } from "./config.js";
import { FileStore, MemoryStore, type Store } from "./store.js";

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

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "./sekimori.config.json";

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

main().catch((err) => {
  console.error("[sekimori] fatal error:", err);
  process.exit(1);
});
