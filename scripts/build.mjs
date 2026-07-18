#!/usr/bin/env node

// Cross-platform clean build used by both `npm run build` and npm's prepack
// lifecycle. Starting from an empty dist/ prevents deleted or renamed source
// files from leaking stale JavaScript into a release tarball.

import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

rmSync(dist, { recursive: true, force: true });

const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

chmodSync(join(dist, "main.js"), 0o755);
