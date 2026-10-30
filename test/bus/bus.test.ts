import { describe, expect, test } from "vitest";
import { defineRuntime, type SemanticEvent } from "@mozaik-ai/core";
import { FactoryState } from "../../src/state/factory-state.js";
import { Bus, EV } from "../../src/bus/events.js";
import { Actor } from "../../src/bus/actor.js";

function setup() {
  const rt = defineRuntime<FactoryState>();
  const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
  rt.initializeRuntime({ state });
  const bus = new Bus((e) => rt.resolveRuntime().publish(e));
  return { rt, bus };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("Bus", () => {
  test("a throwing handler does not stop delivery to other participants, and is reported", async () => {
    const { rt, bus } = setup();
    const seen: string[] = [];
    rt.join(new Actor("boom", [bus.on([EV.taskDone], () => { throw new Error("kaboom"); })]));
    rt.join(new Actor("ok", [bus.on([EV.taskDone], (e) => { seen.push(e.type); })]));
    rt.join(new Actor("errors", [bus.on([EV.runError], (e) => { seen.push(`${e.type}:${(e.payload as { message: string }).message}`); })]));
    bus.emit(EV.taskDone, "test", { taskId: "T1", candidate: "A", worker: "w", summary: "" });
    await tick();
    expect(seen).toContain("task.done");
    expect(seen).toContain("run.error:kaboom");
  });

  test("events emitted inside a handler arrive after the current fan-out completes", async () => {
    const { rt, bus } = setup();
    const order: string[] = [];
    rt.join(new Actor("first", [bus.on([EV.taskDone], () => { order.push("first:done"); bus.emit(EV.taskApproved, "first", { taskId: "T1", candidate: "A" }); })]));
    rt.join(new Actor("second", [bus.on([EV.taskDone, EV.taskApproved], (e: SemanticEvent) => { order.push(`second:${e.type}`); })]));
    bus.emit(EV.taskDone, "test", { taskId: "T1", candidate: "A", worker: "w", summary: "" });
    await tick();
    expect(order).toEqual(["first:done", "second:task.done", "second:task.approved"]);
  });

  test("on() ignores other event types", async () => {
    const { rt, bus } = setup();
    const seen: string[] = [];
    rt.join(new Actor("x", [bus.on([EV.taskApproved], (e) => { seen.push(e.type); })]));
    bus.emit(EV.taskDone, "test", { taskId: "T1", candidate: "A", worker: "w", summary: "" });
    await tick();
    expect(seen).toEqual([]);
  });
});
