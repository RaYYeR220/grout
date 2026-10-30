import type { TraceLine } from "../participants/tracer.js";
import type { Role } from "../state/factory-state.js";

export type Span = { agentId: string; role: Role; lane: string; taskId?: string; model: string; start: number; end: number; costUsd: number; calls: number; answer: string };
export type TaskRow = { taskId: string; title: string; candidate: string; attempts: number; start?: number; end?: number; ms?: number; costUsd: number; status: "approved" | "open"; reopens: string[] };
export type ReqRow = { id: string; kind: string; statement: string; status: "pass" | "fail" | "untested" | "not testable" | "unknown" };

export type ReportModel = {
  run: {
    runId: string;
    title: string;
    mode: string;
    candidates: string[];
    start: number;
    end: number;
    wallMs: number;
    costUsd: number;
    green: boolean | null;
    agents: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    peakConcurrency: number;
    staleRefusals: number;
    gateRefusals: number;
    humanSteps: number;
  };
  lanes: { lane: string; role: Role; spans: Span[] }[];
  tasks: TaskRow[];
  requirements: ReqRow[];
  stale: { t: number; who: string; path: string; seen: number | null; current: number; currentAuthor: string }[];
  gates: { t: number; who: string; tool: string; rule: string; message: string }[];
  events: { t: number; kind: string; detail: string }[];
  tests: { t: number; rev: number; pass: number; fail: number; tscErrors: number }[];
  costByRole: Record<string, number>;
  costByModel: Record<string, number>;
};

type P = Record<string, any>;
const ROLE_ORDER: Role[] = ["analyst", "architect", "builder", "test-author", "reviewer", "arbiter", "utility"];

