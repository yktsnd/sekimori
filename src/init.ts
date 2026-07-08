// init.ts - `sekimori init`: interactive config generator (issue #7).
//
// Goal: the first five minutes of using sekimori must not involve
// hand-editing JSON. This module builds a sekimori.config.json interactively
// (or non-interactively with --yes), and never writes anything that
// config.ts's validateConfig would reject (fail-closed, same as everywhere
// else in this project - see docs/design.md).
//
// Zero new dependencies: only node:readline/promises, node:fs, node:crypto
// (no third-party CLI/prompt library).

import { createInterface } from "node:readline/promises";
import { existsSync, writeFileSync } from "node:fs";
import { validateConfig, type SekimoriConfig } from "./config.js";
import type { ModelPricing } from "./budget.js";

/** The env var name sekimori.config.example.json also uses. Not prompted for
 * directly (see report / CHANGELOG): its value is derived from
 * upstream.type instead of asked as its own question - Anthropic direct
 * almost always reads ANTHROPIC_API_KEY, Bedrock's Bearer API keys (issue
 * #17) are conventionally read from AWS_BEARER_TOKEN_BEDROCK. */
const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const BEDROCK_API_KEY_ENV = "AWS_BEARER_TOKEN_BEDROCK";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** us-east-1 bedrock-runtime endpoint; region/inference-profile prefixes
 * vary by account - see docs/configuration.md, "Using Amazon Bedrock". */
const BEDROCK_DEFAULT_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";

/** Default model + reference pricing, matching sekimori.config.example.json.
 * The Bedrock default is the equivalent model as a Bedrock-style
 * inference-profile id, same reference prices. */
const ANTHROPIC_DEFAULT_MODEL_NAME = "claude-haiku-4-5-20251001";
const BEDROCK_DEFAULT_MODEL_NAME = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_MODEL_PRICING: ModelPricing = { inputPerMTok: 1.0, outputPerMTok: 5.0 };

type UpstreamType = "anthropic" | "bedrock";

function defaultBaseUrlFor(upstreamType: UpstreamType): string {
  return upstreamType === "bedrock" ? BEDROCK_DEFAULT_BASE_URL : ANTHROPIC_DEFAULT_BASE_URL;
}

function defaultApiKeyEnvFor(upstreamType: UpstreamType): string {
  return upstreamType === "bedrock" ? BEDROCK_API_KEY_ENV : ANTHROPIC_API_KEY_ENV;
}

function defaultModelNameFor(upstreamType: UpstreamType): string {
  return upstreamType === "bedrock" ? BEDROCK_DEFAULT_MODEL_NAME : ANTHROPIC_DEFAULT_MODEL_NAME;
}

export interface InitIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Whether `input` is an interactive TTY. Passed explicitly (rather than
   * read from process.stdin internally) so tests can drive the interactive
   * prompt flow with a plain in-memory stream. */
  isTTY: boolean;
}

/** Per-setting overrides parsed from CLI flags (issue #13). Every field is
 * optional: `undefined` means "no flag given for this setting", so the
 * caller (defaults for --yes, or the interactive prompt loop) knows exactly
 * which settings still need a value. `models` and `corsOrigins` are only
 * set when the corresponding repeatable flag was given at least once -
 * when set, they REPLACE the default entirely (they don't merge with it). */
export interface InitFlagOverrides {
  port?: number;
  upstreamType?: UpstreamType;
  upstreamUrl?: string;
  models?: Record<string, ModelPricing>;
  monthlyUsd?: number;
  dailyUsd?: number;
  rateLimit?: number;
  storeType?: "file" | "memory";
  storePath?: string;
  corsOrigins?: string[];
  pinnedSystem?: string;
}

export interface ParsedInitArgs {
  path: string;
  force: boolean;
  yes: boolean;
  overrides: InitFlagOverrides;
}

export type ParseInitArgsResult = ParsedInitArgs | { error: string } | { help: true };

