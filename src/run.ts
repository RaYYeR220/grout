import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DefaultInferenceRunner, type InferenceRunner } from "@mozaik-ai/core";
import { commitOutput, exportRun } from "./export.js";
import { GuardedRunner } from "./llm/guarded-runner.js";
import { pickPreset, type Quality, type Tier } from "./llm/presets.js";
import { buildModels } from "./llm/providers.js";
import { Broker } from "./participants/broker.js";
import { Conductor } from "./participants/conductor.js";
import { ReviewDesk } from "./participants/review.js";
import { Tracer } from "./participants/tracer.js";
import { Verifier } from "./participants/verifier.js";
import { createFactory } from "./runtime.js";
import { createSandbox, type SandboxPreference } from "./sandbox/index.js";
import type { Sandbox } from "./sandbox/types.js";
import { FactoryState, type ReleaseStatus } from "./state/factory-state.js";

export type Mode = "interlocked" | "naive" | "sequential";

export type RunOptions = {
  specPath: string;
  outDir: string;
  runsDir?: string;
  candidates?: 1 | 2;
  builders?: number;
  testAuthors?: number;
  budgetUsd?: number;
  deadline?: Date;
  sandbox?: SandboxPreference;
  mode?: Mode;
  quality?: Quality;
  note?: string;
  commit?: boolean;
  env?: Record<string, string | undefined>;
  /** Tests and the race harness inject a scripted runner and a sandbox. */
  runnerOverride?: InferenceRunner;
  sandboxOverride?: Sandbox;
  verifierDebounceMs?: number;
};

export type RunResult = {
  runId: string;
  status: ReleaseStatus;
  reason: string;
  outDir: string;
  runDir: string;
  costUsd: number;
  wallMs: number;
  candidate: string;
  state: FactoryState;
};

const MAX_TOKENS: Record<Tier, number> = { planner: 16000, builder: 16000, utility: 4000 };

export function specTitle(spec: string, path: string): string {
  return spec.match(/^#\s+(.+)$/m)?.[1].trim() ?? basename(path).replace(/\.md$/i, "");
}

export async function runFactory(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const env = opts.env ?? process.env;
  const spec = readFileSync(opts.specPath, "utf8");
  const title = specTitle(spec, opts.specPath);
  const runId = `${new Date(started).toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`;
  const runDir = resolve(opts.runsDir ?? "runs", runId);
  const mode = opts.mode ?? "interlocked";
  const candidateIds = opts.candidates === 2 ? ["A", "B"] : ["A"];

  let models: Record<Tier, string>;
  let runner: InferenceRunner;
  if (opts.runnerOverride) {
    models = { planner: "scripted", builder: "scripted", utility: "scripted" };
    runner = opts.runnerOverride;
  } else {
    const preset = pickPreset(env, opts.quality ?? "economy");
    models = preset.models;
    // The runtime's validator is not exported; requests are shaped by our own model specifications.
    const inner = new DefaultInferenceRunner(buildModels(preset, MAX_TOKENS, env), { validate() {} } as never);
    runner = new GuardedRunner(inner, { timeoutMs: 240_000, retries: 3 });
  }

  const sandbox = opts.sandboxOverride ?? (await createSandbox(opts.sandbox ?? "auto"));
  await sandbox.init(runId);

  const state = new FactoryState({
    runId,
    spec,
    budgetUsd: opts.budgetUsd ?? (candidateIds.length === 2 ? 4 : 2),
    deadlineMs: opts.deadline?.getTime(),
    candidates: candidateIds,
    cas: mode !== "naive",
  });
  if (opts.note) state.humanSteps.push({ at: started, kind: "between-runs-fix", text: opts.note });

  const fc = createFactory({ state, runner, models, maxTokens: MAX_TOKENS, sandbox });
  const tracer = new Tracer(fc, join(runDir, "trace.jsonl"));
  fc.rt.join(tracer);

  const crews = new Map<string, { broker: Broker; verifier: Verifier }>();
  for (const id of candidateIds) {
    const broker = new Broker(fc, {
      candidate: id,
      builders: mode === "sequential" ? 1 : (opts.builders ?? 3),
      testAuthors: opts.testAuthors ?? 2,
      sequential: mode === "sequential",
      builderModel: id === "B" ? models.planner : undefined,
    });
    const verifier = new Verifier(fc, id, broker, opts.verifierDebounceMs);
    fc.rt.join(broker);
    fc.rt.join(verifier);
    fc.rt.join(new ReviewDesk(fc, id, broker));
    crews.set(id, { broker, verifier });
  }
  const conductor = new Conductor(fc, crews, { title, mode });
  fc.rt.join(conductor);
  conductor.start();

  const finishes = await conductor.done;
  const best = [...finishes].sort((a, b) => Number(b.status.green) - Number(a.status.green) || a.status.failingTests.length - b.status.failingTests.length)[0];
  const cand = state.candidate(best.candidate);
  const wallMs = Date.now() - started;
  // Let the last trace lines land before copying the trace.
  await new Promise((r) => setTimeout(r, 200));
  const outDir = resolve(opts.outDir);
  exportRun(
    state,
    cand,
    outDir,
    { runId, title, candidate: best.candidate, status: best.status, reason: best.reason, wallMs, costUsd: state.budget.spent(), agents: state.agents.size, mode },
    best.dist,
    { trace: tracer.path },
  );
  if (opts.commit) commitOutput(outDir, `factory output: ${title} (run ${runId}, ${best.status.green ? "green" : "incomplete"})`);
  await sandbox.dispose();
  return { runId, status: best.status, reason: best.reason, outDir, runDir, costUsd: state.budget.spent(), wallMs, candidate: best.candidate, state };
}
