import { RuntimeState } from "@mozaik-ai/core";
import { Workspace } from "./workspace.js";
import { TestMatrix } from "./test-matrix.js";
import { Budget } from "./budget.js";
import type { Ledger } from "./ledger.js";
import type { Blueprint } from "./blueprint.js";
import type { Board } from "./board.js";

export type Role = "analyst" | "architect" | "builder" | "test-author" | "reviewer" | "arbiter" | "utility";

export type AgentInfo = {
  agentId: string;
  role: Role;
  slot: string;
  candidate: string;
  taskId?: string;
  model: string;
  spawnedAt: number;
  endedAt?: number;
};

export type ReleaseStatus = {
  green: boolean;
  failingTests: string[];
  uncovered: string[];
  failingRequirements: string[];
  unapproved: string[];
  untestable: string[];
  cleanRoom?: { ok: boolean; step?: string; excerpt?: string };
};

export type HumanStep = { at: number; kind: "nudge" | "between-runs-fix"; text: string };

export class CandidateState {
  readonly workspace: Workspace;
  readonly matrix = new TestMatrix();
  blueprint?: Blueprint;
  board?: Board;
  lockfile?: string;
  releaseStatus?: ReleaseStatus;
  testAuthorsDone = new Set<string>();

  constructor(
    readonly id: string,
    cas: boolean,
  ) {
    this.workspace = new Workspace({ cas });
  }
}

/** The shared state every participant sees: one Mozaik RuntimeState for the whole run. */
export class FactoryState extends RuntimeState {
  readonly runId: string;
  readonly spec: string;
  readonly budget: Budget;
  readonly candidates = new Map<string, CandidateState>();
  readonly agents = new Map<string, AgentInfo>();
  readonly stopped = new Map<string, string>();
  readonly humanSteps: HumanStep[] = [];
  ledger?: Ledger;
  lessons: string[] = [];
  private readonly inbox = new Map<string, string[]>();

  constructor(opts: { runId: string; spec: string; budgetUsd: number; deadlineMs?: number; candidates?: string[]; cas?: boolean }) {
    super();
    this.runId = opts.runId;
    this.spec = opts.spec;
    this.budget = new Budget(opts.budgetUsd, opts.deadlineMs);
    for (const id of opts.candidates ?? ["A"]) this.candidates.set(id, new CandidateState(id, opts.cas ?? true));
  }

  candidate(id: string): CandidateState {
    const c = this.candidates.get(id);
    if (!c) throw new Error(`unknown candidate ${id}`);
    return c;
  }

  deliver(agentId: string, from: string, text: string): void {
    const q = this.inbox.get(agentId) ?? [];
    q.push(`[from ${from}] ${text}`);
    this.inbox.set(agentId, q);
  }

  takeInbox(agentId: string): string[] {
    const q = this.inbox.get(agentId) ?? [];
    this.inbox.delete(agentId);
    return q;
  }

  hasInbox(agentId: string): boolean {
    return (this.inbox.get(agentId)?.length ?? 0) > 0;
  }

  liveAgents(filter: Partial<Pick<AgentInfo, "role" | "candidate" | "taskId" | "slot">> = {}): AgentInfo[] {
    return [...this.agents.values()].filter(
      (a) => a.endedAt === undefined && Object.entries(filter).every(([k, v]) => a[k as keyof AgentInfo] === v),
    );
  }
}
