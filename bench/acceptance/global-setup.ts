// Prepares TARGET_DIR once per run: dependencies first, then the build, only when they are missing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMP_ROOT_ENV, npm, target } from "./helpers.js";

function runNpm(args: string[], cwd: string): void {
  const cmd = npm(args);
  const result = spawnSync(cmd.file, cmd.args, { cwd, shell: cmd.shell, encoding: "utf8", windowsHide: true, timeout: 600_000 });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed in ${cwd} (exit ${result.status}):\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
  }
}

export default function setup(): () => void {
  const dir = target();
  if (!existsSync(join(dir, "package.json"))) throw new Error(`${dir} has no package.json`);
  if (!existsSync(join(dir, "node_modules"))) {
    const lockfile = existsSync(join(dir, "package-lock.json"));
    runNpm(lockfile ? ["ci", "--ignore-scripts"] : ["install", "--ignore-scripts", "--no-package-lock"], dir);
  }
  if (!existsSync(join(dir, "dist"))) runNpm(["run", "build"], dir);

  // Test workers are started after this and inherit the variable; their own exit hooks do not run reliably.
  const root = mkdtempSync(join(tmpdir(), "grout-bench-"));
  process.env[TEMP_ROOT_ENV] = root;
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
