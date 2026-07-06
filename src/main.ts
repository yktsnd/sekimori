// main.ts — エントリポイント（config 読込 → サーバー起動）

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfigFromFile, ConfigError } from "./config.js";
import { FileStore, MemoryStore, type Store } from "./store.js";

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
    // loadConfigFromFile 内で既に検証済みのはずだが、念のため二重に確認する（fail-closed）。
    console.error("[sekimori] required environment variables are missing");
    process.exit(1);
  }

  const app = createApp({ config, store, upstreamApiKey, adminKey });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[sekimori] listening on http://localhost:${info.port} (upstream: ${config.upstream.baseUrl})`);
  });
}

main().catch((err) => {
  console.error("[sekimori] fatal error:", err);
  process.exit(1);
});
