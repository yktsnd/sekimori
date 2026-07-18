// test-app.ts - helpers for assembling a config / app in tests

import type { Hono } from "hono";
import { createApp } from "../../src/app.js";
import type { SekimoriConfig } from "../../src/config.js";
import { MemoryStore, type Store } from "../../src/store.js";

export const TEST_ADMIN_KEY = "test-admin-key-32-bytes-minimum-0001";
export const TEST_UPSTREAM_API_KEY = "test-upstream-key";

export function buildTestConfig(baseUrl: string, overrides: Partial<SekimoriConfig> = {}): SekimoriConfig {
  return {
    port: 0,
    listenHost: "127.0.0.1",
    upstream: { baseUrl, apiKeyEnv: "TEST_UPSTREAM_KEY_ENV", timeoutMs: 120_000, type: "anthropic" },
    models: { "test-model": { inputPerMTok: 1, outputPerMTok: 5 } },
    budget: { monthlyUsd: 30, defaultDailyPerTokenUsd: 0.5 },
    rateLimit: { requestsPerMinute: 10 },
    pinnedSystemPrompt: null,
    cors: { allowedOrigins: [] },
    logging: { logBodies: false },
    store: { type: "memory", path: "" },
    ...overrides,
  };
}

export interface TestAppHandle {
  app: Hono;
  store: Store;
  adminKey: string;
}

export function buildApp(config: SekimoriConfig, store: Store = new MemoryStore()): TestAppHandle {
  const app = createApp({
    config,
    store,
    upstreamApiKey: TEST_UPSTREAM_API_KEY,
    adminKey: TEST_ADMIN_KEY,
  });
  return { app, store, adminKey: TEST_ADMIN_KEY };
}

export interface IssuedToken {
  id: string;
  token: string;
}

export async function issueToken(
  app: Hono,
  adminKey: string,
  opts: { name?: string; dailyUsd?: number } = {},
): Promise<IssuedToken> {
  const res = await app.fetch(
    new Request("http://localhost/admin/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );
  if (res.status !== 201) {
    throw new Error(`failed to issue token: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as IssuedToken;
}

export function messagesRequest(
  token: string,
  body: Record<string, unknown>,
  init: Partial<RequestInit> = {},
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

export async function getUsage(app: Hono, token: string): Promise<{ todayUsd: number; dailyLimitUsd: number }> {
  const res = await app.fetch(new Request("http://localhost/v1/usage", { headers: { Authorization: `Bearer ${token}` } }));
  return (await res.json()) as { todayUsd: number; dailyLimitUsd: number };
}

/** Polls until the condition holds. Used e.g. to wait for the async accounting that runs after a stream ends. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
