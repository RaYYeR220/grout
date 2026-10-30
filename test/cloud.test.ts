import { describe, expect, test } from "vitest";
import { attachCloud } from "../src/cloud.js";
import { createFactory } from "../src/runtime.js";
import { FactoryState } from "../src/state/factory-state.js";
import { ScriptedRunner, say } from "../src/llm/scripted-runner.js";

describe("attachCloud", () => {
  const factory = () =>
    createFactory({ state: new FactoryState({ runId: "t", spec: "", budgetUsd: 1 }), runner: new ScriptedRunner(() => say("x")), models: { planner: "m", builder: "m", utility: "m" } });

  test("is off without a key", async () => {
    expect(await attachCloud(factory(), {})).toBeUndefined();
  });

  test("with a key, bus events are shipped to the cloud endpoint", async () => {
    const posted: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const fc = factory();
    const cloud = await attachCloud(fc, { GROUT_MOZAIK_KEY: "pk_test" }, fakeFetch);
    expect(cloud).toBeDefined();
    fc.bus.emit("task.done", "x", { candidate: "A", taskId: "T1", worker: "w", summary: "s" });
    await new Promise((r) => setImmediate(r));
    await cloud!.end();
    expect(posted.join("\n")).toContain("task.done");
  });
});
