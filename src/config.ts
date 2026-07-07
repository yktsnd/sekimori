// config.ts - loading and validating sekimori.config.json
//
// Secrets are never written to config; they are passed via environment
// variables by design (section 2). Any violation of the validation rules here
// fails startup (fail-closed).

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

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Reads and validates config from a file path. */
export function loadConfigFromFile(path: string): SekimoriConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      // A-2: when someone starts sekimori without setting up a config file,
      // point them at how to copy the example and the relevant README
      // section instead of leaving them with a bare I/O error.
      throw new ConfigError(
        [
          `config file not found: ${path}`,
          "",
          "  Create one with:",
          `    cp sekimori.config.example.json ${path}`,
          "    (then edit upstream.baseUrl / models pricing etc. for your setup)",
          "",
          "  See the \"Quickstart\" section of README.md for details.",
        ].join("\n"),
      );
    }
    throw new ConfigError(`could not read config file: ${path} (${(err as Error).message})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config file contains invalid JSON: ${path} (${(err as Error).message})`);
  }

  return validateConfig(parsed);
}

/** Validation rules (section 2). Any violation throws and stops startup. */
export function validateConfig(input: unknown): SekimoriConfig {
  if (!isRecord(input)) {
    throw new ConfigError("config must be an object");
  }

  const port = typeof input.port === "number" ? input.port : 8787;

  if (!isRecord(input.upstream) || typeof input.upstream.baseUrl !== "string" || typeof input.upstream.apiKeyEnv !== "string") {
    throw new ConfigError("upstream.baseUrl and upstream.apiKeyEnv are required");
  }
  const upstream = {
    baseUrl: input.upstream.baseUrl,
    apiKeyEnv: input.upstream.apiKeyEnv,
  };

  if (!isRecord(input.models) || Object.keys(input.models).length === 0) {
    throw new ConfigError("models cannot be empty (it doubles as the allow list and price table)");
  }
  const models: Record<string, ModelPricing> = {};
  for (const [modelName, priceRaw] of Object.entries(input.models)) {
    if (!isRecord(priceRaw)) {
      throw new ConfigError(`invalid pricing for models.${modelName}`);
    }
    const inputPerMTok = priceRaw.inputPerMTok;
    const outputPerMTok = priceRaw.outputPerMTok;
    if (typeof inputPerMTok !== "number" || !(inputPerMTok > 0) || typeof outputPerMTok !== "number" || !(outputPerMTok > 0)) {
      throw new ConfigError(`models.${modelName}.inputPerMTok / outputPerMTok must be positive numbers`);
    }
    models[modelName] = { inputPerMTok, outputPerMTok };
  }

  if (!isRecord(input.budget) || typeof input.budget.monthlyUsd !== "number" || !(input.budget.monthlyUsd > 0)) {
    throw new ConfigError("budget.monthlyUsd must be a positive number");
  }
  const defaultDailyPerTokenUsd =
    typeof input.budget.defaultDailyPerTokenUsd === "number" ? input.budget.defaultDailyPerTokenUsd : 0.5;
  if (!(defaultDailyPerTokenUsd > 0)) {
    throw new ConfigError("budget.defaultDailyPerTokenUsd must be a positive number");
  }
  const budget = { monthlyUsd: input.budget.monthlyUsd, defaultDailyPerTokenUsd };

  const rateLimitRaw = isRecord(input.rateLimit) ? input.rateLimit : undefined;
  const requestsPerMinute = typeof rateLimitRaw?.requestsPerMinute === "number" ? rateLimitRaw.requestsPerMinute : 10;
  if (!(requestsPerMinute > 0)) {
    throw new ConfigError("rateLimit.requestsPerMinute must be a positive number");
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
    throw new ConfigError('store.type must be "memory" or "file"');
  }
  const storePath = typeof storeRaw?.path === "string" ? storeRaw.path : ".sekimori/state.json";
  const store = { type: storeType, path: storePath };

  if (!process.env[upstream.apiKeyEnv]) {
    throw new ConfigError(`environment variable "${upstream.apiKeyEnv}" (named by upstream.apiKeyEnv) is not set`);
  }

  if (!process.env.SEKIMORI_ADMIN_KEY) {
    throw new ConfigError("environment variable SEKIMORI_ADMIN_KEY is not set");
  }

  return { port, upstream, models, budget, rateLimit, pinnedSystemPrompt, cors, logging, store };
}
