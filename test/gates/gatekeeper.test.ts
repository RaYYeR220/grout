import { describe, expect, test } from "vitest";
import { FunctionCallItem, FunctionCallOutputItem, UserMessageItem, type Tool } from "@mozaik-ai/core";
import { makeGate } from "../../src/gates/gatekeeper.js";
import { decide } from "../../src/gates/policies.js";
import { Board } from "../../src/state/board.js";
import { say, toolCall } from "../../src/llm/scripted-runner.js";
import { makeRuntime, runRawAgent } from "../helpers/runtime.js";

const echoTool = (name: string, calls: string[]): Tool => ({
  type: "function",
  name,
  description: name,
  strict: false,
  parameters: { type: "object", properties: {} },
  invoke: async (args) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    return "ok";
  },
});

const lastToolOutput = (input: { context: { getItems(): unknown[] } }) =>
  (input.context.getItems().filter((i) => i instanceof FunctionCallOutputItem).at(-1) as FunctionCallOutputItem | undefined)?.output.text ?? "";

describe("policies", () => {
  const board = new Board([
    { id: "T1", title: "a", writeSurface: ["src/a.ts"], requirements: [], dependsOn: [], notes: "" },
    { id: "T2", title: "b", writeSurface: ["src/b.ts"], requirements: [], dependsOn: [], notes: "" },
  ]);
  const base = { agentId: "x", candidate: "A", board, stopped: undefined, budgetExceeded: false };

  test("a builder may write only inside its surface, and the owner is named", () => {
    const ctx = { ...base, role: "builder" as const, taskId: "T1", surface: ["src/a.ts"] };
    expect(decide(ctx, "write_file", { path: "src/a.ts" })).toEqual({ allow: true });
    const d = decide(ctx, "write_file", { path: "src/b.ts" });
    expect(d).toMatchObject({ allow: false, rule: "write-surface" });
    expect(d.allow === false && d.message).toContain("T2");
    expect(d.allow === false && d.message).toContain("request_change");
  });

  test("locked project files are architect-only", () => {
    const ctx = { ...base, role: "builder" as const, taskId: "T1", surface: ["src/a.ts", "package.json"] };
    expect(decide(ctx, "edit_file", { path: "package.json" })).toMatchObject({ allow: false, rule: "locked" });
    expect(decide({ ...base, role: "architect" as const }, "write_file", { path: "package.json" })).toEqual({ allow: true });
  });

  test("test authors are black-box: no reading src, writing only under test/", () => {
    const ctx = { ...base, role: "test-author" as const };
    expect(decide(ctx, "read_file", { path: "src/a.ts" })).toMatchObject({ allow: false, rule: "black-box" });
    expect(decide(ctx, "list_files", { prefix: "src/" })).toMatchObject({ allow: false, rule: "black-box" });
    expect(decide(ctx, "write_file", { path: "test/acceptance/a.test.ts" })).toEqual({ allow: true });
    expect(decide(ctx, "write_file", { path: "src/a.ts" })).toMatchObject({ allow: false, rule: "write-surface" });
    expect(decide(ctx, "write_file", { path: "test/harness.ts" })).toMatchObject({ allow: false, rule: "locked" });
  });

  test("reviewers and arbiters never write", () => {
    expect(decide({ ...base, role: "reviewer" as const }, "write_file", { path: "src/a.ts" })).toMatchObject({ allow: false, rule: "read-only-role" });
  });

  test("a stopped agent or an exhausted budget blocks every tool", () => {
    const ctx = { ...base, role: "builder" as const, taskId: "T1", surface: ["src/a.ts"] };
    expect(decide({ ...ctx, stopped: "stalled" }, "read_file", { path: "src/a.ts" })).toMatchObject({ allow: false, rule: "stopped" });
    expect(decide({ ...ctx, budgetExceeded: true }, "read_file", { path: "src/a.ts" })).toMatchObject({ allow: false, rule: "budget" });
  });

  test("an invalid path is refused, not thrown", () => {
    const ctx = { ...base, role: "builder" as const, taskId: "T1", surface: ["src/a.ts"] };
    expect(decide(ctx, "write_file", { path: "../etc/x" })).toMatchObject({ allow: false, rule: "path" });
  });
});

