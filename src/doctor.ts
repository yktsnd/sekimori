// doctor.ts - `sekimori doctor`: non-interactive installation self-check (issue #14).
//
// CI proves the code is correct; this proves a *concrete installation* is
// correct. It never starts the HTTP server and never makes a network call -
// it only reads the config file, checks environment variables are present
// (never their values), and probes whether the configured store location is
// writable, without ever touching the real state file. Every check is
// reported with a stable snake_case `name` so an agent can key on it, plus
// `status` ("ok" | "warn" | "fail") and a human-readable `detail`.
//
// The config_valid check reuses the placeholder-env technique from
// init.ts's validateGeneratedConfig: it runs the real validateConfig (so
// every structural/value rule is exercised unmodified) but temporarily fills
// in placeholder env vars if they are missing, so this check does not itself
// require secrets to be set - that is upstream_key_env / admin_key_env's job.

import {
  readFileSync,
  existsSync,
  accessSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { validateConfig, type SekimoriConfig } from "./config.js";
import { validateStoreFileText } from "./store.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Stable, ordered set of check names. The checks array always contains
 * exactly these, in this order, regardless of how far the run got (parsers
 * can rely on the shape never changing). */
export const DOCTOR_CHECK_NAMES = [
  "config_file",
  "config_valid",
  "upstream_key_env",
  "admin_key_env",
  "store_writable",
  "logging",
] as const;

const SKIPPED_DETAIL = "skipped: config not available";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Runs the real validateConfig against `parsed`, but first fills in
 * placeholder values for the upstream API key env var (if it
 * can be determined from `parsed.upstream.apiKeyEnv`) and
 * and SEKIMORI_ADMIN_KEY, so this structural check neither depends on nor
 * validates the real secrets. The dedicated env checks below do that without
 * exposing values. process.env is restored exactly afterwards.
 */
function validateConfigWithPlaceholderEnv(parsed: unknown, configPath: string): SekimoriConfig {
  const apiKeyEnv =
    isRecord(parsed) && isRecord(parsed.upstream) && typeof parsed.upstream.apiKeyEnv === "string"
      ? parsed.upstream.apiKeyEnv
      : undefined;

  const restoreFns: Array<() => void> = [];
  const setPlaceholder = (name: string, value: string): void => {
    const existed = Object.hasOwn(process.env, name);
    const previous = process.env[name];
    process.env[name] = value;
    restoreFns.push(() => {
      if (existed) process.env[name] = previous;
      else delete process.env[name];
    });
  };

  if (apiKeyEnv !== undefined) setPlaceholder(apiKeyEnv, "sekimori-doctor-upstream-placeholder-value");
  setPlaceholder("SEKIMORI_ADMIN_KEY", "sekimori-doctor-admin-placeholder-value");

  try {
    return validateConfig(parsed, { configDirectory: dirname(resolve(configPath)) });
  } finally {
    for (const restore of restoreFns.reverse()) restore();
  }
}

function checkUpstreamKeyEnv(config: SekimoriConfig): DoctorCheck {
  const envVar = config.upstream.apiKeyEnv;
  const value = process.env[envVar];
  if (value !== undefined && /^[\x21-\x7e]+$/.test(value)) {
    return { name: "upstream_key_env", status: "ok", detail: `${envVar} is set` };
  }
  return {
    name: "upstream_key_env",
    status: "fail",
    detail: `environment variable "${envVar}" (named by upstream.apiKeyEnv) must be set to visible ASCII characters`,
  };
}

function checkAdminKeyEnv(): DoctorCheck {
  const value = process.env.SEKIMORI_ADMIN_KEY;
  if (value !== undefined && value.length >= 32 && /^[\x21-\x7e]+$/.test(value)) {
    return { name: "admin_key_env", status: "ok", detail: "SEKIMORI_ADMIN_KEY is set" };
  }
  return {
    name: "admin_key_env",
    status: "fail",
    detail: "environment variable SEKIMORI_ADMIN_KEY must be set to at least 32 visible ASCII characters",
  };
}

/**
 * Probes whether the configured store location is writable, WITHOUT ever
 * writing to or truncating the real state file:
 *   - If the state file already exists, verify it is a regular file and that
 *     both it and its parent directory are writable. FileStore replaces the
 *     snapshot through a same-directory temp file, so checking the file alone
 *     is not sufficient.
 *   - Make sure its directory exists (creating it if needed - the same thing
 *     FileStore's first real persist() would do), then create a randomly named
 *     private probe directory next to the configured path. The probe file is
 *     created exclusively inside it, so a predictable path or a pre-existing
 *     symlink can never be overwritten.
 */
function checkStoreWritable(config: SekimoriConfig): DoctorCheck {
  if (config.store.type === "memory") {
    return {
      name: "store_writable",
      status: "warn",
      detail: "memory store: budget accounting resets on every restart - prefer file for production",
    };
  }

  const path = config.store.path;
  try {
    const stateExists = existsSync(path);
    if (stateExists && !statSync(path).isFile()) {
      throw new Error("store path exists but is not a regular file");
    }
    if (stateExists) validateStoreFileText(readFileSync(path, "utf8"));

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK | fsConstants.X_OK);
    if (stateExists) accessSync(path, fsConstants.W_OK);

    const probeDir = mkdtempSync(join(dir, ".sekimori-doctor-"));
    const renamedProbe = join(dir, `${basename(probeDir)}.renamed`);
    try {
      const writeProbe = join(probeDir, "write-probe");
      writeFileSync(writeProbe, "", { flag: "wx" });
      renameSync(writeProbe, renamedProbe);
    } finally {
      rmSync(renamedProbe, { force: true });
      rmSync(probeDir, { recursive: true, force: true });
    }
    return {
      name: "store_writable",
      status: "ok",
      detail: stateExists ? `store file is valid and writable: ${path}` : `store directory is writable: ${dir}`,
    };
  } catch (err) {
    return { name: "store_writable", status: "fail", detail: `store path is not writable: ${path} (${(err as Error).message})` };
  }
}

