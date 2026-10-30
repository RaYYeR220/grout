import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { exportRun } from "../src/export.js";
import { normalizePath, PathError } from "../src/paths.js";
import { buildReportModel } from "../src/report/model.js";
import { Conductor } from "../src/participants/conductor.js";
import { createFactory } from "../src/runtime.js";
import { FactoryState } from "../src/state/factory-state.js";
import { ScriptedRunner, say } from "../src/llm/scripted-runner.js";
import type { TraceLine } from "../src/participants/tracer.js";

const summary = { runId: "r", title: "t", candidate: "A", status: { green: true, failingTests: [], uncovered: [], failingRequirements: [], unapproved: [], untestable: [] }, reason: "", wallMs: 0, costUsd: 0, agents: 0, mode: "m" };

describe("export into an existing directory", () => {
  test("a previous factory output is replaced, not merged with", () => {
    const out = mkdtempSync(join(tmpdir(), "exp-"));
    mkdirSync(join(out, "src"), { recursive: true });
    writeFileSync(join(out, "RUN.md"), "old run");
    writeFileSync(join(out, "src/old-module.ts"), "stale");
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    state.candidate("A").workspace.commit("x", "src/cli.ts", "new");
    exportRun(state, state.candidate("A"), out, summary, {}, {});
    expect(existsSync(join(out, "src/old-module.ts"))).toBe(false);
    expect(existsSync(join(out, "src/cli.ts"))).toBe(true);
  });

  test("a directory that is not a factory output is never wiped", () => {
    const out = mkdtempSync(join(tmpdir(), "exp-"));
    writeFileSync(join(out, "precious.txt"), "keep me");
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    expect(() => exportRun(state, state.candidate("A"), out, summary, {}, {})).toThrow(/not a previous output/);
    expect(existsSync(join(out, "precious.txt"))).toBe(true);
  });
});

describe("report with two candidates", () => {
  const L = (t: number, type: string, payload: unknown, extra: Partial<TraceLine> = {}): TraceLine => ({ t, type, producer: "x", payload, ...extra });
  const trace: TraceLine[] = [
    L(0, "run.started", { runId: "r", title: "T", candidates: ["A", "B"], mode: "interlocked" }),
    L(1, "board.opened", { candidate: "A", tasks: ["T1"], titles: { T1: "a-store" } }),
    L(1, "board.opened", { candidate: "B", tasks: ["T1"], titles: { T1: "b-store" } }),
    L(2, "task.approved", { candidate: "A", taskId: "T1" }),
    L(3, "release.checked", { candidate: "A", green: true, failingTests: [], uncovered: [], failingRequirements: [], unapproved: [], untestable: [] }),
    L(4, "release.checked", { candidate: "B", green: false, failingTests: ["x"], uncovered: [], failingRequirements: ["R1"], unapproved: ["T1"], untestable: [] }),
    L(5, "run.finished", { candidate: "A", outDir: "o", status: { green: true, failingTests: [], uncovered: [], failingRequirements: [], unapproved: [], untestable: [] } }),
  ];

  test("tasks of different teams are kept apart and the status is the exported candidate's", () => {
    const m = buildReportModel(trace);
    expect(m.tasks.map((t) => [t.taskId, t.title, t.status])).toEqual([
      ["A:T1", "a-store", "approved"],
      ["B:T1", "b-store", "open"],
    ]);
    expect(m.run.green).toBe(true);
  });
});

describe("hardening", () => {
  test("a malformed nudge line is skipped, not fatal", () => {
    const runDir = mkdtempSync(join(tmpdir(), "nudge-"));
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("x")), models: { planner: "m", builder: "m", utility: "m" } });
    const conductor = new Conductor(fc, new Map(), { title: "t", mode: "m", runDir });
    appendFileSync(join(runDir, "nudges.jsonl"), `{not json\n${JSON.stringify({ at: 2, text: "ok" })}\n`);
    expect(() => conductor.pollNudges()).not.toThrow();
    expect(state.humanSteps.map((h) => h.text)).toEqual(["ok"]);
  });

  test.each([" src/a.ts", "src/a.ts ", "src/a\u0000.ts", "src/a\n.ts", `src/${"x".repeat(220)}.ts`])("rejects the path %j", (p) => {
    expect(() => normalizePath(p)).toThrow(PathError);
  });
});
