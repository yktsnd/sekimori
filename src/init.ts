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
 * (see report / CHANGELOG): keeping this fixed avoids a tenth prompt for a
 * value that is almost always ANTHROPIC_API_KEY, and matches the example
 * config that docs/configuration.md already points people at. */
const API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Default model + reference pricing, matching sekimori.config.example.json. */
const DEFAULT_MODEL_NAME = "claude-haiku-4-5-20251001";
const DEFAULT_MODEL_PRICING: ModelPricing = { inputPerMTok: 1.0, outputPerMTok: 5.0 };

export interface InitIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Whether `input` is an interactive TTY. Passed explicitly (rather than
   * read from process.stdin internally) so tests can drive the interactive
   * prompt flow with a plain in-memory stream. */
  isTTY: boolean;
}

export interface ParsedInitArgs {
  path: string;
  force: boolean;
  yes: boolean;
}

export type ParseInitArgsResult = ParsedInitArgs | { error: string };

/** Parses `sekimori init [path] [--force] [--yes]`. */
export function parseInitArgs(args: string[]): ParseInitArgsResult {
  let path: string | undefined;
  let force = false;
  let yes = false;

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg.startsWith("-")) {
      return { error: `unknown flag: ${arg}` };
    } else if (path === undefined) {
      path = arg;
    } else {
      return { error: `unexpected extra argument: ${arg}` };
    }
  }

  return { path: path ?? "./sekimori.config.json", force, yes };
}

interface Answers {
  port: number;
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
 * to sekimori.config.example.json. */
function defaultAnswers(): Answers {
  return {
    port: 8787,
    baseUrl: "https://api.anthropic.com",
    models: { [DEFAULT_MODEL_NAME]: { ...DEFAULT_MODEL_PRICING } },
    monthlyUsd: 30,
    defaultDailyPerTokenUsd: 0.5,
    requestsPerMinute: 10,
    storeType: "file",
    storePath: ".sekimori/state.json",
    corsOrigins: [],
    pinnedSystemPrompt: null,
  };
}

/** Builds the plain JSON object that will be written to disk from answers. */
function buildConfigObject(answers: Answers): Record<string, unknown> {
  return {
    port: answers.port,
    upstream: { baseUrl: answers.baseUrl, apiKeyEnv: API_KEY_ENV },
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

async function promptModels(rl: Rl, output: NodeJS.WritableStream): Promise<Record<string, ModelPricing>> {
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
    `Include the default model "${DEFAULT_MODEL_NAME}" (reference price: input $${DEFAULT_MODEL_PRICING.inputPerMTok}/MTok, output $${DEFAULT_MODEL_PRICING.outputPerMTok}/MTok)?`,
    true,
  );
  if (includeDefault) {
    const inputPerMTok = await promptPositiveNumber(
      rl,
      output,
      `  input price USD/MTok for ${DEFAULT_MODEL_NAME}`,
      DEFAULT_MODEL_PRICING.inputPerMTok,
    );
    const outputPerMTok = await promptPositiveNumber(
      rl,
      output,
      `  output price USD/MTok for ${DEFAULT_MODEL_NAME}`,
      DEFAULT_MODEL_PRICING.outputPerMTok,
    );
    models[DEFAULT_MODEL_NAME] = { inputPerMTok, outputPerMTok };
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
    output.write(`  (at least one model is required - adding the default model "${DEFAULT_MODEL_NAME}")\n`);
    models[DEFAULT_MODEL_NAME] = { ...DEFAULT_MODEL_PRICING };
  }

  return models;
}

async function promptAll(rl: Rl, output: NodeJS.WritableStream): Promise<Answers> {
  const defaults = defaultAnswers();

  const port = await promptPositiveNumber(rl, output, "port", defaults.port, { integer: true, max: 65535 });
  const baseUrl = await promptUrl(rl, output, "upstream base URL", defaults.baseUrl);
  const models = await promptModels(rl, output);
  const monthlyUsd = await promptPositiveNumber(rl, output, "monthly budget USD", defaults.monthlyUsd);
  const defaultDailyPerTokenUsd = await promptPositiveNumber(
    rl,
    output,
    "default per-token daily budget USD",
    defaults.defaultDailyPerTokenUsd,
  );
  const requestsPerMinute = await promptPositiveNumber(
    rl,
    output,
    "rate limit requests/minute",
    defaults.requestsPerMinute,
    { integer: true },
  );
  const storeType = (await promptChoice(rl, output, "store: file or memory", defaults.storeType, [
    "file",
    "memory",
  ])) as "file" | "memory";
  const storePath =
    storeType === "file" ? await promptString(rl, "  store file path", defaults.storePath) : "";
  const corsRaw = await promptString(rl, "CORS allowed origins (comma-separated, empty = none)", "");
  const corsOrigins = corsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const pinnedRaw = await promptString(rl, "pinned system prompt (empty = null / pass through client's system field)", "");
  const pinnedSystemPrompt = pinnedRaw === "" ? null : pinnedRaw;

  return {
    port,
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

function printNextSteps(output: NodeJS.WritableStream, path: string): void {
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
      "       export ANTHROPIC_API_KEY=sk-ant-...      # your real upstream API key",
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
  if ("error" in parsed) {
    io.output.write(`[sekimori init] ${parsed.error}\n`);
    io.output.write("Usage: sekimori init [path] [--force] [--yes]\n");
    return 1;
  }
  const { path, force, yes } = parsed;

  if (existsSync(path) && !force) {
    io.output.write(
      `[sekimori init] refusing to overwrite existing file: ${path}\n` +
        "  Re-run with --force to overwrite, or pass a different path.\n",
    );
    return 1;
  }

  if (!yes && !io.isTTY) {
    io.output.write(
      "[sekimori init] stdin is not a TTY, so interactive prompts would hang forever - refusing to start.\n" +
        "  Re-run with --yes to write a config with defaults non-interactively (e.g. in scripts/CI).\n",
    );
    return 1;
  }

  const answers = yes ? defaultAnswers() : await runPrompts(io);
  const configObject = buildConfigObject(answers);

  try {
    validateGeneratedConfig(configObject, API_KEY_ENV);
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

  printNextSteps(io.output, path);
  return 0;
}

async function runPrompts(io: InitIO): Promise<Answers> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    io.output.write("sekimori init - interactive config generator. Press Enter to accept the default in [brackets].\n");
    return await promptAll(rl, io.output);
  } finally {
    rl.close();
  }
}
