import { describe, expect, test } from "vitest";
import { harnessInvocation, scaffold } from "../../src/template/scaffold.js";
import { reconcile } from "../../src/agents/reconcile.js";
import type { Ledger } from "../../src/state/ledger.js";
import type { Blueprint } from "../../src/state/blueprint.js";

const cliLedger: Ledger = {
  requirements: [
    { id: "R1", kind: "output-format", statement: "greets", specQuote: "prints Hello", examples: [] },
    { id: "R2", kind: "exit-code", statement: "exit 2 without a name", specQuote: "exits with code 2", examples: [] },
  ],
  interface: { kind: "cli", entry: "src/cli.ts", binName: "hello", invocation: "hello <name>", notes: [] },
  ambiguities: [],
};

const blueprint: Blueprint = {
  files: [{ path: "src/cli.ts", purpose: "entry", owner: "T1" }],
  dependencies: { "left-pad": "1.3.0" },
  devDependencies: {},
  tasks: [{ id: "T1", title: "cli", writeSurface: ["src/cli.ts"], requirements: ["R1", "R2"], dependsOn: [], notes: "" }],
};

describe("scaffold", () => {
  test("a CLI gets a bin entry, build/start/test scripts and pinned tooling", () => {
    const files = scaffold(cliLedger, blueprint, "Hello Greeter");
    const pkg = JSON.parse(files.get("package.json")!);
    expect(pkg.name).toBe("hello-greeter");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ hello: "dist/cli.js" });
    expect(pkg.scripts).toEqual({ build: "tsc -p tsconfig.json", start: "node dist/cli.js", test: "vitest run" });
    expect(pkg.dependencies).toEqual({ "left-pad": "1.3.0" });
    expect(pkg.devDependencies).toMatchObject({ typescript: "5.9.3", vitest: "3.2.7" });
    expect(JSON.parse(files.get("tsconfig.json")!).compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist", module: "NodeNext" });
    expect(files.get("vitest.config.ts")).toContain("global-setup");
    expect(files.get(".gitignore")).not.toMatch(/dist/);
  });

  test("the harness runs the built entry for a bin-style invocation", () => {
    expect(harnessInvocation(cliLedger.interface)).toEqual({ command: "node", args: ["dist/cli.js"] });
    expect(scaffold(cliLedger, blueprint, "x").get("test/harness.ts")).toContain('const INVOCATION = {"command":"node","args":["dist/cli.js"]}');
  });

  test("the harness follows a spec that says to run through npm start", () => {
    const iface = { ...cliLedger.interface, invocation: "npm start -- <args>" };
    expect(harnessInvocation(iface)).toEqual({ command: "npm", args: ["start", "--silent", "--"] });
  });

  test("the harness follows an explicit node file invocation", () => {
    const iface = { ...cliLedger.interface, entry: "src/index.ts", invocation: "node dist/index.js add <title>" };
    expect(harnessInvocation(iface)).toEqual({ command: "node", args: ["dist/index.js"] });
  });

  test("an HTTP interface reads its port from the declared env var", () => {
    const http: Ledger = { ...cliLedger, interface: { kind: "http", entry: "src/server.ts", invocation: "node dist/server.js", port: { env: "APP_PORT", default: 8080 }, notes: [] } };
    const files = scaffold(http, { ...blueprint, tasks: [{ ...blueprint.tasks[0], writeSurface: ["src/server.ts"] }] }, "api");
    expect(JSON.parse(files.get("package.json")!).bin).toBeUndefined();
    expect(files.get("test/harness.ts")).toContain('const PORT_ENV = "APP_PORT"');
    expect(files.get("test/harness.ts")).toContain("const DEFAULT_PORT = 8080");
    expect(files.get("test/harness.ts")).toContain("useDefaultPort");
  });
});

describe("reconcile", () => {
  test("flags uncovered requirements, unknown references and shared surfaces", () => {
    const bp: Blueprint = {
      ...blueprint,
      tasks: [
        { id: "T1", title: "a", writeSurface: ["src/a.ts", "src/routes.ts"], requirements: ["R1", "R99"], dependsOn: [], notes: "" },
        { id: "T2", title: "b", writeSurface: ["src/b.ts", "src/routes.ts"], requirements: [], dependsOn: [], notes: "" },
      ],
    };
    expect(reconcile(cliLedger, bp)).toEqual({ ok: false, uncoveredRequirements: ["R2"], unknownRequirementRefs: ["R99"], overlappingSurfaces: ["src/routes.ts"], missingEntry: "src/cli.ts" });
  });

  test("non-functional requirements do not need a task", () => {
    const ledger: Ledger = { ...cliLedger, requirements: [...cliLedger.requirements, { id: "R3", kind: "non-functional", statement: "fast", specQuote: "should be fast", examples: [] }] };
    expect(reconcile(ledger, blueprint).ok).toBe(true);
  });
});
