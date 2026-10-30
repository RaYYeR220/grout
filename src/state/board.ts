import { normalizePath } from "../paths.js";
import type { TaskSpec } from "./blueprint.js";

export type TaskStatus = "pending" | "ready" | "leased" | "done" | "approved";
export type Lease = { taskId: string; worker: string; generation: number };

type Slot = {
  spec: TaskSpec;
  status: Exclude<TaskStatus, "pending" | "ready"> | "open";
  generation: number;
  lease?: Lease;
  attempts: number;
  feedback: string[];
  evidence?: string;
};

/** The work market: tasks are offered, leased with a generation, completed, reviewed, reopened. */
export class Board {
  private readonly slots = new Map<string, Slot>();
  private readonly owners = new Map<string, string>();

  constructor(tasks: TaskSpec[]) {
    for (const spec of tasks) {
      this.slots.set(spec.id, { spec, status: "open", generation: 0, attempts: 0, feedback: [] });
      for (const path of spec.writeSurface) {
        const p = normalizePath(path);
        const prev = this.owners.get(p);
        this.owners.set(p, prev && prev !== spec.id ? "shared" : spec.id);
      }
    }
  }

  status(taskId: string): TaskStatus {
    const s = this.slot(taskId);
    if (s.status !== "open") return s.status;
    return this.depsMet(s.spec) ? "ready" : "pending";
  }

  ready(): TaskSpec[] {
    return [...this.slots.values()].filter((s) => this.status(s.spec.id) === "ready").map((s) => s.spec);
  }

  lease(taskId: string, worker: string): Lease {
    const s = this.slot(taskId);
    if (this.status(taskId) !== "ready") throw new Error(`task ${taskId} is ${this.status(taskId)}, not ready`);
    s.generation += 1;
    s.status = "leased";
    s.lease = { taskId, worker, generation: s.generation };
    return s.lease;
  }

  isCurrent(lease: Lease): boolean {
    const s = this.slots.get(lease.taskId);
    return !!s && s.status === "leased" && s.generation === lease.generation;
  }

  complete(lease: Lease, evidence: string): boolean {
    if (!this.isCurrent(lease)) return false;
    const s = this.slot(lease.taskId);
    s.status = "done";
    s.evidence = evidence;
    return true;
  }

  approve(taskId: string): void {
    this.slot(taskId).status = "approved";
  }

  reopen(taskId: string, feedback: string): void {
    const s = this.slot(taskId);
    s.status = "open";
    s.lease = undefined;
    s.attempts += 1;
    s.feedback.push(feedback);
  }

  feedback(taskId: string): string[] {
    return [...this.slot(taskId).feedback];
  }

  attempts(taskId: string): number {
    return this.slot(taskId).attempts;
  }

  leaseOf(taskId: string): Lease | undefined {
    return this.slot(taskId).lease;
  }

  ownerOf(path: string): string | "shared" | undefined {
    return this.owners.get(normalizePath(path));
  }

  allApproved(): boolean {
    return [...this.slots.values()].every((s) => s.status === "approved");
  }

  tasks(): readonly (TaskSpec & { status: TaskStatus })[] {
    return [...this.slots.values()].map((s) => ({ ...s.spec, status: this.status(s.spec.id) }));
  }

  private depsMet(spec: TaskSpec): boolean {
    return spec.dependsOn.every((d) => {
      const st = this.slots.get(d)?.status;
      return st === "done" || st === "approved";
    });
  }

  private slot(taskId: string): Slot {
    const s = this.slots.get(taskId);
    if (!s) throw new Error(`unknown task ${taskId}`);
    return s;
  }
}
