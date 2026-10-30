import { describe, expect, test } from "vitest";
import { FunctionCallOutputItem, type InferenceInput } from "@mozaik-ai/core";
import { z } from "zod";
import { createFactory } from "../../src/runtime.js";
import { spawnAgent } from "../../src/agents/spawn.js";
import { fileTools, submitTool, summarizeTsc } from "../../src/agents/tools.js";
import { FactoryState } from "../../src/state/factory-state.js";
import { LedgerSchema } from "../../src/state/ledger.js";
import { ScriptedRunner, developerText, say, toolCall, type Script } from "../../src/llm/scripted-runner.js";

const models = { planner: "scripted", builder: "scripted", utility: "scripted" };
const lastOutput = (input: InferenceInput) =>
  (input.context.getItems().filter((i) => i instanceof FunctionCallOutputItem).at(-1) as FunctionCallOutputItem | undefined)?.output.text ?? "";

function factory(script: Script) {
  const state = new FactoryState({ runId: "t", spec: "", budgetUsd: 10 });
  return createFactory({ state, runner: new ScriptedRunner(script), models });
}

describe("workspace tools in live loops", () => {
  test("two builders race on one registry file: one STALE, then both changes land", async () => {
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const outputs: string[] = [];
    const script: Script = async (input, turn) => {
      const route = developerText(input).replace("builder ", "");
      if (turn === 0) return toolCall("read_file", { path: "src/routes.ts" });
      const out = lastOutput(input);
      outputs.push(out);
      if (turn === 1) {
        if (++reads === 2) release();
        await bothRead;
        const current = out.split("\n").slice(1).join("\n");
        return toolCall("write_file", { path: "src/routes.ts", content: `${current}register("${route}");\n` });
      }
      if (out.startsWith("STALE")) {
        const current = out.split("----- current content of src/routes.ts -----\n")[1].split("\n----- end -----")[0];
        return toolCall("write_file", { path: "src/routes.ts", content: `${current}register("${route}");\n` });
      }
      return say("done");
    };
    const fc = factory(script);
    const ws = fc.state.candidate("A").workspace;
    ws.commit("seed", "src/routes.ts", "// routes\n");
    const spawn = (route: string) =>
      spawnAgent(fc, {
        role: "builder",
        slot: `builder-${route}`,
        candidate: "A",
        tier: "builder",
        surface: ["src/routes.ts"],
        instruction: `builder ${route}`,
        tools: (self) => fileTools({ fc, self, role: "builder", candidate: "A", slot: `builder-${route}`, surface: ["src/routes.ts"] }),
        message: `register ${route}`,
      });
    await Promise.all([spawn("users").done, spawn("orders").done]);
    const final = ws.peek("src/routes.ts")!.content;
    expect(final).toContain('register("users")');
    expect(final).toContain('register("orders")');
    expect(outputs.filter((o) => o.startsWith("STALE"))).toHaveLength(1);
    expect(ws.lostUpdates()).toBe(0);
  });

  test("invalid arguments are answered with the schema problem", async () => {
    const seen: string[] = [];
    const fc = factory((input, turn) => {
      if (turn === 0) return toolCall("write_file", { path: "src/a.ts" });
      seen.push(lastOutput(input));
      return say("done");
    });
    await spawnAgent(fc, {
      role: "builder",
      slot: "b",
      candidate: "A",
      tier: "builder",
      surface: ["src/a.ts"],
      instruction: "b",
      tools: (self) => fileTools({ fc, self, role: "builder", candidate: "A", slot: "b", surface: ["src/a.ts"] }),
      message: "go",
    }).done;
    expect(seen[0]).toMatch(/^ERROR: invalid arguments: content:/);
  });

  test("spawned agents are registered, end, and announce it", async () => {
    const fc = factory(() => say("finished"));
    const events: string[] = [];
    fc.rt.join(new (await import("../../src/bus/actor.js")).Actor("rec", [fc.bus.on(["agent.spawned", "agent.ended"], (e) => { events.push(e.type); })]));
    const h = spawnAgent(fc, { role: "reviewer", slot: "reviewer", candidate: "A", tier: "planner", instruction: "r", tools: () => [], message: "go" });
    expect(await h.done).toBe("finished");
    await new Promise((r) => setImmediate(r));
    expect(fc.state.agents.get(h.agentId)?.endedAt).toBeDefined();
    expect(events).toEqual(["agent.spawned", "agent.ended"]);
  });
});

describe("submitTool", () => {
  test("validates against the ledger schema and reports the problem", async () => {
    const seen: string[] = [];
    const accepted: unknown[] = [];
    const fc = factory((input, turn) => {
      if (turn === 0) {
        return toolCall("submit_ledger", {
          requirements: [{ id: "R1", kind: "behavior", statement: "x", examples: [] }],
          interface: { kind: "cli", entry: "src/cli.ts", invocation: "node dist/cli.js", notes: [] },
          ambiguities: [],
        });
      }
      seen.push(lastOutput(input));
      return say("done");
    });
    await spawnAgent(fc, {
      role: "analyst",
      slot: "analyst",
      candidate: "A",
      tier: "planner",
      instruction: "a",
      tools: () => [submitTool("submit_ledger", "hand in", LedgerSchema, (l) => void accepted.push(l))],
      message: "go",
    }).done;
    expect(seen[0]).toMatch(/^ERROR: invalid arguments: requirements\.0\.specQuote/);
    expect(accepted).toEqual([]);
  });

  test("an accept callback can refuse with its own reason", async () => {
    const seen: string[] = [];
    const fc = factory((input, turn) => (turn === 0 ? toolCall("submit_x", { n: 3 }) : (seen.push(lastOutput(input)), say("done"))));
    await spawnAgent(fc, {
      role: "utility",
      slot: "u",
      candidate: "A",
      tier: "utility",
      instruction: "u",
      tools: () => [submitTool("submit_x", "x", z.object({ n: z.number() }), (v) => (v.n > 2 ? "n must be at most 2" : undefined))],
      message: "go",
    }).done;
    expect(seen[0]).toBe("ERROR: n must be at most 2. Fix it and call submit_x again.");
  });
});

describe("summarizeTsc", () => {
  test("puts the caller's own errors first", () => {
    const out = "src/b.ts(1,1): error TS1: other\nsrc/a.ts(2,2): error TS2: mine\n";
    const s = summarizeTsc(out, ["src/a.ts"]);
    expect(s.split("\n").slice(0, 2)).toEqual(["typecheck: 2 error(s), 1 in your files", "src/a.ts(2,2) TS2: mine"]);
  });
});
