import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalSandbox } from "../../src/sandbox/local.js";

describe("LocalSandbox", () => {
  const sb = new LocalSandbox();
  beforeAll(() => sb.init(`test-${Date.now()}`));
  afterAll(() => sb.dispose());

  test("each exec gets a fresh snapshot directory and no PORT of ours leaks into the program", async () => {
    const files = new Map([["print.mjs", "console.log(process.cwd(), process.env.PORT ?? 'unset')"]]);
    const [a, b] = await Promise.all([sb.exec(files, "node print.mjs"), sb.exec(files, "node print.mjs")]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout.split(" ")[0]).not.toBe(b.stdout.split(" ")[0]);
    expect(b.stdout.trim().split(" ").at(-1)).toBe(process.env.PORT ?? "unset");
  });

  test("collects requested output files", async () => {
    const files = new Map([["w.mjs", "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('.grout', { recursive: true }); writeFileSync('.grout/r.json', '{\"ok\":1}'); mkdirSync('dist/sub', { recursive: true }); writeFileSync('dist/sub/a.js', 'x');"]]);
    const r = await sb.exec(files, "node w.mjs", { collect: [".grout/r.json", "dist/"] });
    expect(r.outputs).toEqual({ ".grout/r.json": '{"ok":1}', "dist/sub/a.js": "x" });
  });

  test("refuses commands outside the allowlist", async () => {
    const r = await sb.exec(new Map(), "rm -rf /");
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toMatch(/not allowed/);
  });

  test("refuses shell metacharacters even after an allowed command", async () => {
    const r = await sb.exec(new Map(), "node a.mjs && echo pwned");
    expect(r.exitCode).toBe(126);
    expect(r.stderr).toMatch(/unsafe token/);
  });

  test("kills a command that exceeds its timeout", async () => {
    const r = await sb.exec(new Map([["hang.mjs", "setTimeout(() => {}, 60000)"]]), "node hang.mjs", { timeoutMs: 800 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  test("installs dependencies once and returns the lockfile", async () => {
    const r = await sb.installDeps(JSON.stringify({ name: "x", version: "1.0.0", private: true }));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.lockfile!).lockfileVersion).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