export const INIT_USAGE_LINE =
  "Usage: sekimori init [path] [--force] [--yes] [--help] [--port N] " +
  "[--upstream-type anthropic|bedrock] [--upstream-url URL] " +
  "[--model name=in,out]... [--monthly-usd N] [--daily-usd N] [--rate-limit N] " +
  "[--store file|memory] [--store-path PATH] [--cors-origin ORIGIN]... [--pinned-system TEXT]";

export const INIT_HELP_TEXT = `${INIT_USAGE_LINE}

Generates a sekimori.config.json - interactively (default), or fully
non-interactively with --yes. Every flag below overrides the corresponding
setting; in interactive mode a flagged setting is pre-answered (printed,
not prompted) and every other setting still prompts as usual. In
non-interactive mode (--yes) a flagged setting takes the flag's value and
every other setting takes its default.

Positional:
  path                    Where to write the config (default: ./sekimori.config.json)

Flags:
  --force
      Overwrite an existing file at path.
  --yes, -y
      Non-interactive: write defaults (or given flag values) without
      prompting. Also required when stdin is not a TTY.
  --help, -h
      Show this help and exit.
  --port N
      Listen port (default: 8787).
  --upstream-type anthropic|bedrock
      Upstream provider (default: anthropic). "bedrock" sends
      Bearer-authenticated requests to Amazon Bedrock's InvokeModel endpoint
      (issue #17; streaming is not yet supported there). Selecting bedrock
      changes the defaults for --upstream-url (Bedrock's bedrock-runtime
      endpoint), the model allow list (a Bedrock-style inference-profile
      id), and the env var read for the upstream key
      (AWS_BEARER_TOKEN_BEDROCK instead of ANTHROPIC_API_KEY) - see
      docs/configuration.md, "Using Amazon Bedrock".
  --upstream-url URL
      Upstream base URL (default: https://api.anthropic.com, or Bedrock's
      bedrock-runtime endpoint when --upstream-type bedrock is given).
  --model name=in,out
      Add a model to the allow list / price table (USD per MTok), e.g.
      --model claude-haiku-4-5-20251001=1,5. Repeatable; if given at least
      once, REPLACES the default model list entirely.
  --monthly-usd N
      Monthly budget cap in USD (default: 30).
  --daily-usd N
      Default per-token daily budget cap in USD (default: 0.5).
  --rate-limit N
      Requests per minute (default: 10).
  --store file|memory
      Store backend (default: file).
  --store-path PATH
      File store path (default: .sekimori/state.json). Rejected together
      with --store memory.
  --cors-origin ORIGIN
      Add an allowed CORS origin. Repeatable (default: none).
  --pinned-system TEXT
      Server-pinned system prompt (default: none / pass through the
      client's system field).

Examples:
  sekimori init --yes
  sekimori init --yes --port 3000 --model claude-haiku-4-5-20251001=1,5 \\
    --monthly-usd 10 --cors-origin https://example.com
  sekimori init ./my.config.json --force --store memory
  sekimori init --yes --upstream-type bedrock
`;

/** Parses `--model name=inputPerMTok,outputPerMTok`. Exported for tests. */
export function parseModelSpec(spec: string): { name: string; pricing: ModelPricing } | { error: string } {
  const usage = `expected name=inputPerMTok,outputPerMTok, e.g. claude-haiku-4-5-20251001=1,5`;
  const eq = spec.indexOf("=");
  if (eq <= 0) {
    return { error: `invalid --model value: "${spec}" (${usage})` };
  }
  const name = spec.slice(0, eq).trim();
  const parts = spec.slice(eq + 1).split(",");
  if (name === "" || parts.length !== 2) {
    return { error: `invalid --model value: "${spec}" (${usage})` };
  }
  const inputPerMTok = Number(parts[0].trim());
  const outputPerMTok = Number(parts[1].trim());
  if (!Number.isFinite(inputPerMTok) || !(inputPerMTok > 0) || !Number.isFinite(outputPerMTok) || !(outputPerMTok > 0)) {
    return { error: `invalid --model value: "${spec}" (prices must be positive numbers - ${usage})` };
  }
  return { name, pricing: { inputPerMTok, outputPerMTok } };
}

