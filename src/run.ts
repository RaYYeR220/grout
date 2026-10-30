import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DefaultInferenceRunner, type InferenceRunner } from "@mozaik-ai/core";
import { commitOutput, exportRun } from "./export.js";
import { GuardedRunner } from "./llm/guarded-runner.js";
import { pickPreset, type Quality, type Tier } from "./llm/presets.js";
import { buildModels } from "./llm/providers.js";
import { Broker } from "./participants/broker.js";
import { Conductor } from "./participants/conductor.js";
import { withEnvDoctor } from "./participants/env-doctor.js";
import { Supervisor } from "./participants/supervisor.js";
import { EV } from "./bus/events.js";
import { ReviewDesk } from "./participants/review.js";
import { Tracer } from "./participants/tracer.js";
import { Verifier } from "./participants/verifier.js";
import { createFactory, type FactoryCtx } from "./runtime.js";
import { createSandbox, type SandboxPreference } from "./sandbox/index.js";
import { renderHtml } from "./report/html.js";
import { buildReportModel } from "./report/model.js";
import { readTrace } from "./report/replay.js";
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
  makeSandbox?: () => Sandbox;
  verifierDebounceMs?: number;
  /** Extra participants (the live log) join the runtime before the run starts. */
  observe?: (fc: FactoryCtx) => void;
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

  let reportFix: (pattern: string, action: string, attempt: number) => void = () => {};
  const sandboxes = new Map<string, Sandbox>();
  for (const id of candidateIds) {
    const raw = opts.makeSandbox ? opts.makeSandbox() : await createSandbox(opts.sandbox ?? "auto");
    const sb = withEnvDoctor(raw, (p, a, n) => reportFix(p, a, n));
    await sb.init(candidateIds.length === 1 ? runId : `${runId}-${id}`);
    sandboxes.set(id, sb);
  }

  const state = new FactoryState({
    runId,
    spec,
    budgetUsd: opts.budgetUsd ?? (candidateIds.length === 2 ? 4 : 2),
    deadlineMs: opts.deadline?.getTime(),
    candidates: candidateIds,
    cas: mode !== "naive",
  });
  if (opts.note) state.humanSteps.push({ at: started, kind: "between-runs-fix", text: opts.note });

  const fc = createFactory({ state, runner, models, maxTokens: MAX_TOKENS, sandboxes });
  reportFix = (pattern, action, attempt) => fc.bus.emit(EV.envRemediated, "env-doctor", { pattern, action, attempt });
  const tracer = new Tracer(fc, join(runDir, "trace.jsonl"));
  fc.rt.join(tracer);
  opts.observe?.(fc);

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
  const supervisor = new Supervisor(fc);
  fc.rt.join(supervisor);
  const conductor = new Conductor(fc, crews, { title, mode, runDir });
  fc.rt.join(conductor);
  conductor.start();

  const finishes = await conductor.done;
  supervisor.dispose();
  const best =
    finishes.find((f) => f.candidate === conductor.selection?.winner) ??
    [...finishes].sort((a, b) => Number(b.status.green) - Number(a.status.green) || a.status.failingTests.length - b.status.failingTests.length)[0];
  const cand = state.candidate(best.candidate);
  const wallMs = Date.now() - started;
  // Let the last trace lines land before copying the trace.
  await new Promise((r) => setTimeout(r, 200));
  fc.bus.emit(EV.runFinished, "conductor", { candidate: best.candidate, status: best.status, outDir: resolve(opts.outDir) });
  await new Promise((r) => setTimeout(r, 50));
  const reportPath = join(runDir, "report.html");
  writeFileSync(reportPath, renderHtml(buildReportModel(readTrace(tracer.path))));
  const outDir = resolve(opts.outDir);
  exportRun(
    state,
    cand,
    outDir,
    { runId, title, candidate: best.candidate, status: best.status, reason: best.reason, wallMs, costUsd: state.budget.spent(), agents: state.agents.size, mode },
    best.dist,
    { trace: tracer.path, report: reportPath },
  );
  if (opts.commit) commitOutput(outDir, `factory output: ${title} (run ${runId}, ${best.status.green ? "green" : "incomplete"})`);
  for (const sb of sandboxes.values()) await sb.dispose();
  return { runId, status: best.status, reason: best.reason, outDir, runDir, costUsd: state.budget.spent(), wallMs, candidate: best.candidate, state };
}
