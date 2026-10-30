import { FunctionCallOutputItem, type InferenceInput } from "@mozaik-ai/core";
import { spawnAgent } from "./agents/spawn.js";
import { fileTools } from "./agents/tools.js";
import { ScriptedRunner, developerText, say, toolCall } from "./llm/scripted-runner.js";
import { createFactory } from "./runtime.js";
import { FactoryState } from "./state/factory-state.js";

export type RaceMode = "naive" | "interlocked" | "sequential";
export type RaceOptions = { mode: RaceMode; runs: number; builders: number; seed: number; maxLatencyMs?: number };
export type RaceResult = {
  mode: RaceMode;
  runs: number;
  builders: number;
  trialsWithLoss: number;
  lostUpdates: number;
  missingLines: number;
  staleRefusals: number;
  meanWallMs: number;
};

const REGISTRY = "src/routes.ts";
const MARK = `----- current content of ${REGISTRY} -----\n`;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastOutput = (input: InferenceInput) =>
  (input.context.getItems().filter((i) => i instanceof FunctionCallOutputItem).at(-1) as FunctionCallOutputItem | undefined)?.output.text ?? "";

/**
 * One trial: K scripted builders each read the shared route registry and write it back with one more
 * line, with random "thinking" latency in between, exactly the read-modify-write an LLM builder does.
 * Real runtime, real gate, real workspace; only the model is scripted, so it costs nothing.
 */
async function trial(mode: RaceMode, builders: number, random: () => number, maxLatencyMs: number) {
  let stale = 0;
  const latency = () => Math.floor(random() * maxLatencyMs);
  const delays = new Map<string, number[]>();
  const script = async (input: InferenceInput, turn: number) => {
    const name = developerText(input).replace("builder ", "");
    const out = lastOutput(input);
    const plan = delays.get(name)!;
    if (turn === 0) {
      await sleep(plan[0]);
      return toolCall("read_file", { path: REGISTRY });
    }
    let base: string | undefined;
    if (turn === 1) base = out.split("\n").slice(1).join("\n");
    else if (out.startsWith("STALE")) {
      stale += 1;
      base = out.slice(out.indexOf(MARK) + MARK.length, out.lastIndexOf("\n----- end -----"));
    }
    if (base === undefined) return say("done");
    await sleep(plan[1]);
    return toolCall("write_file", { path: REGISTRY, content: `${base}register("${name}");\n` });
  };
  const state = new FactoryState({ runId: "race", spec: "", budgetUsd: 1, cas: mode !== "naive" });
  const fc = createFactory({ state, runner: new ScriptedRunner(script), models: { planner: "s", builder: "s", utility: "s" } });
  const ws = state.candidate("A").workspace;
  ws.commit("seed", REGISTRY, "// route registry\n");
  const names = Array.from({ length: builders }, (_, i) => `route${i + 1}`);
  for (const n of names) delays.set(n, [latency(), latency()]);
  const spawn = (name: string) =>
    spawnAgent(fc, {
      role: "builder",
      slot: `builder-${name}`,
      candidate: "A",
      tier: "builder",
      surface: [REGISTRY],
      instruction: `builder ${name}`,
      tools: (self) => fileTools({ fc, self, role: "builder", candidate: "A", slot: `builder-${name}`, surface: [REGISTRY] }),
      message: `register ${name}`,
    }).done;
  const started = Date.now();
  if (mode === "sequential") for (const n of names) await spawn(n);
  else await Promise.all(names.map(spawn));
  const wallMs = Date.now() - started;
  const final = ws.peek(REGISTRY)!.content;
  return { lost: ws.lostUpdates(), missing: names.filter((n) => !final.includes(`register("${n}")`)).length, stale, wallMs };
}

export async function raceHarness(opts: RaceOptions): Promise<RaceResult> {
  const random = rng(opts.seed);
  const res: RaceResult = { mode: opts.mode, runs: opts.runs, builders: opts.builders, trialsWithLoss: 0, lostUpdates: 0, missingLines: 0, staleRefusals: 0, meanWallMs: 0 };
  let wall = 0;
  for (let i = 0; i < opts.runs; i++) {
    const t = await trial(opts.mode, opts.builders, random, opts.maxLatencyMs ?? 25);
    res.lostUpdates += t.lost;
    res.missingLines += t.missing;
    res.staleRefusals += t.stale;
    if (t.missing > 0) res.trialsWithLoss += 1;
    wall += t.wallMs;
  }
  res.meanWallMs = Math.round(wall / opts.runs);
  return res;
}
