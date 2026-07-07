// main.ts — エントリポイント（config 読込 → サーバー起動）

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfigFromFile, ConfigError, type SekimoriConfig } from "./config.js";
import { FileStore, MemoryStore, type Store } from "./store.js";

// A-3: 起動時に有効設定のサマリを表示する。秘密情報（上流 API キー・管理キーの値そのもの）は
// 一切出さない。ユーザーが「自分の設定（予算・モデル・CORS）が効いているか」を起動直後に
// 確認できるようにするための表示専用の関数（副作用は console.log のみ）。
function formatStartupSummary(config: SekimoriConfig): string[] {
  const models = Object.keys(config.models).join(", ") || "(なし)";
  const cors =
    config.cors.allowedOrigins.length > 0 ? config.cors.allowedOrigins.join(", ") : "CORS disabled (allowedOrigins が空)";
  const store = config.store.type === "file" ? `file (${config.store.path})` : "memory";

  return [
    "[sekimori] 起動設定サマリ:",
    `[sekimori]   port: ${config.port}`,
    `[sekimori]   upstream.baseUrl: ${config.upstream.baseUrl}`,
    `[sekimori]   models (許可リスト): ${models}`,
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
    // loadConfigFromFile 内で既に検証済みのはずだが、念のため二重に確認する（fail-closed）。
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
