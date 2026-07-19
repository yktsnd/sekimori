#!/usr/bin/env node

// Fail-closed checks that run immediately before `npm publish`.
// This intentionally uses only Node built-ins and permits publication only
// from the repository's manual GitHub Actions workflow on the public main
// branch. It does not publish, tag, or mutate any file.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`${relativePath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  if (process.argv.indexOf(name, index + 1) !== -1) fail(`${name} must appear only once`);
  return value;
}

const knownArgs = new Set(["--expected-version", "--confirmation"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!knownArgs.has(name)) fail(`unknown argument: ${name}`);
}

const expectedVersion = option("--expected-version") ?? process.env.SEKIMORI_RELEASE_VERSION;
const confirmation = option("--confirmation") ?? process.env.SEKIMORI_RELEASE_CONFIRMATION;
if (!expectedVersion) fail("--expected-version is required");
if (!confirmation) fail("--confirmation is required");

const manifest = readJson("package.json");
const lock = readJson("package-lock.json");
const version = typeof manifest.version === "string" ? manifest.version : "";
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (manifest.name !== "sekimori") fail("package name must be exactly sekimori");
if (!stableSemver.test(version)) fail(`package version must be stable SemVer without a prerelease/build suffix; found ${version || "(missing)"}`);
if (expectedVersion && version !== expectedVersion) fail(`workflow version ${expectedVersion} does not match package.json version ${version || "(missing)"}`);
if (confirmation && confirmation !== `publish sekimori@${version}`) {
  fail(`confirmation must be exactly: publish sekimori@${version || "<version>"}`);
}
if (lock.name !== manifest.name || lock.version !== version || lock.packages?.[""]?.version !== version) {
  fail("package-lock.json name/version must match package.json");
}
if (manifest.private === true) fail("package.json must not be private");
if (manifest.license !== "MIT") fail("license must be MIT");
if (manifest.type !== "module") fail("package type must remain module");
if (manifest.bin?.sekimori !== "dist/main.js") fail("bin.sekimori must point to dist/main.js");
if (manifest.scripts?.start !== "node dist/main.js") fail("the packaged start script must run dist/main.js");
if (manifest.scripts?.build !== "node scripts/build.mjs") fail("build must use the clean cross-platform build script");
if (manifest.scripts?.prepack !== "node scripts/build.mjs") fail("prepack must create a clean dist before packaging");
if (!String(manifest.scripts?.prepublishOnly ?? "").includes("npm run release:check")) {
  fail("prepublishOnly must invoke release:check");
}
if (manifest.engines?.node !== ">=20") fail("engines.node must match the tested >=20 contract");
if (manifest.repository?.url !== "git+https://github.com/yktsnd/sekimori.git") fail("repository URL is incorrect");
if (manifest.bugs?.url !== "https://github.com/yktsnd/sekimori/issues") fail("bugs URL is incorrect");
if (manifest.homepage !== "https://github.com/yktsnd/sekimori#readme") fail("homepage URL is incorrect");
if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/") fail("publish registry must be the public npm registry");
if (manifest.publishConfig?.access !== "public") fail("publish access must be public");
if (manifest.publishConfig?.provenance !== true) fail("npm provenance must be enabled");

const packageFiles = new Set(Array.isArray(manifest.files) ? manifest.files : []);
for (const required of [
  "dist",
  "docs",
  "!docs/history",
  "examples",
  "sekimori.config.example.json",
  "README.md",
  "README.ja.md",
  "AGENTS.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "CODE_OF_CONDUCT.md",
  "RELEASING.md",
  "ROADMAP.md",
]) {
  if (!packageFiles.has(required)) fail(`package files list is missing ${required}`);
}
for (const forbidden of ["src", "test", ".github", "sekimori.config.json", "state", ".env"]) {
  if (packageFiles.has(forbidden)) fail(`package files list must not include ${forbidden}`);
}

if (stableSemver.test(version)) {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const releaseHeading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
  if (!releaseHeading.test(changelog)) fail(`CHANGELOG.md needs a dated heading: ## [${version}] - YYYY-MM-DD`);
}

if (process.env.GITHUB_ACTIONS !== "true") fail("publishing is allowed only from GitHub Actions");
if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") fail("publishing requires a manual workflow_dispatch event");
if (process.env.GITHUB_REPOSITORY !== "yktsnd/sekimori") fail("publishing is restricted to yktsnd/sekimori");
if (process.env.GITHUB_REF !== "refs/heads/main") fail("publishing is restricted to refs/heads/main");
if (!String(process.env.GITHUB_WORKFLOW_REF ?? "").includes("/.github/workflows/publish.yml@refs/heads/main")) {
  fail("publishing must run from .github/workflows/publish.yml on main");
}

try {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (status.trim().length > 0) fail("release checkout must be clean");

  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (process.env.GITHUB_SHA && head !== process.env.GITHUB_SHA) fail("checked-out HEAD does not match GITHUB_SHA");
} catch (error) {
  fail(`could not verify the release Git checkout: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error("[release-check] blocked:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`[release-check] passed for sekimori@${version}`);
