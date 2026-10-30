import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tarFiles } from "../../src/sandbox/tar.js";

describe("tarFiles", () => {
  test("produces an archive the system tar extracts byte-for-byte, including long paths", () => {
    const long = `${"deep/".repeat(25)}file.ts`;
    const files = new Map([
      ["package.json", '{"name":"x"}'],
      ["src/a.ts", "export const a = 'é';\n"],
      [long, "x".repeat(1000)],
    ]);
    const dir = mkdtempSync(join(tmpdir(), "grout-tar-"));
    writeFileSync(join(dir, "a.tar"), tarFiles(files));
    const r = spawnSync("tar", ["-xf", "a.tar"], { cwd: dir });
    expect(r.status).toBe(0);
    for (const [p, c] of files) expect(readFileSync(join(dir, p), "utf8")).toBe(c);
  });
});
