import { describe, expect, test } from "vitest";
import { RuntimeState } from "@mozaik-ai/core";
import { FactoryState } from "../../src/state/factory-state.js";

describe("FactoryState", () => {
  test("is a Mozaik RuntimeState with one candidate by default", () => {
    const s = new FactoryState({ runId: "r1", spec: "# spec", budgetUsd: 2 });
    expect(s).toBeInstanceOf(RuntimeState);
    expect([...s.candidates.keys()]).toEqual(["A"]);
    expect(s.candidate("A").workspace.rev).toBe(0);
  });

  test("naive mode builds candidates whose workspace has CAS off", () => {
    const s = new FactoryState({ runId: "r1", spec: "", budgetUsd: 2, candidates: ["A", "B"], cas: false });
    const ws = s.candidate("B").workspace;
    ws.commit("seed", "a", "1");
    ws.commit("x", "a", "2");
    expect(ws.lostUpdates()).toBe(1);
  });

  test("inbox queues messages per agent", () => {
    const s = new FactoryState({ runId: "r1", spec: "", budgetUsd: 2 });
    s.deliver("agent-1", "reviewer", "fix R2");
    s.deliver("agent-1", "verifier", "test failed");
    expect(s.takeInbox("agent-1")).toEqual(["[from reviewer] fix R2", "[from verifier] test failed"]);
    expect(s.takeInbox("agent-1")).toEqual([]);
  });
});
