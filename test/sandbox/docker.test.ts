import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DockerSandbox } from "../../src/sandbox/docker.js";

const enabled = process.env.GROUT_DOCKER_TESTS === "1";

describe.skipIf(!enabled)("DockerSandbox (GROUT_DOCKER_TESTS=1)", () => {
  const sb = new DockerSandbox();
  const pkg = JSON.stringify({ name: "x", version: "1.0.0", private: true, type: "module", devDependencies: { typescript: "5.9.3" } });
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" }, include: ["src"] });

  beforeAll(async () => {
    await sb.init(`test-${Date.now()}`);
    const r = await sb.installDeps(pkg);
    expect(r.exitCode).toBe(0);
    expect(r.lockfile).toContain('"typescript"');
  }, 240_000);
  afterAll(() => sb.dispose(), 60_000);

  test("typechecks a snapshot against the shared dependencies", async () => {
    const ok = await sb.exec(new Map([["tsconfig.json", tsconfig], ["src/a.ts", "export const a: number = 1;"]]), "npx tsc -p .");
    expect(ok.exitCode).toBe(0);
    const bad = await sb.exec(new Map([["tsconfig.json", tsconfig], ["src/a.ts", "export const a: number = 'x';"]]), "npx tsc -p .");
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout).toContain("TS2322");
  }, 60_000);

  test("collects files; programs see no PORT unless a test sets one", async () => {
    const files = new Map([["p.mjs", "import { writeFileSync, mkdirSync } from 'node:fs'; mkdirSync('dist', { recursive: true }); writeFileSync('dist/port.txt', process.env.PORT ?? 'unset');"]]);
    const a = await sb.exec(files, "node p.mjs", { collect: ["dist/"] });
    expect(a.outputs["dist/port.txt"]).toBe("unset");
  }, 60_000);

  test("kills a command at its timeout", async () => {
    const r = await sb.exec(new Map([["h.mjs", "setTimeout(() => {}, 60000)"]]), "node h.mjs", { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
  }, 30_000);

  test("clean room runs a real npm ci from the lockfile", async () => {
    const install = await sb.installDeps(pkg);
    const files = new Map([["package.json", pkg], ["package-lock.json", install.lockfile!], ["tsconfig.json", tsconfig], ["src/a.ts", "export const a = 1;"]]);
    const results = await sb.cleanRoom(files, ["npm ci --ignore-scripts --no-audit --no-fund", "npx tsc -p ."]);
    expect(results.map((r) => r.exitCode)).toEqual([0, 0]);
  }, 240_000);
});
