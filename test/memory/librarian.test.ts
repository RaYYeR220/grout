import { describe, expect, test } from "vitest";
import { Librarian } from "../../src/participants/librarian.js";
import { createFactory } from "../../src/runtime.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, developerText, say, toolCall } from "../../src/llm/scripted-runner.js";
import { builderInstruction } from "../../src/agents/prompts.js";
import type { MemoryStore } from "../../src/memory/store.js";

function memory(initial: string[]): MemoryStore & { stored: string[] } {
  const stored: string[] = [];
  return { kind: "local", stored, recall: async () => initial, remember: async (l) => void stored.push(l) };
}

describe("Librarian", () => {
  test("recalled lessons reach the builders' instructions", async () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    const fc = createFactory({ state, runner: new ScriptedRunner(() => say("x")), models: { planner: "m", builder: "m", utility: "m" } });
    const lib = new Librarian(fc, memory(["relative imports end in .js"]));
    await lib.recall();
    expect(state.lessons).toEqual(["relative imports end in .js"]);
    expect(builderInstruction(state.lessons)).toContain("- relative imports end in .js");
  });

  test("after a run with failures, a utility agent distils lessons that are stored", async () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    const fc = createFactory({
      state,
      runner: new ScriptedRunner((input, turn) => {
        expect(developerText(input)).toContain("lessons");
        return turn === 0 ? toolCall("submit_lessons", { lessons: ["write the shebang line in the CLI entry", "exit codes come from the spec, not convention"] }) : say("done");
      }),
      models: { planner: "m", builder: "m", utility: "m" },
    });
    const store = memory([]);
    const lib = new Librarian(fc, store);
    fc.rt.join(lib);
    fc.bus.emit("task.reopened", "verifier", { candidate: "A", taskId: "T1", reason: "test [R2] expected exit code 2, got 1" });
    await new Promise((r) => setTimeout(r, 20));
    await lib.distill();
    expect(store.stored).toEqual(["write the shebang line in the CLI entry", "exit codes come from the spec, not convention"]);
  });

  test("a clean run stores nothing and spends nothing", async () => {
    const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 1 });
    const fc = createFactory({ state, runner: new ScriptedRunner(() => { throw new Error("must not be called"); }), models: { planner: "m", builder: "m", utility: "m" } });
    const store = memory([]);
    await new Librarian(fc, store).distill();
    expect(store.stored).toEqual([]);
  });
});
