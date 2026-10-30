import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeGate } from "../../src/gates/gatekeeper.js";
import { Board } from "../../src/state/board.js";
import { Broker } from "../../src/participants/broker.js";
import { Conductor } from "../../src/participants/conductor.js";
import { ReviewDesk } from "../../src/participants/review.js";
import { Verifier } from "../../src/participants/verifier.js";
import { exportRun } from "../../src/export.js";
import { createFactory } from "../../src/runtime.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, developerText, say, toolCall } from "../../src/llm/scripted-runner.js";
import type { Sandbox } from "../../src/sandbox/types.js";
import type { Ledger } from "../../src/state/ledger.js";
import { makeRuntime, runRawAgent } from "../helpers/runtime.js";

const ledger: Ledger = {
  requirements: [{ id: "R1", kind: "behavior", statement: "x", specQuote: "x", examples: [] }],
  interface: { kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [] },
  ambiguities: [],
};
const task = { id: "T1", title: "t", writeSurface: ["src/cli.ts"], requirements: ["R1"], dependsOn: [], notes: "" };
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("a finished candidate stops working", () => {
  test("the gate ends a loop once its candidate is finished", async () => {
    let state!: ReturnType<typeof makeRuntime>["state"];
    const env = makeRuntime((_i, turn) => {
      if (turn === 0) state.finished.add("A");
      return toolCall("read_file", { path: "src/a.ts" });
    });
    state = env.state;
    const gate = makeGate({ agentId: "b", role: "builder", candidate: "A", state, maxSteps: 50, surface: ["src/a.ts"] });
    const tool = { type: "function" as const, name: "read_file", description: "", strict: false, parameters: { type: "object", properties: {} }, invoke: async () => "x" };
    expect(await runRawAgent(env.rt, { name: "b", tools: [tool], message: "go", gate })).toBe("STOPPED: the run is over");
  });

  test("the gate ends a loop once the deadline has passed", async () => {
    const env = makeRuntime(() => toolCall("read_file", { path: "src/a.ts" }), { deadlineMs: Date.now() - 1 });
    const gate = makeGate({ agentId: "b", role: "builder", candidate: "A", state: env.state, maxSteps: 50, surface: ["src/a.ts"] });
    const tool = { type: "function" as const, name: "read_file", description: "", strict: false, parameters: { type: "object", properties: {} }, invoke: async () => "x" };
    expect(await runRawAgent(env.rt, { name: "b", tools: [tool], message: "go", gate })).toBe("STOPPED: deadline reached");
  });

  test("the broker leases nothing for a finished candidate", async () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 5 });
    state.ledger = ledger;
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("done")), models: { planner: "m", builder: "m", utility: "m" } });
    state.candidate("A").board = new Board([task]);
    state.finished.add("A");
    const broker = new Broker(fc, { candidate: "A", builders: 1, testAuthors: 1, sequential: false });
    fc.rt.join(broker);
    fc.bus.emit("board.opened", "x", { candidate: "A", tasks: ["T1"], titles: {} });
    await settle();
    expect(state.agents.size).toBe(0);
  });
});

describe("a reviewer that never hands in a verdict", () => {
  test("is asked once more, then the task is approved so the run cannot hang on it", async () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 5 });
    state.ledger = ledger;
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("looks fine to me")), models: { planner: "m", builder: "m", utility: "m" } });
    const board = (state.candidate("A").board = new Board([task]));
    board.complete(board.lease("T1", "w"), "x", 1);
    const broker = new Broker(fc, { candidate: "A", builders: 1, testAuthors: 1, sequential: false });
    fc.rt.join(new ReviewDesk(fc, "A", broker));
    fc.bus.emit("task.done", "x", { candidate: "A", taskId: "T1", worker: "w", summary: "s" });
    await settle(150);
    expect([...state.agents.values()].filter((a) => a.role === "reviewer")).toHaveLength(2);
    expect(board.status("T1")).toBe("approved");
  });
});

describe("two candidates: a failure while scoring still ends the run", () => {
  test("the conductor resolves even when the combined suite cannot run", async () => {
    const broken: Sandbox = { kind: "local", init: async () => {}, installDeps: async () => { throw new Error("x"); }, exec: async () => { throw new Error("docker exec failed"); }, cleanRoom: async () => [], dispose: async () => {} };
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 5, candidates: ["A", "B"] });
    state.ledger = ledger;
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("x")), models: { planner: "m", builder: "m", utility: "m" }, sandbox: broken });
    const crews = new Map(
      ["A", "B"].map((id) => {
        const broker = new Broker(fc, { candidate: id, builders: 1, testAuthors: 1, sequential: false });
        return [id, { broker, verifier: new Verifier(fc, id, broker) }] as const;
      }),
    );
    const conductor = new Conductor(fc, crews, { title: "t", mode: "interlocked" });
    const finish = (conductor as unknown as { finish(c: string, r: string): Promise<void> }).finish.bind(conductor);
    await finish("A", "test");
    await finish("B", "test");
    const results = await Promise.race([conductor.done, settle(2000).then(() => "hung")]);
    expect(results).not.toBe("hung");
  });
});

describe("export", () => {
  test("writes the snapshot that was checked, not whatever is in the workspace now", () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 5 });
    const cand = state.candidate("A");
    cand.workspace.commit("x", "src/cli.ts", "checked");
    const checked = cand.workspace.snapshot();
    cand.workspace.commit("x", "src/cli.ts", "edited after the check");
    const out = mkdtempSync(join(tmpdir(), "exp-"));
    exportRun(state, cand, out, { runId: "r", title: "t", candidate: "A", status: { green: true, failingTests: [], uncovered: [], failingRequirements: [], unapproved: [], untestable: [] }, reason: "", wallMs: 0, costUsd: 0, agents: 0, mode: "m" }, {}, {}, checked);
    expect(readFileSync(join(out, "src/cli.ts"), "utf8")).toBe("checked");
    expect(existsSync(join(out, "RUN.md"))).toBe(true);
  });
});

void developerText;
