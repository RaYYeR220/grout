import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Conductor } from "../../src/participants/conductor.js";
import { createFactory } from "../../src/runtime.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, say } from "../../src/llm/scripted-runner.js";

describe("nudges", () => {
  test("every nudge reaches the live agents once and is logged as a human step", () => {
    const runDir = mkdtempSync(join(tmpdir(), "nudge-"));
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("x")), models: { planner: "m", builder: "m", utility: "m" } });
    state.agents.set("b1", { agentId: "b1", role: "builder", slot: "builder-1", candidate: "A", model: "m", spawnedAt: 0 });
    const conductor = new Conductor(fc, new Map(), { title: "t", mode: "interlocked", runDir });
    appendFileSync(join(runDir, "nudges.jsonl"), `${JSON.stringify({ at: 1, text: "use node:util parseArgs" })}\n`);
    conductor.pollNudges();
    conductor.pollNudges();
    expect(state.humanSteps).toEqual([{ at: 1, kind: "nudge", text: "use node:util parseArgs" }]);
    expect(state.takeInbox("b1")).toEqual(["[from human] use node:util parseArgs"]);
  });
});
