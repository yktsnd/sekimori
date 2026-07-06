// config.ts — sekimori.config.json の読込と検証
//
// 秘密情報は config に書かず環境変数で渡す設計（§2）。ここでの検証ルールに違反したら
// 起動を失敗させる（fail-closed）。

import { readFileSync } from "node:fs";
import type { ModelPricing } from "./budget.js";

export interface SekimoriConfig {
  port: number;
  upstream: {
    baseUrl: string;
    apiKeyEnv: string;
  };
  models: Record<string, ModelPricing>;
  budget: {
    monthlyUsd: number;
    defaultDailyPerTokenUsd: number;
  };
  rateLimit: {
    requestsPerMinute: number;
  };
  pinnedSystemPrompt: string | null;
  cors: {
    allowedOrigins: string[];
  };
  logging: {
    logBodies: boolean;
  };
  store: {
    type: "memory" | "file";
    path: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ファイルパスから config を読み込み、検証する。 */
export function loadConfigFromFile(path: string): SekimoriConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`config ファイルが読み込めません: ${path} (${(err as Error).message})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config ファイルが不正な JSON です: ${path} (${(err as Error).message})`);
  }

  return validateConfig(parsed);
}

/** 検証ルール（§2）。いずれかに違反すればエラーを投げて起動を止める。 */
export function validateConfig(input: unknown): SekimoriConfig {
  if (!isRecord(input)) {
    throw new ConfigError("config はオブジェクトである必要があります");
  }

  const port = typeof input.port === "number" ? input.port : 8787;

  if (!isRecord(input.upstream) || typeof input.upstream.baseUrl !== "string" || typeof input.upstream.apiKeyEnv !== "string") {
    throw new ConfigError("upstream.baseUrl と upstream.apiKeyEnv は必須です");
  }
  const upstream = {
    baseUrl: input.upstream.baseUrl,
    apiKeyEnv: input.upstream.apiKeyEnv,
  };

  if (!isRecord(input.models) || Object.keys(input.models).length === 0) {
    throw new ConfigError("models は空にできません（許可リスト兼価格表）");
  }
  const models: Record<string, ModelPricing> = {};
  for (const [modelName, priceRaw] of Object.entries(input.models)) {
    if (!isRecord(priceRaw)) {
      throw new ConfigError(`models.${modelName} の価格設定が不正です`);
    }
    const inputPerMTok = priceRaw.inputPerMTok;
    const outputPerMTok = priceRaw.outputPerMTok;
    if (typeof inputPerMTok !== "number" || !(inputPerMTok > 0) || typeof outputPerMTok !== "number" || !(outputPerMTok > 0)) {
      throw new ConfigError(`models.${modelName} の inputPerMTok / outputPerMTok は正の数である必要があります`);
    }
    models[modelName] = { inputPerMTok, outputPerMTok };
  }

  if (!isRecord(input.budget) || typeof input.budget.monthlyUsd !== "number" || !(input.budget.monthlyUsd > 0)) {
    throw new ConfigError("budget.monthlyUsd は正の数である必要があります");
  }
  const defaultDailyPerTokenUsd =
    typeof input.budget.defaultDailyPerTokenUsd === "number" ? input.budget.defaultDailyPerTokenUsd : 0.5;
  if (!(defaultDailyPerTokenUsd > 0)) {
    throw new ConfigError("budget.defaultDailyPerTokenUsd は正の数である必要があります");
  }
  const budget = { monthlyUsd: input.budget.monthlyUsd, defaultDailyPerTokenUsd };

  const rateLimitRaw = isRecord(input.rateLimit) ? input.rateLimit : undefined;
  const requestsPerMinute = typeof rateLimitRaw?.requestsPerMinute === "number" ? rateLimitRaw.requestsPerMinute : 10;
  if (!(requestsPerMinute > 0)) {
    throw new ConfigError("rateLimit.requestsPerMinute は正の数である必要があります");
  }
  const rateLimit = { requestsPerMinute };

  const pinnedSystemPrompt = typeof input.pinnedSystemPrompt === "string" ? input.pinnedSystemPrompt : null;

  const corsRaw = isRecord(input.cors) ? input.cors : undefined;
  const allowedOrigins = Array.isArray(corsRaw?.allowedOrigins)
    ? corsRaw.allowedOrigins.filter((o): o is string => typeof o === "string")
    : [];
  const cors = { allowedOrigins };

  const loggingRaw = isRecord(input.logging) ? input.logging : undefined;
  const logBodies = typeof loggingRaw?.logBodies === "boolean" ? loggingRaw.logBodies : false;
  const logging = { logBodies };

  const storeRaw = isRecord(input.store) ? input.store : undefined;
  const rawStoreType = storeRaw?.type;
  let storeType: "memory" | "file";
  if (rawStoreType === "memory" || rawStoreType === "file") {
    storeType = rawStoreType;
  } else {
    throw new ConfigError('store.type は "memory" または "file" である必要があります');
  }
  const storePath = typeof storeRaw?.path === "string" ? storeRaw.path : ".sekimori/state.json";
  const store = { type: storeType, path: storePath };

  if (!process.env[upstream.apiKeyEnv]) {
    throw new ConfigError(`環境変数 "${upstream.apiKeyEnv}"（upstream.apiKeyEnv で指定）が未設定です`);
  }

  if (!process.env.SEKIMORI_ADMIN_KEY) {
    throw new ConfigError("環境変数 SEKIMORI_ADMIN_KEY が未設定です");
  }

  return { port, upstream, models, budget, rateLimit, pinnedSystemPrompt, cors, logging, store };
}
