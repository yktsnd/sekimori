// Run TypeScript test files explicitly so `npm test` behaves the same under
// cmd.exe, PowerShell, and POSIX shells. In particular, cmd.exe does not
// expand `test/*.test.ts`, and Node 20 does not discover TypeScript tests.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirectory = join(root, "test");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(testDirectory, name));

if (testFiles.length === 0) {
  throw new Error("No test files found in test/");
}

const result = spawnSync(process.execPath, [tsxCli, "--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