function checkLogging(config: SekimoriConfig): DoctorCheck {
  if (config.logging.logBodies) {
    return { name: "logging", status: "warn", detail: "request/response bodies will be logged" };
  }
  return { name: "logging", status: "ok", detail: "request/response body logging is disabled" };
}

interface ComputedChecks {
  checks: DoctorCheck[];
  /** The validated effective config, if config_file and config_valid both
   * succeeded. Used to build the human-mode "Protection summary"; never
   * part of the --json output. */
  config: SekimoriConfig | undefined;
}

function computeChecks(configPath: string): ComputedChecks {
  const checks: DoctorCheck[] = [];

  let raw: string | undefined;
  try {
    raw = readFileSync(configPath, "utf8");
    checks.push({ name: "config_file", status: "ok", detail: `found and readable: ${configPath}` });
  } catch (err) {
    const detail =
      isErrnoException(err) && err.code === "ENOENT"
        ? `config file not found: ${configPath}`
        : `config file is not readable: ${configPath} (${(err as Error).message})`;
    checks.push({ name: "config_file", status: "fail", detail });
  }

  let config: SekimoriConfig | undefined;
  if (raw === undefined) {
    checks.push({ name: "config_valid", status: "fail", detail: SKIPPED_DETAIL });
  } else {
    try {
      const parsed = JSON.parse(raw);
      config = validateConfigWithPlaceholderEnv(parsed, configPath);
      checks.push({ name: "config_valid", status: "ok", detail: "parses as JSON and passes validateConfig" });
    } catch (err) {
      checks.push({ name: "config_valid", status: "fail", detail: (err as Error).message });
    }
  }

  if (config === undefined) {
    checks.push({ name: "upstream_key_env", status: "fail", detail: SKIPPED_DETAIL });
    checks.push({ name: "admin_key_env", status: "fail", detail: SKIPPED_DETAIL });
    checks.push({ name: "store_writable", status: "fail", detail: SKIPPED_DETAIL });
    checks.push({ name: "logging", status: "fail", detail: SKIPPED_DETAIL });
  } else {
    checks.push(checkUpstreamKeyEnv(config));
    checks.push(checkAdminKeyEnv());
    checks.push(checkStoreWritable(config));
    checks.push(checkLogging(config));
  }

  return { checks, config };
}

/** Runs every check and returns the stable `{ ok, checks }` shape - this is
 * exactly what `doctor --json` prints. `ok` is false if any check has
 * status "fail" (warnings do not affect it). */
export function runDoctorChecks(configPath: string): DoctorResult {
  const { checks } = computeChecks(configPath);
  const ok = checks.every((c) => c.status !== "fail");
  return { ok, checks };
}