/** Parses `sekimori init [path] [--force] [--yes] [flags...]`. Validates
 * every flag value eagerly (fail-closed: an invalid flag must never reach
 * the point of writing a file), and returns `{ help: true }` if --help/-h
 * was given anywhere in `args` (checked upfront so --help always wins,
 * regardless of position or other flags being malformed). */
export function parseInitArgs(args: string[]): ParseInitArgsResult {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  let path: string | undefined;
  let force = false;
  let yes = false;
  let modelsGiven: Record<string, ModelPricing> | undefined;
  let corsGiven: string[] | undefined;
  let storeTypeGiven: "file" | "memory" | undefined;
  let storePathGiven: string | undefined;
  const overrides: InitFlagOverrides = {};

  const needsValue = new Set([
    "--port",
    "--upstream-type",
    "--upstream-url",
    "--model",
    "--monthly-usd",
    "--daily-usd",
    "--rate-limit",
    "--store",
    "--store-path",
    "--cors-origin",
    "--pinned-system",
  ]);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--force") {
      force = true;
      i += 1;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      i += 1;
      continue;
    }

    if (needsValue.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: `missing value for ${arg}` };
      }

      switch (arg) {
        case "--port": {
          const n = Number(value);
          if (!Number.isFinite(n) || !Number.isInteger(n) || !(n > 0) || n > 65535) {
            return { error: `invalid --port value: "${value}" (must be a positive integer <= 65535)` };
          }
          overrides.port = n;
          break;
        }
        case "--upstream-type": {
          if (value !== "anthropic" && value !== "bedrock") {
            return { error: `invalid --upstream-type value: "${value}" (must be "anthropic" or "bedrock")` };
          }
          overrides.upstreamType = value;
          break;
        }
        case "--upstream-url": {
          try {
            new URL(value);
          } catch {
            return { error: `invalid --upstream-url value: "${value}" (must be a valid URL)` };
          }
          overrides.upstreamUrl = value;
          break;
        }
        case "--model": {
          const parsed = parseModelSpec(value);
          if ("error" in parsed) return parsed;
          modelsGiven = { ...(modelsGiven ?? {}), [parsed.name]: parsed.pricing };
          break;
        }
        case "--monthly-usd": {
          const n = Number(value);
          if (!Number.isFinite(n) || !(n > 0)) {
            return { error: `invalid --monthly-usd value: "${value}" (must be a positive number)` };
          }
          overrides.monthlyUsd = n;
          break;
        }
        case "--daily-usd": {
          const n = Number(value);
          if (!Number.isFinite(n) || !(n > 0)) {
            return { error: `invalid --daily-usd value: "${value}" (must be a positive number)` };
          }
          overrides.dailyUsd = n;
          break;
        }
        case "--rate-limit": {
          const n = Number(value);
          if (!Number.isFinite(n) || !(n > 0)) {
            return { error: `invalid --rate-limit value: "${value}" (must be a positive number)` };
          }
          overrides.rateLimit = n;
          break;
        }
        case "--store": {
          if (value !== "file" && value !== "memory") {
            return { error: `invalid --store value: "${value}" (must be "file" or "memory")` };
          }
          storeTypeGiven = value;
          break;
        }
        case "--store-path": {
          storePathGiven = value;
          break;
        }
        case "--cors-origin": {
          corsGiven = [...(corsGiven ?? []), value];
          break;
        }
        case "--pinned-system": {
          overrides.pinnedSystem = value;
          break;
        }
      }

      i += 2;
      continue;
    }

    if (arg.startsWith("-")) {
      return { error: `unknown flag: ${arg}` };
    }
    if (path === undefined) {
      path = arg;
      i += 1;
      continue;
    }
    return { error: `unexpected extra argument: ${arg}` };
  }

  if (storePathGiven !== undefined && storeTypeGiven === "memory") {
    return { error: "--store-path cannot be combined with --store memory (pick one store backend)" };
  }
  if (storeTypeGiven !== undefined) overrides.storeType = storeTypeGiven;
  if (storePathGiven !== undefined) overrides.storePath = storePathGiven;
  if (modelsGiven !== undefined) overrides.models = modelsGiven;
  if (corsGiven !== undefined) overrides.corsOrigins = corsGiven;

  return { path: path ?? "./sekimori.config.json", force, yes, overrides };
}

