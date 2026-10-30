import { describe, expect, test } from "vitest";
import { Board } from "../../src/state/board.js";
import { Broker } from "../../src/participants/broker.js";
import { Verifier, reopenable } from "../../src/participants/verifier.js";
import { createFactory } from "../../src/runtime.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, say } from "../../src/llm/scripted-runner.js";
import type { Sandbox, CmdResult } from "../../src/sandbox/types.js";
import type { Ledger } from "../../src/state/ledger.js";

const ledger: Ledger = {
  requirements: [{ id: "R1", kind: "behavior", statement: "x", specQuote: "x", examples: [] }],
  interface: { kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [] },
  ambiguities: [],
};
const task = { id: "T1", title: "t", writeSurface: ["src/cli.ts"], requirements: ["R1"], dependsOn: [], notes: "" };
const settle = () => new Promise((r) => setTimeout(r, 30));

function factory(sandbox?: Sandbox) {
  const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 5 });
  state.ledger = ledger;
  const fc = createFactory({ state, runner: new ScriptedRunner(() => say("done")), models: { planner: "m", builder: "m", utility: "m" }, ...(sandbox ? { sandbox } : {}) });
  return { state, fc };
}

describe("verifier results are not applied to work that is newer than the run", () => {
  test("a task completed after the run's snapshot is not reopened by that run", () => {
    const b = new Board([task]);
    b.complete(b.lease("T1", "w"), "x", 12);
    expect(b.doneRev("T1")).toBe(12);
    expect(reopenable(b, "T1", 10)).toBe(false);
    expect(reopenable(b, "T1", 12)).toBe(true);
  });
});

describe("broker limits", () => {
  test("a provider failure reopens the task without counting an attempt", () => {
    const b = new Board([task]);
    b.lease("T1", "w");
    b.reopen("T1", "inference failed", { countAttempt: false });
    expect(b.attempts("T1")).toBe(0);
    expect(b.feedback("T1")).toEqual(["inference failed"]);
  });

  test("a test author is revised at most three times", async () => {
    const { state, fc } = factory();
    const cand = state.candidate("A");
    cand.board = new Board([task]);
    const broker = new Broker(fc, { candidate: "A", builders: 1, testAuthors: 1, sequential: false });
    fc.rt.join(broker);
    for (let i = 0; i < 5; i++) {
      broker.reviseTests("test-author-1", `fix ${i}`);
      await settle();
    }
    expect([...state.agents.values()].filter((a) => a.role === "test-author")).toHaveLength(3);
  });

  test("a task is not spawned more than its cap", () => {
    const b = new Board([task]);
    for (let i = 0; i < 12; i++) {
      if (b.status("T1") === "ready") b.lease("T1", "w");
      b.reopen("T1", "again", { countAttempt: false });
    }
    expect(b.leases("T1")).toBe(12);
  });
});

describe("a test run that times out", () => {
  test("keeps the previous matrix and is marked incomplete", async () => {
    const timedOut: CmdResult = { cmd: "x", exitCode: 137, stdout: "", stderr: "", durationMs: 240000, timedOut: true, outputs: {} };
    const sandbox: Sandbox = { kind: "local", init: async () => {}, installDeps: async () => timedOut, exec: async () => timedOut, cleanRoom: async () => [timedOut], dispose: async () => {} };
    const { state, fc } = factory(sandbox);
    const cand = state.candidate("A");
    cand.board = new Board([task]);
    cand.workspace.commit("x", "package.json", "{}");
    cand.matrix.update([{ id: "a", file: "f", title: "[R1] a", requirementIds: ["R1"], status: "pass", rev: 1 }]);
    const broker = new Broker(fc, { candidate: "A", builders: 1, testAuthors: 1, sequential: false });
    const v = new Verifier(fc, "A", broker, 1);
    await v.run();
    expect(cand.matrix.all()).toHaveLength(1);
    expect(v.lastRun).toMatchObject({ incomplete: true });
  });
});
