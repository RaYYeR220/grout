import { describe, expect, test } from "vitest";
import { triage } from "../src/triage.js";
import { releaseCheck } from "../src/participants/release.js";
import { Board } from "../src/state/board.js";
import { CandidateState } from "../src/state/factory-state.js";
import { requirementIdsOf } from "../src/state/test-matrix.js";
import type { Ledger } from "../src/state/ledger.js";

const ledger: Ledger = {
  requirements: [
    { id: "R1", kind: "cli-command", statement: "add", specQuote: "add <title>", examples: [] },
    { id: "R2", kind: "output-format", statement: "list", specQuote: "list prints", examples: [] },
    { id: "R3", kind: "non-functional", statement: "fast", specQuote: "fast", examples: [] },
  ],
  interface: { kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [] },
  ambiguities: [],
};

function candidate() {
  const c = new CandidateState("A", true);
  c.board = new Board([
    { id: "T1", title: "store", writeSurface: ["src/store.ts", "src/cli.ts"], requirements: ["R1"], dependsOn: [], notes: "" },
    { id: "T2", title: "list", writeSurface: ["src/list.ts", "src/cli.ts"], requirements: ["R2"], dependsOn: [], notes: "" },
  ]);
  return c;
}

const authorOf = (file: string) => (file.startsWith("test/acceptance/") ? "test-author-1" : undefined);

describe("triage", () => {
  test("a type error in an owned file goes to its task; in a shared file to every owner", () => {
    const routed = triage(
      { tsc: [{ file: "src/store.ts", line: 1, col: 1, code: "TS2322", message: "bad" }, { file: "src/cli.ts", line: 2, col: 1, code: "TS1", message: "x" }], tests: [] },
      candidate(),
      ledger,
      authorOf,
    );
    expect(routed.map((r) => r.to)).toEqual([
      { kind: "task", taskId: "T1" },
      { kind: "task", taskId: "T2" },
    ]);
    expect(routed[0].message).toContain("src/store.ts(1,1) TS2322: bad");
    expect(routed[0].message).toContain("src/cli.ts(2,1)");
  });

  test("a failing test goes to the owners of src files in its stack, else to the tasks of its requirements", () => {
    const routed = triage(
      {
        tsc: [],
        tests: [
          { file: "test/acceptance/a.test.ts", title: "[R2] list prints titles", status: "fail", failure: "expected 'a' to be 'b'", stackFiles: ["test/acceptance/a.test.ts"] },
          { file: "test/acceptance/a.test.ts", title: "[R1] add stores", status: "fail", failure: "boom", stackFiles: ["src/store.ts"] },
        ],
      },
      candidate(),
      ledger,
      authorOf,
    );
    expect(routed).toEqual([
      expect.objectContaining({ to: { kind: "task", taskId: "T2" }, requirementIds: ["R2"] }),
      expect.objectContaining({ to: { kind: "task", taskId: "T1" }, requirementIds: ["R1"] }),
    ]);
    expect(routed[0].message).toContain('spec: "list prints"');
  });

  test("a test file that cannot load, or a test without requirement ids, goes back to its author", () => {
    const routed = triage(
      {
        tsc: [],
        tests: [
          { file: "test/acceptance/b.test.ts", title: "(file failed to load)", status: "error", failure: "SyntaxError", stackFiles: [] },
          { file: "test/acceptance/a.test.ts", title: "no ids here", status: "fail", failure: "x", stackFiles: [] },
        ],
      },
      candidate(),
      ledger,
      authorOf,
    );
    expect(routed.map((r) => r.to)).toEqual([{ kind: "test-author", slot: "test-author-1" }]);
    expect(routed[0].message).toContain("SyntaxError");
    expect(routed[0].message).toContain("no ids here");
  });

  test("passing tests route nothing", () => {
    expect(triage({ tsc: [], tests: [{ file: "t", title: "[R1] ok", status: "pass", stackFiles: [] }] }, candidate(), ledger, authorOf)).toEqual([]);
  });
});

describe("releaseCheck", () => {
  const rec = (title: string, status: "pass" | "fail") => ({ id: title, file: "f", title, requirementIds: requirementIdsOf(title), status, rev: 1 });

  test("green only when every testable requirement has passing tests and every task is approved", () => {
    const c = candidate();
    c.matrix.update([rec("[R1] a", "pass"), rec("[R2] b", "pass")]);
    expect(releaseCheck(c, ledger).green).toBe(false);
    c.board!.complete(c.board!.lease("T1", "w"), "x");
    c.board!.approve("T1");
    c.board!.complete(c.board!.lease("T2", "w"), "x");
    c.board!.approve("T2");
    expect(releaseCheck(c, ledger)).toEqual({ green: true, failingTests: [], uncovered: [], failingRequirements: [], unapproved: [], untestable: ["R3"] });
  });

  test("lists what blocks the release", () => {
    const c = candidate();
    c.matrix.update([rec("[R1] a", "fail")]);
    expect(releaseCheck(c, ledger)).toMatchObject({ green: false, failingTests: ["[R1] a"], uncovered: ["R2"], failingRequirements: ["R1"], unapproved: ["T1", "T2"] });
  });

  test("a failed clean-room check blocks an otherwise green release", () => {
    const c = candidate();
    c.matrix.update([rec("[R1] a", "pass"), rec("[R2] b", "pass")]);
    for (const id of ["T1", "T2"]) {
      c.board!.complete(c.board!.lease(id, "w"), "x");
      c.board!.approve(id);
    }
    expect(releaseCheck(c, ledger, { ok: false, step: "npm ci" }).green).toBe(false);
  });
});
