// config.ts - loading and validating sekimori.config.json
//
// Secrets are never written to config; they are passed via environment
// variables by design (section 2). Any violation of the validation rules here
// fails startup (fail-closed).

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { MAX_USD_AMOUNT, type ModelPricing } from "./budget.js";
import { MAX_REQUESTS_PER_MINUTE } from "./ratelimit.js";

export interface SekimoriConfig {
  port: number;
  /** Loopback by default. Explicitly opt in to 0.0.0.0/:: for a reverse proxy or platform. */
  listenHost: string;
  upstream: {
    baseUrl: string;
    apiKeyEnv: string;
    /** Maximum time to wait for upstream response headers, and separately for a complete non-streaming body. */
    timeoutMs: number;
    /** "anthropic" (default) speaks the Anthropic Messages API directly;
     * "bedrock" sends Bearer-authenticated requests to Amazon Bedrock's
     * InvokeModel endpoint with the documented body transform (see
     * proxy.ts). Always resolved here - defaults to "anthropic" when
     * omitted from the config file, so downstream code never has to
     * treat it as optional. */
    type: "anthropic" | "bedrock";
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

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_USD_AMOUNT;
}

function assertOnlyKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${path} contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.sort().join(", ")}`);
  }
}

const TOP_LEVEL_KEYS = new Set([
  "port",
  "listenHost",
  "upstream",
  "models",
  "budget",
  "rateLimit",
  "pinnedSystemPrompt",
  "cors",
  "logging",
  "store",
]);
const UPSTREAM_KEYS = new Set(["baseUrl", "apiKeyEnv", "timeoutMs", "type"]);
const MODEL_PRICE_KEYS = new Set(["inputPerMTok", "outputPerMTok"]);
const BUDGET_KEYS = new Set(["monthlyUsd", "defaultDailyPerTokenUsd"]);
const RATE_LIMIT_KEYS = new Set(["requestsPerMinute"]);
const CORS_KEYS = new Set(["allowedOrigins"]);
const LOGGING_KEYS = new Set(["logBodies"]);
const STORE_KEYS = new Set(["type", "path"]);

function isValidEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isVisibleAsciiSecret(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (unbracketed === "localhost" || unbracketed === "::1") return true;
  return isIP(unbracketed) === 4 && unbracketed.startsWith("127.");
}

function requireHttpsExceptLoopback(url: URL, field: string): void {
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new ConfigError(`${field} must use https except for localhost or a literal loopback address`);
  }
}

/** Validates and canonicalizes the configured upstream base URL. */
export function normalizeUpstreamBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("upstream.baseUrl must be an absolute http(s) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new ConfigError("upstream.baseUrl must be an http(s) URL without credentials, query, or fragment");
  }
  requireHttpsExceptLoopback(url, "upstream.baseUrl");
  return url.toString().replace(/\/+$/, "");
}

/** Validates one exact browser origin for the CORS allow list. */
export function validateCorsOrigin(value: unknown): string {
  if (typeof value !== "string" || value === "*") throw new ConfigError("cors.allowedOrigins entries must be exact http(s) origins (not \"*\")");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("cors.allowedOrigins entries must be exact http(s) origins");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw new ConfigError("cors.allowedOrigins entries must be exact http(s) origins");
  }
  requireHttpsExceptLoopback(url, "cors.allowedOrigins entries");
  return value;
}

/** Only literal IP addresses and localhost are accepted as listen hosts. */
export function validateListenHost(value: unknown): string {
  if (typeof value !== "string" || (value !== "localhost" && isIP(value) === 0)) {
    throw new ConfigError('listenHost must be "localhost" or a literal IPv4/IPv6 address');
  }
  return value;
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

  return validateConfig(parsed, { configDirectory: dirname(resolve(path)) });
}

/** Validation rules (section 2). Any violation throws and stops startup. */
export function validateConfig(input: unknown, options: { configDirectory?: string } = {}): SekimoriConfig {
  if (!isRecord(input)) {
    throw new ConfigError("config must be an object");
  }
  assertOnlyKnownKeys(input, TOP_LEVEL_KEYS, "config");

  const port = input.port === undefined ? 8787 : input.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("port must be an integer from 1 through 65535");
  }

  const listenHost = validateListenHost(input.listenHost === undefined ? "127.0.0.1" : input.listenHost);

  if (!isRecord(input.upstream) || typeof input.upstream.baseUrl !== "string" || typeof input.upstream.apiKeyEnv !== "string") {
    throw new ConfigError("upstream.baseUrl and upstream.apiKeyEnv are required");
  }
  assertOnlyKnownKeys(input.upstream, UPSTREAM_KEYS, "upstream");
  if (!isValidEnvironmentVariableName(input.upstream.apiKeyEnv)) {
    throw new ConfigError("upstream.apiKeyEnv must be a valid environment variable name");
  }
  if (input.upstream.apiKeyEnv === "SEKIMORI_ADMIN_KEY") {
    throw new ConfigError("upstream.apiKeyEnv must not be SEKIMORI_ADMIN_KEY (the provider key and admin key must be separate)");
  }
  const rawUpstreamType = input.upstream.type;
  let upstreamType: "anthropic" | "bedrock";
  if (rawUpstreamType === undefined) {
    upstreamType = "anthropic";
  } else if (rawUpstreamType === "anthropic" || rawUpstreamType === "bedrock") {
    upstreamType = rawUpstreamType;
  } else {
    throw new ConfigError('upstream.type must be "anthropic" or "bedrock"');
  }
  const timeoutMs = input.upstream.timeoutMs === undefined ? 120_000 : input.upstream.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) {
    throw new ConfigError("upstream.timeoutMs must be an integer from 1000 through 900000");
  }
  const upstream = {
    baseUrl: normalizeUpstreamBaseUrl(input.upstream.baseUrl),
    apiKeyEnv: input.upstream.apiKeyEnv,
    timeoutMs,
    type: upstreamType,
  };

  if (!isRecord(input.models) || Object.keys(input.models).length === 0) {
    throw new ConfigError("models cannot be empty (it doubles as the allow list and price table)");
  }
  const models = Object.create(null) as Record<string, ModelPricing>;
  for (const [modelName, priceRaw] of Object.entries(input.models)) {
    if (modelName.length === 0 || !isRecord(priceRaw)) {
      throw new ConfigError(`invalid pricing for models.${modelName}`);
    }
    assertOnlyKnownKeys(priceRaw, MODEL_PRICE_KEYS, `models.${modelName}`);
    const inputPerMTok = priceRaw.inputPerMTok;
    const outputPerMTok = priceRaw.outputPerMTok;
    if (!isFinitePositiveNumber(inputPerMTok) || !isFinitePositiveNumber(outputPerMTok)) {
      throw new ConfigError(
        `models.${modelName}.inputPerMTok / outputPerMTok must be positive numbers no greater than ${MAX_USD_AMOUNT}`,
      );
    }
    models[modelName] = { inputPerMTok, outputPerMTok };
  }

  if (!isRecord(input.budget) || !isFinitePositiveNumber(input.budget.monthlyUsd)) {
    throw new ConfigError(`budget.monthlyUsd must be a positive number no greater than ${MAX_USD_AMOUNT}`);
  }
  assertOnlyKnownKeys(input.budget, BUDGET_KEYS, "budget");
  const defaultDailyPerTokenUsd = input.budget.defaultDailyPerTokenUsd === undefined ? 0.5 : input.budget.defaultDailyPerTokenUsd;
  if (!isFinitePositiveNumber(defaultDailyPerTokenUsd)) {
    throw new ConfigError(`budget.defaultDailyPerTokenUsd must be a positive number no greater than ${MAX_USD_AMOUNT}`);
  }
  const budget = { monthlyUsd: input.budget.monthlyUsd, defaultDailyPerTokenUsd };

  if (input.rateLimit !== undefined && !isRecord(input.rateLimit)) {
    throw new ConfigError("rateLimit must be an object when provided");
  }
  const rateLimitRaw = input.rateLimit as Record<string, unknown> | undefined;
  if (rateLimitRaw) assertOnlyKnownKeys(rateLimitRaw, RATE_LIMIT_KEYS, "rateLimit");
  const requestsPerMinute = rateLimitRaw?.requestsPerMinute === undefined ? 10 : rateLimitRaw.requestsPerMinute;
  if (
    typeof requestsPerMinute !== "number" ||
    !Number.isSafeInteger(requestsPerMinute) ||
    requestsPerMinute <= 0 ||
    requestsPerMinute > MAX_REQUESTS_PER_MINUTE
  ) {
    throw new ConfigError(`rateLimit.requestsPerMinute must be an integer from 1 through ${MAX_REQUESTS_PER_MINUTE}`);
  }
  const rateLimit = { requestsPerMinute };

  const pinnedSystemPrompt = input.pinnedSystemPrompt === undefined ? null : input.pinnedSystemPrompt;
  if (pinnedSystemPrompt !== null && typeof pinnedSystemPrompt !== "string") {
    throw new ConfigError("pinnedSystemPrompt must be a string or null");
  }

  if (input.cors !== undefined && !isRecord(input.cors)) {
    throw new ConfigError("cors must be an object when provided");
  }
  const corsRaw = input.cors as Record<string, unknown> | undefined;
  if (corsRaw) assertOnlyKnownKeys(corsRaw, CORS_KEYS, "cors");
  const allowedOriginsRaw = corsRaw?.allowedOrigins === undefined ? [] : corsRaw.allowedOrigins;
  if (!Array.isArray(allowedOriginsRaw)) throw new ConfigError("cors.allowedOrigins must be an array");
  const allowedOrigins = allowedOriginsRaw.map(validateCorsOrigin);
  const cors = { allowedOrigins };

  if (input.logging !== undefined && !isRecord(input.logging)) {
    throw new ConfigError("logging must be an object when provided");
  }
  const loggingRaw = input.logging as Record<string, unknown> | undefined;
  if (loggingRaw) assertOnlyKnownKeys(loggingRaw, LOGGING_KEYS, "logging");
  const logBodies = loggingRaw?.logBodies === undefined ? false : loggingRaw.logBodies;
  if (typeof logBodies !== "boolean") throw new ConfigError("logging.logBodies must be a boolean");
  const logging = { logBodies };

  const storeRaw = isRecord(input.store) ? input.store : undefined;
  if (storeRaw) assertOnlyKnownKeys(storeRaw, STORE_KEYS, "store");
  const rawStoreType = storeRaw?.type;
  let storeType: "memory" | "file";
  if (rawStoreType === "memory" || rawStoreType === "file") {
    storeType = rawStoreType;
  } else {
    throw new ConfigError('store.type must be "memory" or "file"');
  }
  const storePath = storeRaw?.path === undefined ? ".sekimori/state.json" : storeRaw.path;
  if (typeof storePath !== "string" || (storeType === "file" && storePath.trim().length === 0)) {
    throw new ConfigError("store.path must be a non-empty string for a file store");
  }
  const resolvedStorePath =
    storeType === "file" && options.configDirectory !== undefined ? resolve(options.configDirectory, storePath) : storePath;
  const store = { type: storeType, path: resolvedStorePath };

  const upstreamApiKeyRaw = process.env[upstream.apiKeyEnv];
  if (!upstreamApiKeyRaw || upstreamApiKeyRaw.trim().length === 0) {
    throw new ConfigError(`environment variable "${upstream.apiKeyEnv}" (named by upstream.apiKeyEnv) is not set`);
  }
  if (!isVisibleAsciiSecret(upstreamApiKeyRaw)) {
    throw new ConfigError(`environment variable "${upstream.apiKeyEnv}" must contain visible ASCII characters only`);
  }

  const adminKeyRaw = process.env.SEKIMORI_ADMIN_KEY;
  if (!adminKeyRaw || adminKeyRaw.trim().length === 0) {
    throw new ConfigError("environment variable SEKIMORI_ADMIN_KEY is not set");
  }
  if (!isVisibleAsciiSecret(adminKeyRaw)) {
    throw new ConfigError("environment variable SEKIMORI_ADMIN_KEY must contain visible ASCII characters only");
  }
  if (adminKeyRaw.length < 32) {
    throw new ConfigError("environment variable SEKIMORI_ADMIN_KEY must be at least 32 visible ASCII characters");
  }
  if (upstreamApiKeyRaw === adminKeyRaw) {
    throw new ConfigError("the upstream API key and SEKIMORI_ADMIN_KEY must have different values");
  }

  return { port, listenHost, upstream, models, budget, rateLimit, pinnedSystemPrompt, cors, logging, store };
}
