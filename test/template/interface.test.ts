import { describe, expect, test } from "vitest";
import { canonicalInterface, harnessInvocation, scaffold, entryChecks } from "../../src/template/scaffold.js";
import { reconcile } from "../../src/agents/reconcile.js";
import type { Interface, Ledger } from "../../src/state/ledger.js";
import type { Blueprint } from "../../src/state/blueprint.js";

const cli = (over: Partial<Interface>): Interface => ({ kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [], ...over });

describe("canonicalInterface", () => {
  test("a root file in the invocation gets a shim that runs the built entry", () => {
    const r = canonicalInterface(cli({ entry: "./src/cli.ts", invocation: "node index.js add <title>" }));
    expect(r).toEqual({ ok: true, iface: expect.objectContaining({ entry: "src/index.ts" }), shim: { path: "index.js", content: 'import "./dist/index.js";\n' }, scripts: {} });
  });

  test("a dist path in the invocation decides the entry's name", () => {
    expect(canonicalInterface(cli({ invocation: "node dist/main.js <args>" }))).toMatchObject({ ok: true, iface: { entry: "src/main.ts" }, shim: undefined });
  });

  test("another output folder is reached through a shim one level down", () => {
    expect(canonicalInterface(cli({ invocation: "node build/cli.js" }))).toMatchObject({ ok: true, iface: { entry: "src/cli.ts" }, shim: { path: "build/cli.js", content: 'import "../dist/cli.js";\n' } });
  });

  test("npm run <script> gets that script", () => {
    expect(canonicalInterface(cli({ invocation: "npm run dev -- <args>" }))).toMatchObject({ ok: true, scripts: { dev: "node dist/cli.js" } });
  });

  test("an entry outside src/ is moved under src/", () => {
    expect(canonicalInterface(cli({ entry: "lib/tool.ts", invocation: "npm start -- <args>" }))).toMatchObject({ ok: true, iface: { entry: "src/tool.ts" } });
  });

  test("a non-Node program is refused with a reason", () => {
    expect(canonicalInterface(cli({ invocation: "python app.py" }))).toEqual({ ok: false, problem: expect.stringMatching(/python/) });
  });
});

describe("scaffold follows the canonical interface", () => {
  const blueprint: Blueprint = { files: [], dependencies: {}, devDependencies: {}, tasks: [{ id: "T1", title: "x", writeSurface: ["src/index.ts"], requirements: ["R1"], dependsOn: [], notes: "" }] };
  const ledger: Ledger = {
    requirements: [{ id: "R1", kind: "behavior", statement: "x", specQuote: "x", examples: [] }],
    interface: cli({ entry: "src/index.ts", invocation: "node index.js add <title>" }),
    ambiguities: [],
  };

  test("the shim is generated and the harness runs it exactly as the spec says", () => {
    const files = scaffold(ledger, blueprint, "todo");
    expect(files.get("index.js")).toBe('import "./dist/index.js";\n');
    expect(harnessInvocation(ledger.interface)).toEqual({ command: "node", args: ["index.js"] });
  });

  test("the clean room checks that the program's entry files exist after the build", () => {
    expect(entryChecks(ledger.interface)).toEqual(["node --check dist/index.js", "node --check index.js"]);
  });

  test("the reconciler requires a task to own the entry file", () => {
    const other = { ...blueprint, tasks: [{ ...blueprint.tasks[0], writeSurface: ["src/cli.ts"] }] };
    expect(reconcile(ledger, other)).toMatchObject({ ok: false, missingEntry: "src/index.ts" });
    expect(reconcile(ledger, blueprint)).toMatchObject({ ok: true });
  });
});

describe("reconcile checks task dependencies", () => {
  const ledger: Ledger = { requirements: [{ id: "R1", kind: "behavior", statement: "x", specQuote: "x", examples: [] }], interface: cli({}), ambiguities: [] };
  const task = (id: string, dependsOn: string[], surface = [`src/${id}.ts`]) => ({ id, title: id, writeSurface: surface, requirements: id === "T1" ? ["R1"] : [], dependsOn, notes: "" });
  const bp = (tasks: ReturnType<typeof task>[]): Blueprint => ({ files: [], dependencies: {}, devDependencies: {}, tasks: [{ ...tasks[0], writeSurface: ["src/cli.ts"] }, ...tasks.slice(1)] });

  test("unknown, self and circular dependencies are refused", () => {
    expect(reconcile(ledger, bp([task("T1", ["T9"])])).badDependencies).toEqual(["T1 depends on unknown task T9"]);
    expect(reconcile(ledger, bp([task("T1", ["T1"])])).badDependencies).toEqual(["T1 depends on itself"]);
    expect(reconcile(ledger, bp([task("T1", ["T2"]), task("T2", ["T3"]), task("T3", ["T1"])])).badDependencies).toEqual(["circular dependency: T1 → T2 → T3 → T1"]);
    expect(reconcile(ledger, bp([task("T1", ["T2"]), task("T2", ["T3"]), task("T3", ["T1"])])).ok).toBe(false);
    expect(reconcile(ledger, bp([task("T1", []), task("T2", ["T1"])])).ok).toBe(true);
  });
});