function formatCheckLine(check: DoctorCheck): string {
  const prefix = check.status === "ok" ? "ok  " : check.status === "warn" ? "WARN" : "FAIL";
  return `${prefix}  ${check.name}: ${check.detail}`;
}

/** Plain-language summary of what the running instance protects, built from
 * the effective config - this is the text an operator agent pastes to a
 * non-expert owner. Only shown when every check passes (warnings allowed). */
function formatProtectionSummary(config: SekimoriConfig): string[] {
  const models = Object.keys(config.models).join(", ") || "(none)";
  const cors =
    config.cors.allowedOrigins.length > 0
      ? `browser apps allowed from: ${config.cors.allowedOrigins.join(", ")}`
      : "browser access disabled (no CORS origins allowed)";
  const store =
    config.store.type === "file"
      ? `persisted to disk (${config.store.path}) - usage survives restarts`
      : "in-memory only - usage resets on every restart";
  const logging = config.logging.logBodies
    ? "request/response bodies ARE logged"
    : "request/response bodies are never logged";

  return [
    "",
    "Protection summary (paste this to the owner):",
    `  - Allowed models: ${models}`,
    `  - Monthly spending cap: $${config.budget.monthlyUsd} total, across everyone invited`,
    `  - Default daily cap per invited person: $${config.budget.defaultDailyPerTokenUsd}`,
    `  - Rate limit: ${config.rateLimit.requestsPerMinute} requests/minute per person`,
    `  - CORS: ${cors}`,
    `  - Logging: ${logging}`,
    `  - Store: ${store}`,
  ];
}

export const DOCTOR_USAGE_LINE = "Usage: sekimori doctor [configPath] [--json] [--help]";

export const DOCTOR_HELP_TEXT = `${DOCTOR_USAGE_LINE}

Non-interactive self-check of a concrete sekimori installation: verifies the
config file exists and is valid, the required environment variables are set
(never prints their values), the configured store location is writable
(without ever touching an existing state file), and reports whether
request/response body logging is enabled. Never starts the HTTP server and
never makes a network call.

Run it after any config or environment change, and before handing the URL
to anyone.

Positional:
  configPath              Path to the config file to check (default: ./sekimori.config.json)

Flags:
  --json
      Print a single JSON object to stdout and nothing else:
      { "ok": boolean, "checks": [ { "name", "status", "detail" }, ... ] }
      Intended for agents: key on checks[].name / checks[].status, not on
      detail text.
  --help, -h
      Show this help and exit.

Exit code: 0 when every check passes (warnings do not fail it), 1 otherwise.

Examples:
  sekimori doctor
  sekimori doctor ./my.config.json --json
`;

export type ParseDoctorArgsResult = { configPath: string; json: boolean } | { error: string } | { help: true };

/** Parses `sekimori doctor [configPath] [--json] [--help]`. --help always
 * wins over a malformed flag, matching init's convention. */
export function parseDoctorArgs(args: string[]): ParseDoctorArgsResult {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true };
  }

  let configPath: string | undefined;
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return { error: `unknown flag: ${arg}` };
    }
    if (configPath === undefined) {
      configPath = arg;
      continue;
    }
    return { error: `unexpected extra argument: ${arg}` };
  }

  return { configPath: configPath ?? "./sekimori.config.json", json };
}

export interface DoctorIO {
  output: NodeJS.WritableStream;
}

/** Entry point called from main.ts's `run(argv)` dispatcher. Returns a
 * process exit code; never calls process.exit itself (keeps it testable). */
export function runDoctor(args: string[], io: DoctorIO): number {
  const parsed = parseDoctorArgs(args);
  if ("help" in parsed) {
    io.output.write(DOCTOR_HELP_TEXT);
    return 0;
  }
  if ("error" in parsed) {
    io.output.write(`[sekimori doctor] ${parsed.error}\n${DOCTOR_USAGE_LINE}\n`);
    return 1;
  }

  const { configPath, json } = parsed;
  const { checks, config } = computeChecks(configPath);
  const ok = checks.every((c) => c.status !== "fail");

  if (json) {
    io.output.write(`${JSON.stringify({ ok, checks })}\n`);
    return ok ? 0 : 1;
  }

  for (const check of checks) {
    io.output.write(`${formatCheckLine(check)}\n`);
  }

  if (ok && config !== undefined) {
    for (const line of formatProtectionSummary(config)) {
      io.output.write(`${line}\n`);
    }
  }

  return ok ? 0 : 1;
}
