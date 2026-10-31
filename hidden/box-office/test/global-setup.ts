// Builds the project once before the tests, so they exercise the compiled program like a user would.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, stdio: "pipe" });
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`build failed before tests:\n${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`);
  }
}
