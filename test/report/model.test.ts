import { describe, expect, test } from "vitest";
import { buildReportModel } from "../../src/report/model.js";
import { renderHtml } from "../../src/report/html.js";
import type { TraceLine } from "../../src/participants/tracer.js";

const L = (t: number, type: string, payload: unknown, who: Partial<TraceLine> = {}): TraceLine => ({ t, type, producer: who.producer ?? "x", payload, ...who });
const agent = (id: string, role: string, slot: string, taskId?: string) => ({ producer: id, role: role as never, slot, taskId, candidate: "A" });

const trace: TraceLine[] = [
  L(1000, "run.started", { runId: "r1", title: "Hello", candidates: ["A"], mode: "interlocked" }),
  L(1000, "agent.spawned", { agentId: "an", role: "analyst", slot: "analyst", candidate: "A", model: "s", spawnedAt: 1000 }, agent("an", "analyst", "analyst")),
  L(1000, "agent.spawned", { agentId: "ar", role: "architect", slot: "architect", candidate: "A", model: "s", spawnedAt: 1000 }, agent("ar", "architect", "architect")),
  L(2000, "llm.call", { agentId: "an", model: "s", inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 0.01, ms: 900 }, agent("an", "analyst", "analyst")),
  L(2500, "ledger.ready", { requirements: 2, ambiguities: 0, items: [{ id: "R1", kind: "output-format", statement: "greets" }, { id: "R2", kind: "non-functional", statement: "fast" }] }),
  L(3000, "agent.ended", { agentId: "an", role: "analyst", slot: "analyst", candidate: "A", answer: "ok" }, agent("an", "analyst", "analyst")),
  L(4000, "board.opened", { candidate: "A", tasks: ["T1", "T2"], titles: { T1: "store", T2: "list" } }),
  L(4000, "agent.ended", { agentId: "ar", role: "architect", slot: "architect", candidate: "A", answer: "ok" }, agent("ar", "architect", "architect")),
  L(4000, "task.leased", { candidate: "A", taskId: "T1", worker: "builder-1", generation: 1 }),
  L(4000, "agent.spawned", { agentId: "b1", role: "builder", slot: "builder-1", candidate: "A", taskId: "T1", model: "h", spawnedAt: 4000 }, agent("b1", "builder", "builder-1", "T1")),
  L(4000, "task.leased", { candidate: "A", taskId: "T2", worker: "builder-2", generation: 1 }),
  L(4000, "agent.spawned", { agentId: "b2", role: "builder", slot: "builder-2", candidate: "A", taskId: "T2", model: "h", spawnedAt: 4000 }, agent("b2", "builder", "builder-2", "T2")),
  L(5000, "llm.call", { agentId: "b1", model: "h", inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.002, ms: 300 }, agent("b1", "builder", "builder-1", "T1")),
  L(5500, "workspace.stale", { candidate: "A", path: "src/cli.ts", current: 3, seen: 2, by: "builder-2(T2)", currentAuthor: "builder-1(T1)" }, agent("b2", "builder", "builder-2", "T2")),
  L(5600, "gate.rejected", { candidate: "A", agentId: "b2", tool: "write_file", rule: "write-surface", message: "src/a.ts belongs to task T1" }, agent("b2", "builder", "builder-2", "T2")),
  L(6000, "llm.call", { agentId: "b2", model: "h", inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.003, ms: 300 }, agent("b2", "builder", "builder-2", "T2")),
  L(7000, "task.done", { candidate: "A", taskId: "T1", worker: "builder-1", summary: "x" }),
  L(7000, "agent.ended", { agentId: "b1", role: "builder", slot: "builder-1", candidate: "A", taskId: "T1", answer: "done" }, agent("b1", "builder", "builder-1", "T1")),
  L(7500, "tests.ran", { candidate: "A", rev: 9, pass: 3, fail: 1, total: 4, tscErrors: 0, uncovered: [], ms: 500 }),
  L(7600, "task.reopened", { candidate: "A", taskId: "T1", reason: "failing checks" }),
  L(8000, "task.approved", { candidate: "A", taskId: "T2" }),
  L(9000, "agent.ended", { agentId: "b2", role: "builder", slot: "builder-2", candidate: "A", taskId: "T2", answer: "done" }, agent("b2", "builder", "builder-2", "T2")),
  L(9500, "release.checked", { candidate: "A", green: false, failingTests: ["[R1] greets"], uncovered: [], failingRequirements: ["R1"], unapproved: ["T1"], untestable: ["R2"] }),
];

describe("buildReportModel", () => {
  const m = buildReportModel(trace);

  test("run totals", () => {
    expect(m.run).toMatchObject({ title: "Hello", mode: "interlocked", wallMs: 8500, green: false, agents: 4, llmCalls: 3, staleRefusals: 1, gateRefusals: 1 });
    expect(m.run.costUsd).toBeCloseTo(0.015);
  });

  test("peak concurrency counts overlapping agents", () => {
    expect(m.run.peakConcurrency).toBe(2);
  });

  test("lanes group spans by slot, with cost per span", () => {
    const b2 = m.lanes.find((l) => l.lane === "builder-2")!;
    expect(b2.spans).toEqual([expect.objectContaining({ agentId: "b2", taskId: "T2", start: 4000, end: 9000, costUsd: 0.003, calls: 1 })]);
  });

  test("tasks carry time, cost, attempts and their reopen reasons", () => {
    expect(m.tasks.find((t) => t.taskId === "T1")).toMatchObject({ title: "store", attempts: 1, costUsd: 0.002, status: "open", reopens: ["failing checks"] });
    expect(m.tasks.find((t) => t.taskId === "T2")).toMatchObject({ title: "list", status: "approved", start: 4000, end: 8000, ms: 4000 });
  });

  test("requirement status comes from the last release check", () => {
    expect(m.requirements).toEqual([
      { id: "R1", kind: "output-format", statement: "greets", status: "fail" },
      { id: "R2", kind: "non-functional", statement: "fast", status: "not testable" },
    ]);
  });

  test("the html is self-contained and shows the headline facts", () => {
    const html = renderHtml(m);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("Hello");
    expect(html).toContain("src/cli.ts");
    expect(html).toContain("write-surface");
    expect(html).toMatch(/<svg/);
  });
});