describe("gate in a live loop", () => {
  test("a denied call never reaches the tool; the model sees the announced rule", async () => {
    const calls: string[] = [];
    const seen: string[] = [];
    const { rt, state } = makeRuntime((input, turn) => {
      if (turn === 0) return toolCall("read_file", { path: "src/secret.ts" });
      seen.push(lastToolOutput(input));
      return say("done");
    });
    const gate = makeGate({ agentId: "ta", role: "test-author", candidate: "A", state, maxSteps: 10 });
    await runRawAgent(rt, { name: "ta", tools: [echoTool("read_file", calls)], message: "go", gate });
    expect(calls).toEqual([]);
    expect(seen[0]).toMatch(/^REJECTED \[black-box\]/);
  });

  test("truncated JSON arguments get a clear message and the loop continues", async () => {
    const seen: string[] = [];
    const { rt, state } = makeRuntime((input, turn) => {
      if (turn === 0) return toolCall("write_file", '{"path":"test/a.test.ts","content":"import');
      seen.push(lastToolOutput(input));
      return say("done");
    });
    const gate = makeGate({ agentId: "ta", role: "test-author", candidate: "A", state, maxSteps: 10 });
    const answer = await runRawAgent(rt, { name: "ta", tools: [echoTool("write_file", [])], message: "go", gate });
    expect(answer).toBe("done");
    expect(seen[0]).toMatch(/REJECTED \[valid-json\].*truncated/s);
  });

  test("a call with empty arguments is treated as {} (models send '' for no-argument tools)", async () => {
    const calls: string[] = [];
    const { rt, state } = makeRuntime((_input, turn) => (turn === 0 ? toolCall("list_files", "") : say("done")));
    const gate = makeGate({ agentId: "a", role: "architect", candidate: "A", state, maxSteps: 10 });
    await runRawAgent(rt, { name: "a", tools: [echoTool("list_files", calls)], message: "go", gate });
    expect(calls).toEqual(["list_files:{}"]);
  });

  test("a refused call is kept in the context with valid arguments, never the broken string", async () => {
    let calls: string[] = [];
    const { rt, state } = makeRuntime((input, turn) => {
      if (turn === 0) return toolCall("write_file", '{"path":"test/a.test.ts","content":"imp');
      calls = input.context.getItems().filter((i) => i instanceof FunctionCallItem).map((i) => (i as FunctionCallItem).args);
      return say("done");
    });
    const gate = makeGate({ agentId: "ta", role: "test-author", candidate: "A", state, maxSteps: 10 });
    await runRawAgent(rt, { name: "ta", tools: [echoTool("write_file", [])], message: "go", gate });
    expect(calls).toEqual(["{}"]);
  });

  test("a call without any arguments field does not kill the loop", async () => {
    const tools: string[] = [];
    const { rt, state } = makeRuntime((_input, turn) =>
      turn === 0 ? { items: [FunctionCallItem.rehydrate({ callId: "c1", name: "list_files", args: undefined as unknown as string })], tokenUsage: undefined, rowResponse: {} } : say("done"),
    );
    const gate = makeGate({ agentId: "a", role: "architect", candidate: "A", state, maxSteps: 10 });
    expect(await runRawAgent(rt, { name: "a", tools: [echoTool("list_files", tools)], message: "go", gate })).toBe("done");
    expect(tools).toEqual(["list_files:{}"]);
  });

  test("inbox messages reach a running agent before its next inference", async () => {
    const seenUserTexts: string[][] = [];
    let state!: ReturnType<typeof makeRuntime>["state"];
    const env = makeRuntime((input, turn) => {
      seenUserTexts.push(input.context.getItems().filter((i) => i instanceof UserMessageItem).map((i) => (i as UserMessageItem).content.text));
      if (turn === 0) {
        state.deliver("b1", "reviewer", "fix R2");
        return toolCall("read_file", { path: "src/a.ts" });
      }
      return say("done");
    });
    state = env.state;
    const gate = makeGate({ agentId: "b1", role: "builder", candidate: "A", state, maxSteps: 10, surface: ["src/a.ts"], bus: env.bus });
    await runRawAgent(env.rt, { name: "b1", tools: [echoTool("read_file", [])], message: "start", gate });
    expect(seenUserTexts[1]).toContain("[from reviewer] fix R2");
    await new Promise((r) => setImmediate(r));
    expect(env.events.some((e) => e.type === "inbox.delivered")).toBe(true);
  });

  test("the step limit ends a runaway loop cleanly", async () => {
    const { rt, state } = makeRuntime(() => toolCall("read_file", { path: "src/a.ts" }));
    const gate = makeGate({ agentId: "b1", role: "builder", candidate: "A", state, maxSteps: 3, surface: ["src/a.ts"] });
    const answer = await runRawAgent(rt, { name: "b1", tools: [echoTool("read_file", [])], message: "go", gate });
    expect(answer).toMatch(/^STOPPED: step limit/);
  });

  test("a stopped agent is ended at its next inference", async () => {
    let state!: ReturnType<typeof makeRuntime>["state"];
    const env = makeRuntime((_input, turn) => {
      if (turn === 0) state.stopped.set("b1", "supervisor: stalled");
      return toolCall("read_file", { path: "src/a.ts" });
    });
    state = env.state;
    const gate = makeGate({ agentId: "b1", role: "builder", candidate: "A", state, maxSteps: 50, surface: ["src/a.ts"] });
    const answer = await runRawAgent(env.rt, { name: "b1", tools: [echoTool("read_file", [])], message: "go", gate });
    expect(answer).toBe("STOPPED: supervisor: stalled");
  });
});
