import { Actor } from "../bus/actor.js";
import { EV } from "../bus/events.js";
import { builderInstruction, builderMessage, testAuthorInstruction, testAuthorMessage } from "../agents/prompts.js";
import { ROLE_LIMITS, TestsDoneSchema } from "../agents/roles.js";
import { spawnAgent } from "../agents/spawn.js";
import { disputeTestTool, fileTools, finishTaskTool, requestChangeTool, runCheckTool, submitTool } from "../agents/tools.js";
import type { FactoryCtx } from "../runtime.js";
import type { TaskSpec } from "../state/blueprint.js";

export type BrokerOptions = { candidate: string; builders: number; testAuthors: number; sequential: boolean; builderModel?: string };

export const MAX_LEASES_PER_TASK = 8;
export const MAX_TEST_REVISIONS = 3;
export const PROVIDER_BACKOFF_MS = 20_000;

/** Who works on what: leases ready tasks to idle builder slots and runs the test authors. */
export class Broker extends Actor {
  private readonly busySlots = new Map<string, string>(); // slot → agentId
  private readonly authorSlots = new Map<string, string[]>(); // test-author slot → requirement ids
  private testsStarted = false;
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly fc: FactoryCtx,
    private readonly opts: BrokerOptions,
  ) {
    super(`broker-${opts.candidate}`);
    const mine = (e: { payload: unknown }) => (e.payload as { candidate?: string })?.candidate === opts.candidate;
    this.setHandlers([
      fc.bus.on([EV.boardOpened, EV.taskReopened, EV.taskDone, EV.taskApproved], (e) => {
        if (mine(e)) this.fill();
      }),
      fc.bus.on([EV.agentEnded], (e) => {
        if (mine(e)) this.ended(e.payload as { agentId: string; slot: string; role: string; taskId?: string; answer: string });
      }),
    ]);
  }

  private get cand() {
    return this.fc.state.candidate(this.opts.candidate);
  }

  private fill(): void {
    const board = this.cand.board;
    const ledger = this.fc.state.ledger;
    if (!board || !ledger || this.fc.state.budget.exceeded()) return;
    if (!this.testsStarted && (!this.opts.sequential || board.allApproved())) this.startTestAuthors();
    for (let i = 1; i <= this.opts.builders; i++) {
      const slot = `builder-${i}`;
      if (this.busySlots.has(slot)) continue;
      const task = board.ready().find((t) => board.leases(t.id) < MAX_LEASES_PER_TASK);
      if (!task) return;
      this.spawnBuilder(slot, task);
    }
  }

  private spawnBuilder(slot: string, task: TaskSpec): void {
    const { fc, opts } = this;
    const board = this.cand.board!;
    const lease = board.lease(task.id, slot);
    fc.bus.emit(EV.taskLeased, `broker-${opts.candidate}`, { candidate: opts.candidate, taskId: task.id, worker: slot, generation: lease.generation });
    const escalate = board.attempts(task.id) >= 2;
    const h = spawnAgent(fc, {
      role: "builder",
      slot,
      candidate: opts.candidate,
      tier: escalate ? "planner" : "builder",
      model: escalate ? undefined : opts.builderModel,
      taskId: task.id,
      lease,
      surface: task.writeSurface,
      instruction: builderInstruction(fc.state.lessons),
      tools: (self) => {
        const t = { fc, self, role: "builder" as const, candidate: opts.candidate, slot, taskId: task.id, lease, surface: task.writeSurface };
        return [...fileTools(t), runCheckTool(t), finishTaskTool(t), requestChangeTool(t), disputeTestTool(t)];
      },
      message: builderMessage(task, fc.state.ledger!, board.feedback(task.id)),
      maxSteps: ROLE_LIMITS.builder.maxSteps,
    });
    this.busySlots.set(slot, h.agentId);
  }

  private startTestAuthors(): void {
    this.testsStarted = true;
    const ledger = this.fc.state.ledger!;
    const ids = ledger.requirements.filter((r) => r.kind !== "non-functional").map((r) => r.id);
    const n = Math.max(1, Math.min(this.opts.testAuthors, ids.length));
    for (let i = 0; i < n; i++) this.authorSlots.set(`test-author-${i + 1}`, ids.filter((_, k) => k % n === i));
    for (const [slot, reqs] of this.authorSlots) this.spawnTestAuthor(slot, testAuthorMessage(this.fc.state.spec, ledger, reqs));
  }

  /** Respawns a test author with a correction (a broken test file, or an arbiter ruling against a test). */
  reviseTests(slot: string, note: string): void {
    const n = this.revisions.get(slot) ?? 0;
    if (n >= MAX_TEST_REVISIONS) return;
    this.revisions.set(slot, n + 1);
    const live = this.fc.state.liveAgents({ candidate: this.opts.candidate, slot, role: "test-author" })[0];
    if (live) {
      this.fc.state.deliver(live.agentId, "verifier", note);
      return;
    }
    const reqs = this.authorSlots.get(slot) ?? [];
    this.cand.testAuthorsDone.delete(slot);
    this.spawnTestAuthor(slot, `${testAuthorMessage(this.fc.state.spec, this.fc.state.ledger!, reqs)}\n\nYour existing tests are in test/acceptance/ (read them). Fix this:\n${note}`);
  }

  /** Requirements that ended up with no test go back to the authors who own them. */
  reviseUncovered(ids: string[]): void {
    const ledger = this.fc.state.ledger!;
    for (const [slot, reqs] of this.authorSlots) {
      const missing = reqs.filter((r) => ids.includes(r));
      if (missing.length === 0) continue;
      this.reviseTests(slot, `These requirements still have no acceptance test (titles must start with their [R#] id). Add tests for them:\n${ledger.requirements.filter((r) => missing.includes(r.id)).map((r) => `${r.id}: ${r.statement} — spec: "${r.specQuote}"`).join("\n")}`);
    }
  }

  get testAuthorCount(): number {
    return this.authorSlots.size;
  }

  private spawnTestAuthor(slot: string, message: string): void {
    const { fc, opts } = this;
    spawnAgent(fc, {
      role: "test-author",
      slot,
      candidate: opts.candidate,
      tier: "builder",
      model: opts.builderModel,
      instruction: testAuthorInstruction(),
      tools: (self) => {
        const t = { fc, self, role: "test-author" as const, candidate: opts.candidate, slot };
        return [
          ...fileTools(t),
          runCheckTool(t),
          submitTool("submit_tests", "Hand in your acceptance tests once they load and run.", TestsDoneSchema, ({ summary }) => {
            this.cand.testAuthorsDone.add(slot);
            fc.bus.emit(EV.testsSubmitted, self.id, { candidate: opts.candidate, slot, summary });
            return undefined;
          }),
        ];
      },
      message,
      maxSteps: ROLE_LIMITS["test-author"].maxSteps,
    });
  }

  private ended(p: { agentId: string; slot: string; role: string; taskId?: string; answer: string }): void {
    if (p.role === "test-author" && !this.cand.testAuthorsDone.has(p.slot)) {
      // Ended without handing in (step limit, stop): its files stay; count it as done so the run is not blocked.
      this.cand.testAuthorsDone.add(p.slot);
      this.fc.bus.emit(EV.testsSubmitted, p.agentId, { candidate: this.opts.candidate, slot: p.slot, summary: `(ended without submitting: ${p.answer.slice(0, 200)})` });
    }
    if (p.role !== "builder") return;
    if (this.busySlots.get(p.slot) === p.agentId) this.busySlots.delete(p.slot);
    const board = this.cand.board;
    if (board && p.taskId && board.status(p.taskId) === "leased" && board.leaseOf(p.taskId)?.worker === p.slot) {
      if (p.answer.startsWith("ERROR: inference failed")) {
        // The provider failed, not the builder: no attempt is counted, and the next one waits a little.
        board.reopen(p.taskId, "the previous attempt was cut off by a model provider error", { countAttempt: false });
        this.fc.bus.emit(EV.taskReopened, `broker-${this.opts.candidate}`, { candidate: this.opts.candidate, taskId: p.taskId, reason: "provider error" });
        setTimeout(() => this.fill(), PROVIDER_BACKOFF_MS).unref?.();
        return;
      }
      board.reopen(p.taskId, `the previous attempt ended without finish_task: ${p.answer.slice(0, 300)}`);
      this.fc.bus.emit(EV.taskReopened, `broker-${this.opts.candidate}`, { candidate: this.opts.candidate, taskId: p.taskId, reason: "attempt ended without finishing" });
      return;
    }
    this.fill();
  }
}
