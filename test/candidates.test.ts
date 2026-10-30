import { describe, expect, test } from "vitest";
import { foreignFailures, selectCandidate, unionSuite } from "../src/candidates.js";
import { Workspace } from "../src/state/workspace.js";

describe("unionSuite", () => {
  test("puts both candidates' acceptance tests side by side on the target, prefixed by author", () => {
    const target = new Workspace();
    target.commit("x", "src/cli.ts", "impl");
    target.commit("x", "test/harness.ts", "h");
    target.commit("x", "test/acceptance/mine.test.ts", "own");
    const suites = new Map([
      ["A", new Map([["test/acceptance/mine.test.ts", "a-tests"]])],
      ["B", new Map([["test/acceptance/other.test.ts", "b-tests"]])],
    ]);
    const files = unionSuite(target.snapshot(), suites);
    expect([...files.keys()].sort()).toEqual(["src/cli.ts", "test/acceptance/A__mine.test.ts", "test/acceptance/B__other.test.ts", "test/harness.ts"]);
    expect(files.get("test/acceptance/B__other.test.ts")).toBe("b-tests");
  });
});

describe("foreignFailures", () => {
  test("keeps only the other team's failing tests", () => {
    const results = [
      { file: "test/acceptance/A__a.test.ts", title: "[R1] x", status: "fail" as const, stackFiles: [] },
      { file: "test/acceptance/B__b.test.ts", title: "[R2] y", status: "fail" as const, stackFiles: [] },
      { file: "test/acceptance/B__b.test.ts", title: "[R3] z", status: "pass" as const, stackFiles: [] },
    ];
    expect(foreignFailures(results, "A").map((r) => r.title)).toEqual(["[R2] y"]);
  });
});

describe("selectCandidate", () => {
  test("most union tests passing wins", () => {
    expect(selectCandidate([
      { id: "A", pass: 18, total: 20, green: true, costUsd: 0.1 },
      { id: "B", pass: 20, total: 20, green: true, costUsd: 0.3 },
    ])).toMatchObject({ winner: "B" });
  });

  test("a green release beats a higher raw count", () => {
    expect(selectCandidate([
      { id: "A", pass: 15, total: 16, green: true, costUsd: 0.1 },
      { id: "B", pass: 19, total: 22, green: false, costUsd: 0.1 },
    ]).winner).toBe("A");
  });

  test("ties go to the cheaper candidate, and the reason says so", () => {
    const s = selectCandidate([
      { id: "A", pass: 20, total: 20, green: true, costUsd: 0.4 },
      { id: "B", pass: 20, total: 20, green: true, costUsd: 0.2 },
    ]);
    expect(s.winner).toBe("B");
    expect(s.reason).toMatch(/cheaper/);
  });
});
