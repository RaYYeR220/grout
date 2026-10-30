import { describe, expect, test } from "vitest";
import { LedgerSchema } from "../../src/state/ledger.js";
import { BlueprintSchema } from "../../src/state/blueprint.js";

const cliInterface = { kind: "cli", entry: "src/cli.ts", binName: "hello", invocation: "node dist/cli.js <name>", notes: [] };
const req = { id: "R1", kind: "output-format", statement: "greets", specQuote: "prints `Hello, <name>!`", examples: [] };

describe("LedgerSchema", () => {
  test("accepts a minimal valid ledger", () => {
    expect(LedgerSchema.safeParse({ requirements: [req], interface: cliInterface, ambiguities: [] }).success).toBe(true);
  });

  test("rejects a requirement without a spec quote", () => {
    const { specQuote: _q, ...noQuote } = req;
    expect(LedgerSchema.safeParse({ requirements: [noQuote], interface: cliInterface, ambiguities: [] }).success).toBe(false);
  });

  test("rejects an empty spec quote", () => {
    expect(LedgerSchema.safeParse({ requirements: [{ ...req, specQuote: " " }], interface: cliInterface, ambiguities: [] }).success).toBe(false);
  });

  test("rejects an http interface without a port", () => {
    const http = { kind: "http", entry: "src/server.ts", invocation: "node dist/server.js", notes: [] };
    expect(LedgerSchema.safeParse({ requirements: [req], interface: http, ambiguities: [] }).success).toBe(false);
  });

  test("rejects duplicate requirement ids", () => {
    expect(LedgerSchema.safeParse({ requirements: [req, req], interface: cliInterface, ambiguities: [] }).success).toBe(false);
  });
});

describe("BlueprintSchema", () => {
  const base = { files: [{ path: "src/cli.ts", purpose: "entry", owner: "T1" }], dependencies: {}, devDependencies: {} };

  test("accepts a task with a write surface", () => {
    const bp = { ...base, tasks: [{ id: "T1", title: "cli", writeSurface: ["src/cli.ts"], requirements: ["R1"], dependsOn: [], notes: "" }] };
    expect(BlueprintSchema.safeParse(bp).success).toBe(true);
  });

  test("rejects a task with an empty write surface", () => {
    const bp = { ...base, tasks: [{ id: "T1", title: "cli", writeSurface: [], requirements: ["R1"], dependsOn: [], notes: "" }] };
    expect(BlueprintSchema.safeParse(bp).success).toBe(false);
  });

  test("rejects a write surface path that escapes the root", () => {
    const bp = { ...base, tasks: [{ id: "T1", title: "cli", writeSurface: ["../x.ts"], requirements: [], dependsOn: [], notes: "" }] };
    expect(BlueprintSchema.safeParse(bp).success).toBe(false);
  });
});