export function buildReportModel(lines: TraceLine[]): ReportModel {
  const first = lines[0]?.t ?? 0;
  const last = lines[lines.length - 1]?.t ?? first;
  const started = lines.find((l) => l.type === "run.started")?.payload as P | undefined;
  const spans = new Map<string, Span>();
  const tasks = new Map<string, TaskRow>();
  const reqs: ReqRow[] = [];
  const out: Omit<ReportModel, "run" | "lanes" | "tasks" | "requirements"> = { stale: [], gates: [], events: [], tests: [], costByRole: {}, costByModel: {} };
  let release: P | undefined;
  let calls = 0;
  let inTok = 0;
  let outTok = 0;
  let cost = 0;
  let humanSteps = 0;
  const who = (l: TraceLine) => (l.slot ? `${l.slot}${l.taskId ? `(${l.taskId})` : ""}` : l.producer);
  const task = (id: string, candidate = "A") => {
    let t = tasks.get(id);
    if (!t) tasks.set(id, (t = { taskId: id, title: id, candidate, attempts: 0, costUsd: 0, status: "open", reopens: [] }));
    return t;
  };

  for (const l of lines) {
    const p = (l.payload ?? {}) as P;
    switch (l.type) {
      case "agent.spawned":
        spans.set(p.agentId, { agentId: p.agentId, role: p.role, lane: p.slot, taskId: p.taskId, model: p.model, start: l.t, end: last, costUsd: 0, calls: 0, answer: "" });
        break;
      case "agent.ended": {
        const s = spans.get(p.agentId);
        if (s) Object.assign(s, { end: l.t, answer: String(p.answer ?? "").slice(0, 300) });
        break;
      }
      case "llm.call": {
        calls += 1;
        inTok += p.inputTokens ?? 0;
        outTok += p.outputTokens ?? 0;
        cost += p.costUsd ?? 0;
        const s = spans.get(p.agentId);
        if (s) {
          s.costUsd += p.costUsd ?? 0;
          s.calls += 1;
          out.costByRole[s.role] = (out.costByRole[s.role] ?? 0) + (p.costUsd ?? 0);
          if (s.taskId) task(s.taskId, l.candidate).costUsd += p.costUsd ?? 0;
        }
        out.costByModel[p.model] = (out.costByModel[p.model] ?? 0) + (p.costUsd ?? 0);
        break;
      }
      case "ledger.ready":
        for (const r of p.items ?? []) reqs.push({ id: r.id, kind: r.kind, statement: r.statement, status: "unknown" });
        break;
      case "board.opened":
        for (const id of p.tasks ?? []) task(id, p.candidate).title = p.titles?.[id] ?? id;
        break;
      case "task.leased": {
        const t = task(p.taskId, p.candidate);
        t.attempts += 1;
        t.start ??= l.t;
        break;
      }
      case "task.approved": {
        const t = task(p.taskId, p.candidate);
        Object.assign(t, { status: "approved", end: l.t, ms: t.start !== undefined ? l.t - t.start : undefined });
        break;
      }
      case "task.reopened":
        task(p.taskId, p.candidate).status = "open";
        task(p.taskId, p.candidate).reopens.push(p.reason);
        out.events.push({ t: l.t, kind: "reopened", detail: `${p.taskId}: ${p.reason}` });
        break;
      case "workspace.stale":
        out.stale.push({ t: l.t, who: p.by, path: p.path, seen: p.seen, current: p.current, currentAuthor: p.currentAuthor });
        break;
      case "gate.rejected":
        out.gates.push({ t: l.t, who: who(l), tool: p.tool, rule: p.rule, message: p.message });
        break;
      case "tests.ran":
        out.tests.push({ t: l.t, rev: p.rev, pass: p.pass, fail: p.fail, tscErrors: p.tscErrors });
        break;
      case "agent.stalled":
        out.events.push({ t: l.t, kind: "stalled", detail: p.reason });
        break;
      case "env.remediated":
        out.events.push({ t: l.t, kind: "environment", detail: `${p.pattern}: ${p.action}` });
        break;
      case "verdict.issued":
        out.events.push({ t: l.t, kind: "arbiter", detail: `${p.ruling}: ${p.reasoning}` });
        break;
      case "test.disputed":
        out.events.push({ t: l.t, kind: "disputed", detail: `${p.testId}: ${p.reason}` });
        break;
      case "inbox.delivered":
        out.events.push({ t: l.t, kind: "mid-flight message", detail: `${who(l)} received ${p.count}` });
        break;
      case "human.nudge":
        humanSteps += 1;
        out.events.push({ t: l.t, kind: "human", detail: p.text });
        break;
      case "release.checked":
        release = p;
        break;
    }
  }

  if (release) {
    for (const r of reqs) {
      r.status = release.untestable?.includes(r.id)
        ? "not testable"
        : release.failingRequirements?.includes(r.id)
          ? "fail"
          : release.uncovered?.includes(r.id)
            ? "untested"
            : "pass";
    }
  }

  const allSpans = [...spans.values()];
  const lanes = [...new Set(allSpans.map((s) => s.lane))]
    .map((lane) => {
      const ss = allSpans.filter((s) => s.lane === lane).sort((a, b) => a.start - b.start);
      return { lane, role: ss[0].role, spans: ss };
    })
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.lane.localeCompare(b.lane, undefined, { numeric: true }));

  return {
    run: {
      runId: started?.runId ?? "",
      title: started?.title ?? "",
      mode: started?.mode ?? "",
      candidates: started?.candidates ?? [],
      start: first,
      end: last,
      wallMs: last - first,
      costUsd: cost,
      green: release ? Boolean(release.green) : null,
      agents: allSpans.length,
      llmCalls: calls,
      inputTokens: inTok,
      outputTokens: outTok,
      peakConcurrency: peak(allSpans),
      staleRefusals: out.stale.length,
      gateRefusals: out.gates.length,
      humanSteps,
    },
    lanes,
    tasks: [...tasks.values()],
    requirements: reqs,
    ...out,
  };
}

function peak(spans: Span[]): number {
  const edges = spans.flatMap((s) => [
    { t: s.start, d: 1 },
    { t: s.end, d: -1 },
  ]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let live = 0;
  let max = 0;
  for (const e of edges) {
    live += e.d;
    max = Math.max(max, live);
  }
  return max;
}
