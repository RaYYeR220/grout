import { SemanticEvent, SituationSpecification, type SituationContext, type SituationHandler } from "@mozaik-ai/core";
import type { AgentInfo, ReleaseStatus, Role } from "../state/factory-state.js";

export const EV = {
  runStarted: "run.started",
  ledgerReady: "ledger.ready",
  blueprintReady: "blueprint.ready",
  planReconciled: "plan.reconciled",
  depsInstalled: "deps.installed",
  boardOpened: "board.opened",
  agentSpawned: "agent.spawned",
  agentEnded: "agent.ended",
  taskLeased: "task.leased",
  taskDone: "task.done",
  taskApproved: "task.approved",
  taskReopened: "task.reopened",
  workspaceCommitted: "workspace.committed",
  workspaceStale: "workspace.stale",
  gateRejected: "gate.rejected",
  testsSubmitted: "tests.submitted",
  testsRan: "tests.ran",
  testFailed: "test.failed",
  testDisputed: "test.disputed",
  verdictIssued: "verdict.issued",
  changeRequested: "change.requested",
  inboxDelivered: "inbox.delivered",
  agentStalled: "agent.stalled",
  envRemediated: "env.remediated",
  budgetExceeded: "budget.exceeded",
  sandboxCommand: "sandbox.command",
  llmCall: "llm.call",
  releaseChecked: "release.checked",
  candidatesCompared: "candidates.compared",
  humanNudge: "human.nudge",
  runFinished: "run.finished",
  runError: "run.error",
  lessonsRecalled: "lessons.recalled",
  lessonsStored: "lessons.stored",
} as const;

export type EventType = (typeof EV)[keyof typeof EV];

type Cand = { candidate: string };

export type EventPayloads = {
  "run.started": { runId: string; title: string; candidates: string[]; mode: string };
  "ledger.ready": { requirements: number; ambiguities: number; items: { id: string; kind: string; statement: string }[] };
  "blueprint.ready": Cand & { tasks: number };
  "plan.reconciled": Cand & { ok: boolean; uncoveredRequirements: string[]; unknownRequirementRefs: string[]; overlappingSurfaces: string[] };
  "deps.installed": Cand & { ok: boolean; ms: number };
  "board.opened": Cand & { tasks: string[]; titles: Record<string, string> };
  "agent.spawned": AgentInfo;
  "agent.ended": Cand & { agentId: string; role: Role; slot: string; taskId?: string; answer: string };
  "task.leased": Cand & { taskId: string; worker: string; generation: number };
  "task.done": Cand & { taskId: string; worker: string; summary: string };
  "task.approved": Cand & { taskId: string };
  "task.reopened": Cand & { taskId: string; reason: string };
  "workspace.committed": Cand & { path: string; version: number; rev: number; author: string; taskId?: string };
  "workspace.stale": Cand & { path: string; current: number; seen: number | null; by: string; currentAuthor: string };
  "gate.rejected": Cand & { agentId: string; tool: string; rule: string; message: string };
  "tests.submitted": Cand & { slot: string; summary: string };
  "tests.ran": Cand & { rev: number; pass: number; fail: number; total: number; tscErrors: number; uncovered: string[]; ms: number };
  "test.failed": Cand & { testId?: string; requirementIds: string[]; to: string; message: string };
  "test.disputed": Cand & { testId: string; reason: string; by: string; agentId?: string };
  "verdict.issued": Cand & { testId: string; ruling: "test-wrong" | "code-wrong" | "ambiguous"; reasoning: string; interpretation?: string };
  "change.requested": Cand & { path: string; change: string; from: string; to: string };
  "inbox.delivered": { agentId: string; count: number };
  "agent.stalled": { agentId: string; reason: string };
  "env.remediated": { pattern: string; action: string; attempt: number };
  "budget.exceeded": { spentUsd: number; capUsd: number };
  "sandbox.command": { cmd: string; exitCode: number; ms: number; timedOut: boolean; candidate?: string };
  "llm.call": { agentId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; ms: number };
  "release.checked": Cand & ReleaseStatus;
  "candidates.compared": { winner: string; scores: Record<string, number>; reason: string; disagreements: number };
  "human.nudge": { text: string; to?: string };
  "run.finished": Cand & { status: ReleaseStatus; outDir: string };
  "run.error": { message: string; where: string };
  "lessons.recalled": { count: number; store: string };
  "lessons.stored": { count: number; store: string };
};

export type TypedEvent<K extends EventType> = SemanticEvent<K, EventPayloads[K]>;

class OfType extends SituationSpecification {
  constructor(private readonly types: ReadonlySet<string>) {
    super();
  }
  isSatisfiedBy({ event }: SituationContext): boolean {
    return this.types.has(event.type);
  }
}

/**
 * Typed publish/subscribe over the Mozaik runtime. Mozaik fans events out synchronously and
 * depth-first, so emits are deferred with setImmediate: an event raised inside a handler is
 * delivered only after the current fan-out has reached every participant.
 */
export class Bus {
  constructor(private readonly publish: (event: SemanticEvent) => void) {}

  emit<K extends EventType>(type: K, producerId: string, payload: EventPayloads[K]): void {
    const event = SemanticEvent.create(type, producerId, payload);
    setImmediate(() => this.publish(event));
  }

  /** A handler that never breaks the fan-out: throws and rejections become run.error events. */
  on(types: readonly string[], fn: (event: SemanticEvent) => void | Promise<void>): SituationHandler {
    const report = (err: unknown) =>
      this.emit(EV.runError, "bus", { message: err instanceof Error ? err.message : String(err), where: types.join(",") });
    return {
      specification: new OfType(new Set(types)),
      processor: {
        apply: ({ event }: SituationContext) => {
          try {
            const r = fn(event);
            if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(report);
          } catch (err) {
            report(err);
          }
        },
      },
    };
  }
}
