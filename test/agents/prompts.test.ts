import { describe, expect, test } from "vitest";
import { builderMessage, renderLedger, testAuthorMessage } from "../../src/agents/prompts.js";
import type { Ledger } from "../../src/state/ledger.js";

const ledger: Ledger = {
  requirements: [
    { id: "R1", kind: "output-format", statement: "greets", specQuote: "prints `Hello, <name>!`", examples: [{ input: "hello Ada", expected: "Hello, Ada!" }] },
    { id: "R2", kind: "exit-code", statement: "exit 2", specQuote: "exits with status 2", examples: [] },
  ],
  interface: { kind: "cli", entry: "src/cli.ts", binName: "hello", invocation: "hello <name>", notes: [] },
  ambiguities: [],
};

describe("prompts", () => {
  test("renderLedger keeps verbatim quotes and examples, filtered by id", () => {
    const r = renderLedger(ledger, ["R1"]);
    expect(r).toContain('spec: "prints `Hello, <name>!`"');
    expect(r).toContain("e.g. hello Ada → Hello, Ada!");
    expect(r).not.toContain("R2");
  });

  test("a reopened task carries its feedback history", () => {
    const m = builderMessage({ id: "T1", title: "cli", writeSurface: ["src/cli.ts"], requirements: ["R2"], dependsOn: [], notes: "" }, ledger, ["[R2] exit code was 1"]);
    expect(m).toContain("Your files (write surface): src/cli.ts");
    expect(m).toContain("exits with status 2");
    expect(m).toContain("- [R2] exit code was 1");
  });

  test("test authors get only their requirements plus the spec", () => {
    const m = testAuthorMessage("# Spec", ledger, ["R2"]);
    expect(m).toContain("R2 [exit-code]");
    expect(m).not.toContain("R1 [output-format]");
    expect(m).toContain("# Spec");
  });
});