interface Answers {
  port: number;
  upstreamType: UpstreamType;
  baseUrl: string;
  models: Record<string, ModelPricing>;
  monthlyUsd: number;
  defaultDailyPerTokenUsd: number;
  requestsPerMinute: number;
  storeType: "file" | "memory";
  storePath: string;
  corsOrigins: string[];
  pinnedSystemPrompt: string | null;
}

/** The set of answers `--yes` writes: sensible defaults, identical in shape
 * to sekimori.config.example.json when upstreamType is "anthropic" (the
 * overall default). Passing "bedrock" swaps baseUrl and the default model
 * entry to their Bedrock equivalents (issue #17) - see
 * defaultBaseUrlFor/defaultModelNameFor. */
function defaultAnswers(upstreamType: UpstreamType = "anthropic"): Answers {
  return {
    port: 8787,
    upstreamType,
    baseUrl: defaultBaseUrlFor(upstreamType),
    models: { [defaultModelNameFor(upstreamType)]: { ...DEFAULT_MODEL_PRICING } },
    monthlyUsd: 30,
    defaultDailyPerTokenUsd: 0.5,
    requestsPerMinute: 10,
    storeType: "file",
    storePath: ".sekimori/state.json",
    corsOrigins: [],
    pinnedSystemPrompt: null,
  };
}

/** Applies flag overrides on top of the defaults for the `--yes` (fully
 * non-interactive) path: unflagged settings keep their default, flagged
 * settings take the flag's value. `storePath` is only meaningful when the
 * resulting store type is "file" - buildConfigObject already blanks it out
 * for "memory", so no special-casing is needed here. `defaults` must
 * already have been computed with the resolved upstreamType (see
 * runInit/defaultAnswers) so that baseUrl/models default correctly. */
function applyOverrides(defaults: Answers, overrides: InitFlagOverrides): Answers {
  return {
    port: overrides.port ?? defaults.port,
    upstreamType: overrides.upstreamType ?? defaults.upstreamType,
    baseUrl: overrides.upstreamUrl ?? defaults.baseUrl,
    models: overrides.models ?? defaults.models,
    monthlyUsd: overrides.monthlyUsd ?? defaults.monthlyUsd,
    defaultDailyPerTokenUsd: overrides.dailyUsd ?? defaults.defaultDailyPerTokenUsd,
    requestsPerMinute: overrides.rateLimit ?? defaults.requestsPerMinute,
    storeType: overrides.storeType ?? defaults.storeType,
    storePath: overrides.storePath ?? defaults.storePath,
    corsOrigins: overrides.corsOrigins ?? defaults.corsOrigins,
    pinnedSystemPrompt: overrides.pinnedSystem !== undefined ? overrides.pinnedSystem : defaults.pinnedSystemPrompt,
  };
}

/** Builds the plain JSON object that will be written to disk from answers. */
function buildConfigObject(answers: Answers): Record<string, unknown> {
  return {
    port: answers.port,
    upstream: { baseUrl: answers.baseUrl, apiKeyEnv: defaultApiKeyEnvFor(answers.upstreamType), type: answers.upstreamType },
    models: answers.models,
    budget: { monthlyUsd: answers.monthlyUsd, defaultDailyPerTokenUsd: answers.defaultDailyPerTokenUsd },
    rateLimit: { requestsPerMinute: answers.requestsPerMinute },
    pinnedSystemPrompt: answers.pinnedSystemPrompt,
    cors: { allowedOrigins: answers.corsOrigins },
    logging: { logBodies: false },
    store: { type: answers.storeType, path: answers.storeType === "file" ? answers.storePath : "" },
  };
}

