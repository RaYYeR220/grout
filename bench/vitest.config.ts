// Hidden acceptance suites, run against a finished project:
//   TARGET_DIR=/path/to/output npx vitest run --config bench/vitest.config.ts bench/acceptance/<name>
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  test: {
    root: repo,
    include: ["bench/acceptance/**/*.test.ts"],
    globalSetup: ["bench/acceptance/global-setup.ts"],
    // Suites start real processes and servers; running files one at a time keeps ports and CPU predictable.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
