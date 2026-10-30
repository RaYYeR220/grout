import { describe, expect, test } from "vitest";
import { TestMatrix, requirementIdsOf } from "../../src/state/test-matrix.js";
import { Budget } from "../../src/state/budget.js";

describe("requirementIdsOf", () => {
  test("parses single and multiple ids from a title", () => {
    expect(requirementIdsOf("[R3] prints usage")).toEqual(["R3"]);
    expect(requirementIdsOf("[R3,R7] exits 2")).toEqual(["R3", "R7"]);
    expect(requirementIdsOf("[R3, R7] spaced")).toEqual(["R3", "R7"]);
    expect(requirementIdsOf("no ids here")).toEqual([]);
  });
});

describe("TestMatrix", () => {
  const rec = (title: string, status: "pass" | "fail") => ({
    id: `test/a.test.ts::${title}`,
    file: "test/a.test.ts",
    title,
    requirementIds: requirementIdsOf(title),
    status,
    rev: 1,
  });

  test("coverage splits covered, uncovered and failing", () => {
    const m = new TestMatrix();
    m.update([rec("[R1] ok", "pass"), rec("[R2] broken", "fail"), rec("[R2] other", "pass")]);
    expect(m.coverage(["R1", "R2", "R3"])).toEqual({ covered: ["R1"], uncovered: ["R3"], failing: ["R2"] });
  });

  test("update replaces the previous run entirely", () => {
    const m = new TestMatrix();
    m.update([rec("[R1] a", "fail")]);
    m.update([rec("[R1] b", "pass")]);
    expect(m.all().map((r) => r.title)).toEqual(["[R1] b"]);
    expect(m.coverage(["R1"]).covered).toEqual(["R1"]);
  });
});

describe("Budget", () => {
  test("tracks spend by task and role and trips at the cap", () => {
    const b = new Budget(1);
    b.add(0.4, { role: "builder", taskId: "T1", model: "m", agentId: "a" });
    b.add(0.3, { role: "builder", taskId: "T2", model: "m", agentId: "b" });
    b.add(0.2, { role: "reviewer", taskId: "T1", model: "m", agentId: "c" });
    expect(b.spent()).toBeCloseTo(0.9);
    expect(b.byTask()).toEqual({ T1: expect.closeTo(0.6), T2: expect.closeTo(0.3) });
    expect(b.byRole()).toEqual({ builder: expect.closeTo(0.7), reviewer: expect.closeTo(0.2) });
    expect(b.exceeded()).toBe(false);
    b.add(0.1, { role: "builder", model: "m", agentId: "a" });
    expect(b.exceeded()).toBe(true);
  });

  test("deadline", () => {
    const b = new Budget(1, 1000);
    expect(b.pastDeadline(999)).toBe(false);
    expect(b.pastDeadline(1000)).toBe(true);
    expect(new Budget(1).pastDeadline(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