type Rl = ReturnType<typeof createInterface>;

async function promptString(rl: Rl, question: string, def: string): Promise<string> {
  const raw = await rl.question(`${question} [${def}]: `);
  const trimmed = raw.trim();
  return trimmed === "" ? def : trimmed;
}

async function promptPositiveNumber(
  rl: Rl,
  output: NodeJS.WritableStream,
  question: string,
  def: number,
  opts: { integer?: boolean; max?: number } = {},
): Promise<number> {
  for (;;) {
    const raw = (await rl.question(`${question} [${def}]: `)).trim();
    const text = raw === "" ? String(def) : raw;
    const n = Number(text);
    if (!Number.isFinite(n) || !(n > 0) || (opts.integer === true && !Number.isInteger(n))) {
      output.write(`  invalid value "${raw}" - must be a positive${opts.integer ? " integer" : " number"}\n`);
      continue;
    }
    if (opts.max !== undefined && n > opts.max) {
      output.write(`  invalid value "${raw}" - must be <= ${opts.max}\n`);
      continue;
    }
    return n;
  }
}

async function promptUrl(rl: Rl, output: NodeJS.WritableStream, question: string, def: string): Promise<string> {
  for (;;) {
    const raw = (await rl.question(`${question} [${def}]: `)).trim();
    const value = raw === "" ? def : raw;
    try {
      new URL(value);
      return value;
    } catch {
      output.write(`  invalid URL: "${value}"\n`);
    }
  }
}

async function promptChoice(
  rl: Rl,
  output: NodeJS.WritableStream,
  question: string,
  def: string,
  choices: readonly string[],
): Promise<string> {
  for (;;) {
    const raw = (await rl.question(`${question} [${def}]: `)).trim().toLowerCase();
    const value = raw === "" ? def : raw;
    if (choices.includes(value)) return value;
    output.write(`  invalid choice "${raw}" - must be one of: ${choices.join(", ")}\n`);
  }
}

async function promptYesNo(rl: Rl, output: NodeJS.WritableStream, question: string, def: boolean): Promise<boolean> {
  const defLabel = def ? "Y/n" : "y/N";
  for (;;) {
    const raw = (await rl.question(`${question} [${defLabel}]: `)).trim().toLowerCase();
    if (raw === "") return def;
    if (raw === "y" || raw === "yes") return true;
    if (raw === "n" || raw === "no") return false;
    output.write('  please answer "y" or "n"\n');
  }
}

async function promptModels(
  rl: Rl,
  output: NodeJS.WritableStream,
  upstreamType: UpstreamType,
): Promise<Record<string, ModelPricing>> {
  const defaultModelName = defaultModelNameFor(upstreamType);
  output.write("\nModel allow list (also the price table used for budget accounting).\n");
  output.write(
    "NOTE: the prices below (including the default model's) are REFERENCE VALUES shipped with sekimori -" +
      " verify them against the provider's current pricing before relying on them for budget accuracy" +
      " (see docs/configuration.md, \"Notes on prices\").\n\n",
  );

  const models: Record<string, ModelPricing> = {};

  const includeDefault = await promptYesNo(
    rl,
    output,
    `Include the default model "${defaultModelName}" (reference price: input $${DEFAULT_MODEL_PRICING.inputPerMTok}/MTok, output $${DEFAULT_MODEL_PRICING.outputPerMTok}/MTok)?`,
    true,
  );
  if (includeDefault) {
    const inputPerMTok = await promptPositiveNumber(
      rl,
      output,
      `  input price USD/MTok for ${defaultModelName}`,
      DEFAULT_MODEL_PRICING.inputPerMTok,
    );
    const outputPerMTok = await promptPositiveNumber(
      rl,
      output,
      `  output price USD/MTok for ${defaultModelName}`,
      DEFAULT_MODEL_PRICING.outputPerMTok,
    );
    models[defaultModelName] = { inputPerMTok, outputPerMTok };
  }

  for (;;) {
    const name = (await rl.question("Add another model (name, empty to finish): ")).trim();
    if (name === "") break;
    const inputPerMTok = await promptPositiveNumber(rl, output, `  input price USD/MTok for ${name}`, 1.0);
    const outputPerMTok = await promptPositiveNumber(rl, output, `  output price USD/MTok for ${name}`, 5.0);
    models[name] = { inputPerMTok, outputPerMTok };
  }

  if (Object.keys(models).length === 0) {
    // Fail-closed: models is the allow list, and validateConfig rejects an
    // empty one. Rather than loop the user forever, fall back to the
    // default model so init always produces a config that starts.
    output.write(`  (at least one model is required - adding the default model "${defaultModelName}")\n`);
    models[defaultModelName] = { ...DEFAULT_MODEL_PRICING };
  }

  return models;
}

