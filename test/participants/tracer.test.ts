import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFactory } from "../../src/runtime.js";
import { spawnAgent } from "../../src/agents/spawn.js";
import { Tracer } from "../../src/participants/tracer.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, say } from "../../src/llm/scripted-runner.js";

describe("Tracer", () => {
  test("prices every inference, charges the budget per task, and keeps lines small", async () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 10 });
    const runner = new ScriptedRunner(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { ...say("ok"), rowResponse: { cost: { usd: 0.25 } } };
    });
    const fc = createFactory({ state, runner, models: { planner: "m", builder: "m", utility: "m" } });
    const path = join(mkdtempSync(join(tmpdir(), "trace-")), "trace.jsonl");
    fc.rt.join(new Tracer(fc, path));
    await Promise.all([
      spawnAgent(fc, { role: "builder", slot: "builder-1", candidate: "A", tier: "builder", taskId: "T1", instruction: "x".repeat(50_000), tools: () => [], message: "go" }).done,
      spawnAgent(fc, { role: "reviewer", slot: "reviewer", candidate: "A", tier: "planner", taskId: "T2", instruction: "r", tools: () => [], message: "go" }).done,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const calls = lines.filter((l) => l.type === "llm.call");
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.payload.costUsd === 0.25 && c.payload.ms >= 10)).toBe(true);
    expect(state.budget.byTask()).toEqual({ T1: 0.25, T2: 0.25 });
    expect(Math.max(...lines.map((l) => JSON.stringify(l).length))).toBeLessThan(5000);
    expect(lines.find((l) => l.type === "interception.started")?.payload).toEqual({ nextStateId: "message_received" });
  });
});
