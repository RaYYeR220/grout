import { EV } from "./bus/events.js";
import { ARBITER } from "./agents/prompts.js";
import { ROLE_LIMITS, VerdictSchema, type Verdict } from "./agents/roles.js";
import { spawnAgent } from "./agents/spawn.js";
import { REPORT_PATH, TEST_CMD, submitTool } from "./agents/tools.js";
import type { FactoryCtx } from "./runtime.js";
import { parseVitestJson, type VitestResult } from "./sandbox/parse.js";

const ACCEPTANCE = "test/acceptance/";

export function acceptanceTests(snapshot: Map<string, string>): Map<string, string> {
  return new Map([...snapshot].filter(([p]) => p.startsWith(ACCEPTANCE)));
}

/** The target's project with every candidate's acceptance tests, each file prefixed by its author: `A__name.test.ts`. */
export function unionSuite(target: Map<string, string>, suites: Map<string, Map<string, string>>): Map<string, string> {
  const files = new Map([...target].filter(([p]) => !p.startsWith(ACCEPTANCE)));
  for (const [author, tests] of suites) {
    for (const [path, content] of tests) files.set(`${ACCEPTANCE}${author}__${path.slice(ACCEPTANCE.length).replace(/\//g, "_")}`, content);
  }
  return files;
}

export function foreignFailures(results: VitestResult[], own: string): VitestResult[] {
  return results.filter((r) => (r.status === "fail" || r.status === "error") && !r.file.startsWith(`${ACCEPTANCE}${own}__`));
}

export type CandidateScore = { id: string; pass: number; total: number; green: boolean; costUsd: number };

export function selectCandidate(scores: CandidateScore[]): { winner: string; reason: string } {
  const ranked = [...scores].sort((a, b) => Number(b.green) - Number(a.green) || b.pass - a.pass || a.costUsd - b.costUsd);
  const [w, r] = ranked;
  if (!r) return { winner: w.id, reason: "only candidate" };
  const reason =
    w.green !== r.green
      ? `${w.id} released green, ${r.id} did not`
      : w.pass !== r.pass
        ? `${w.id} passes ${w.pass}/${w.total} of the combined suite, ${r.id} ${r.pass}/${r.total}`
        : `equal on the combined suite (${w.pass}/${w.total}); ${w.id} was cheaper`;
  return { winner: w.id, reason };
}

/** Runs the combined suite of every candidate against one candidate's implementation, in that candidate's sandbox. */
export async function runUnion(fc: FactoryCtx, target: string): Promise<VitestResult[]> {
  const suites = new Map([...fc.state.candidates].map(([id, c]) => [id, acceptanceTests(c.workspace.snapshot())]));
  const files = unionSuite(fc.state.candidate(target).workspace.snapshot(), suites);
  const sandbox = fc.sandboxFor(target);
  if (!sandbox) return [];
  const r = await sandbox.exec(files, TEST_CMD, { collect: [REPORT_PATH], timeoutMs: 300_000 });
  fc.bus.emit(EV.sandboxCommand, "conductor", { cmd: `[combined suite on ${target}] ${r.cmd}`, exitCode: r.exitCode, ms: r.durationMs, timedOut: r.timedOut, candidate: target });
  return r.outputs[REPORT_PATH] ? parseVitestJson(r.outputs[REPORT_PATH], "") : [];
}

/** One arbiter per disagreement: does the other team's test or this team's code follow the spec? */
export function arbitrateDisagreement(fc: FactoryCtx, candidate: string, failure: VitestResult, source: string): Promise<Verdict | undefined> {
  return new Promise((resolve) => {
    let verdict: Verdict | undefined;
    const h = spawnAgent(fc, {
      role: "arbiter",
      slot: "arbiter",
      candidate,
      tier: ROLE_LIMITS.arbiter.tier,
      instruction: ARBITER,
      tools: () => [
        submitTool("submit_verdict", "Hand in your ruling.", VerdictSchema, (v) => {
          verdict = v;
          fc.bus.emit(EV.verdictIssued, "arbiter", { candidate, testId: `${failure.file} > ${failure.title}`, ...v });
          return undefined;
        }),
      ],
      message: `Two independent teams built the same spec. A test written by the OTHER team fails on team ${candidate}'s implementation.

Test "${failure.title}" (${failure.file}):
${source || "(source not found)"}

Failure on team ${candidate}'s program:
${(failure.failure ?? "").slice(0, 1500)}

===== SPEC =====
${fc.state.spec}
===== END SPEC =====`,
      maxSteps: ROLE_LIMITS.arbiter.maxSteps,
    });
    void h.done.then(() => resolve(verdict));
  });
}