/** Prints a one-line acknowledgment for a setting that was pre-answered by a
 * flag in interactive mode, instead of prompting for it (issue #13). */
function ack(output: NodeJS.WritableStream, label: string, value: string, flag: string): void {
  output.write(`${label}: ${value} (from ${flag})\n`);
}

async function promptAll(rl: Rl, output: NodeJS.WritableStream, overrides: InitFlagOverrides): Promise<Answers> {
  let port: number;
  if (overrides.port !== undefined) {
    port = overrides.port;
    ack(output, "port", String(port), "--port");
  } else {
    port = await promptPositiveNumber(rl, output, "port", defaultAnswers().port, { integer: true, max: 65535 });
  }

  // Upstream type is asked right before (and determines the default for)
  // the upstream base URL question (issue #17). Once resolved, recompute
  // defaults so baseUrl/models below offer the right provider's defaults.
  let upstreamType: UpstreamType;
  if (overrides.upstreamType !== undefined) {
    upstreamType = overrides.upstreamType;
    ack(output, "upstream type", upstreamType, "--upstream-type");
  } else {
    upstreamType = (await promptChoice(rl, output, "upstream type: anthropic or bedrock", "anthropic", [
      "anthropic",
      "bedrock",
    ])) as UpstreamType;
  }
  const defaults = defaultAnswers(upstreamType);

  let baseUrl: string;
  if (overrides.upstreamUrl !== undefined) {
    baseUrl = overrides.upstreamUrl;
    ack(output, "upstream base URL", baseUrl, "--upstream-url");
  } else {
    baseUrl = await promptUrl(rl, output, "upstream base URL", defaults.baseUrl);
  }

  let models: Record<string, ModelPricing>;
  if (overrides.models !== undefined) {
    models = overrides.models;
    ack(output, "models", Object.keys(models).join(", "), "--model");
  } else {
    models = await promptModels(rl, output, upstreamType);
  }

  let monthlyUsd: number;
  if (overrides.monthlyUsd !== undefined) {
    monthlyUsd = overrides.monthlyUsd;
    ack(output, "monthly budget USD", String(monthlyUsd), "--monthly-usd");
  } else {
    monthlyUsd = await promptPositiveNumber(rl, output, "monthly budget USD", defaults.monthlyUsd);
  }

  let defaultDailyPerTokenUsd: number;
  if (overrides.dailyUsd !== undefined) {
    defaultDailyPerTokenUsd = overrides.dailyUsd;
    ack(output, "default per-token daily budget USD", String(defaultDailyPerTokenUsd), "--daily-usd");
  } else {
    defaultDailyPerTokenUsd = await promptPositiveNumber(
      rl,
      output,
      "default per-token daily budget USD",
      defaults.defaultDailyPerTokenUsd,
    );
  }

  let requestsPerMinute: number;
  if (overrides.rateLimit !== undefined) {
    requestsPerMinute = overrides.rateLimit;
    ack(output, "rate limit requests/minute", String(requestsPerMinute), "--rate-limit");
  } else {
    requestsPerMinute = await promptPositiveNumber(
      rl,
      output,
      "rate limit requests/minute",
      defaults.requestsPerMinute,
      { integer: true },
    );
  }

  let storeType: "file" | "memory";
  if (overrides.storeType !== undefined) {
    storeType = overrides.storeType;
    ack(output, "store", storeType, "--store");
  } else {
    storeType = (await promptChoice(rl, output, "store: file or memory", defaults.storeType, [
      "file",
      "memory",
    ])) as "file" | "memory";
  }

  let storePath: string;
  if (storeType === "file") {
    if (overrides.storePath !== undefined) {
      storePath = overrides.storePath;
      ack(output, "store file path", storePath, "--store-path");
    } else {
      storePath = await promptString(rl, "  store file path", defaults.storePath);
    }
  } else {
    storePath = "";
  }

  let corsOrigins: string[];
  if (overrides.corsOrigins !== undefined) {
    corsOrigins = overrides.corsOrigins;
    ack(output, "CORS allowed origins", corsOrigins.join(", "), "--cors-origin");
  } else {
    const corsRaw = await promptString(rl, "CORS allowed origins (comma-separated, empty = none)", "");
    corsOrigins = corsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  let pinnedSystemPrompt: string | null;
  if (overrides.pinnedSystem !== undefined) {
    pinnedSystemPrompt = overrides.pinnedSystem === "" ? null : overrides.pinnedSystem;
    ack(output, "pinned system prompt", JSON.stringify(pinnedSystemPrompt), "--pinned-system");
  } else {
    const pinnedRaw = await promptString(
      rl,
      "pinned system prompt (empty = null / pass through client's system field)",
      "",
    );
    pinnedSystemPrompt = pinnedRaw === "" ? null : pinnedRaw;
  }

  return {
    port,
    upstreamType,
    baseUrl,
    models,
    monthlyUsd,
    defaultDailyPerTokenUsd,
    requestsPerMinute,
    storeType,
    storePath,
    corsOrigins,
    pinnedSystemPrompt,
  };
}

/**
 * Runs the generated config object through the *real* validateConfig, so
 * init can never write a config that startup would then reject.
 *
 * validateConfig also checks that the upstream API key env var and
 * SEKIMORI_ADMIN_KEY are actually *set* in process.env (by design - startup
 * fails closed if a secret is missing). Generating a config file ahead of
 * time must not require the operator to already have the real secret
 * exported in their shell, so this temporarily sets placeholder values for
 * whichever of those two are not already present, runs the real
 * validateConfig (exercising every other rule unchanged), and restores
 * process.env exactly as it was afterwards - including deleting the
 * placeholder if the var was unset before. Every other validation rule
 * (models non-empty, positive prices, budget/rateLimit positivity, store
 * type, ...) runs for real, unmodified.
 */
function validateGeneratedConfig(configObject: Record<string, unknown>, apiKeyEnv: string): SekimoriConfig {
  const hadApiKey = apiKeyEnv in process.env;
  const hadAdminKey = "SEKIMORI_ADMIN_KEY" in process.env;
  const savedApiKey = process.env[apiKeyEnv];
  const savedAdminKey = process.env.SEKIMORI_ADMIN_KEY;

  if (!hadApiKey) process.env[apiKeyEnv] = "sekimori-init-placeholder";
  if (!hadAdminKey) process.env.SEKIMORI_ADMIN_KEY = "sekimori-init-placeholder";

  try {
    return validateConfig(configObject);
  } finally {
    if (hadApiKey) process.env[apiKeyEnv] = savedApiKey;
    else delete process.env[apiKeyEnv];
    if (hadAdminKey) process.env.SEKIMORI_ADMIN_KEY = savedAdminKey;
    else delete process.env.SEKIMORI_ADMIN_KEY;
  }
}

function printNextSteps(output: NodeJS.WritableStream, path: string, apiKeyEnv: string): void {
  const keyExportLine =
    apiKeyEnv === BEDROCK_API_KEY_ENV
      ? `       export ${apiKeyEnv}=<your Bedrock API key>   # see docs/configuration.md, "Using Amazon Bedrock"`
      : `       export ${apiKeyEnv}=sk-ant-...      # your real upstream API key`;
  output.write(
    [
      "",
      `[sekimori init] wrote ${path}`,
      "",
      "Next steps:",
      "  1. Generate an admin key:",
      '       node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
      "     (or with openssl: openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')",
      "",
      "  2. Export the required environment variables (never written to the config file):",
      keyExportLine,
      "       export SEKIMORI_ADMIN_KEY=<the admin key from step 1>",
      "",
      "  3. Start sekimori:",
      "       # from a clone:",
      `       npx tsx src/main.ts ${path}`,
      "       # from an installed package:",
      `       npx sekimori ${path}`,
      "",
      "See docs/configuration.md for every config key and its default.",
      "",
    ].join("\n"),
  );
}

/** Entry point called from main.ts's `run(argv)` dispatcher. Returns a
 * process exit code; never calls process.exit itself (keeps it testable). */
export async function runInit(args: string[], io: InitIO): Promise<number> {
  const parsed = parseInitArgs(args);
  if ("help" in parsed) {
    io.output.write(INIT_HELP_TEXT);
    return 0;
  }
  if ("error" in parsed) {
    io.output.write(`[sekimori init] ${parsed.error}\n`);
    io.output.write(`${INIT_USAGE_LINE}\n`);
    return 1;
  }
  const { path, force, yes, overrides } = parsed;

  if (existsSync(path) && !force) {
    io.output.write(
      `[sekimori init] refusing to overwrite existing file: ${path}\n` +
        "  Re-run with --force to overwrite, or pass a different path.\n",
    );
    return 1;
  }

  // Non-TTY without --yes is refused unconditionally, even when flags are
  // present: interactive prompting would still be needed for any unflagged
  // setting, and that would hang forever with no TTY attached. Keeping this
  // rule simple (no "flags cover everything" special case) matches the
  // existing --yes contract and avoids a second, harder-to-explain path.
  if (!yes && !io.isTTY) {
    io.output.write(
      "[sekimori init] stdin is not a TTY, so interactive prompts would hang forever - refusing to start.\n" +
        "  Re-run with --yes to write a config with defaults non-interactively (e.g. in scripts/CI).\n",
    );
    return 1;
  }

  const answers = yes
    ? applyOverrides(defaultAnswers(overrides.upstreamType ?? "anthropic"), overrides)
    : await runPrompts(io, overrides);
  const configObject = buildConfigObject(answers);
  const apiKeyEnv = defaultApiKeyEnvFor(answers.upstreamType);

  try {
    validateGeneratedConfig(configObject, apiKeyEnv);
  } catch (err) {
    io.output.write(`[sekimori init] generated config failed validation: ${(err as Error).message}\n`);
    io.output.write("  This is a bug in sekimori init - please report it. No file was written.\n");
    return 1;
  }

  try {
    writeFileSync(path, `${JSON.stringify(configObject, null, 2)}\n`, { flag: force ? "w" : "wx" });
  } catch (err) {
    io.output.write(`[sekimori init] could not write ${path}: ${(err as Error).message}\n`);
    return 1;
  }

  printNextSteps(io.output, path, apiKeyEnv);
  return 0;
}

async function runPrompts(io: InitIO, overrides: InitFlagOverrides): Promise<Answers> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    io.output.write("sekimori init - interactive config generator. Press Enter to accept the default in [brackets].\n");
    return await promptAll(rl, io.output, overrides);
  } finally {
    rl.close();
  }
}
