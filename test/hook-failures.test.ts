import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseVitestJson } from "../src/sandbox/parse.js";
import { requirementIdsOf } from "../src/state/test-matrix.js";
import { summarizeTests } from "../src/agents/tools.js";
import { triage } from "../src/triage.js";
import { releaseCheck } from "../src/participants/release.js";
import { Board } from "../src/state/board.js";
import { CandidateState } from "../src/state/factory-state.js";
import type { Ledger } from "../src/state/ledger.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const report = fixture("vitest-hook.json");
const stdout = fixture("vitest-hook-stdout.txt");

describe("a suite whose beforeAll hook throws", () => {
  const results = parseVitestJson(report, "/runs/9", stdout);

  test("becomes an error record carrying the hook's error and every requirement id of the suite", () => {
    const err = results.find((r) => r.status === "error");
    expect(err).toMatchObject({ file: "test/hook.test.ts", title: "(suite did not run: a hook failed) [R1,R2,R3]", stackFiles: ["test/hook.test.ts"] });
    expect(err?.failure).toContain("server exited before listening on PORT=4321: EADDRINUSE");
  });

  test("its skipped tests stay visible as skipped", () => {
    expect(results.filter((r) => r.status === "skip").map((r) => r.title)).toEqual(["[R1] api > [R2] lists", "[R1] api > [R3] creates"]);
  });

  test("the summary agents read does not say all is well", () => {
    const s = summarizeTests(report, stdout);
    expect(s).toMatch(/^tests: 1 passed, 1 failing, 2 skipped \(of 4\)/);
    expect(s).toContain("EADDRINUSE");
  });

  test("requirement ids from the describe block and the test title are both counted", () => {
    expect(requirementIdsOf("[R1] api > [R2] lists")).toEqual(["R1", "R2"]);
    expect(requirementIdsOf("[R1,R3] a > b [R3]")).toEqual(["R1", "R3"]);
  });

  test("the failure is routed to the tasks that own those requirements and to the test's author", () => {
    const ledger: Ledger = {
      requirements: ["R1", "R2", "R3", "R4"].map((id) => ({ id, kind: "http-route" as const, statement: id, specQuote: id, examples: [] })),
      interface: { kind: "http", entry: "src/server.ts", invocation: "node dist/server.js", port: { env: "PORT", default: 3000 }, notes: [] },
      ambiguities: [],
    };
    const c = new CandidateState("A", true);
    c.board = new Board([
      { id: "T1", title: "server", writeSurface: ["src/server.ts"], requirements: ["R1", "R2"], dependsOn: [], notes: "" },
      { id: "T2", title: "store", writeSurface: ["src/store.ts"], requirements: ["R3", "R4"], dependsOn: [], notes: "" },
    ]);
    const routed = triage({ tsc: [], tests: results }, c, ledger, () => ({ kind: "test-author", slot: "test-author-1" }));
    expect(routed.map((r) => r.to)).toEqual([
      { kind: "task", taskId: "T1" },
      { kind: "task", taskId: "T2" },
      { kind: "test-author", slot: "test-author-1" },
    ]);
    expect(routed[0].message).toContain("EADDRINUSE");
  });

  test("skipped tests block a green release", () => {
    const c = new CandidateState("A", true);
    c.board = new Board([{ id: "T1", title: "x", writeSurface: ["src/a.ts"], requirements: ["R1"], dependsOn: [], notes: "" }]);
    c.board.complete(c.board.lease("T1", "w"), "x");
    c.board.approve("T1");
    c.matrix.update([{ id: "a", file: "f", title: "[R1] a", requirementIds: ["R1"], status: "skip", rev: 1 }]);
    const ledger: Ledger = { requirements: [{ id: "R1", kind: "behavior", statement: "x", specQuote: "x", examples: [] }], interface: { kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [] }, ambiguities: [] };
    expect(releaseCheck(c, ledger)).toMatchObject({ green: false, failingTests: ["[R1] a"] });
  });
});
