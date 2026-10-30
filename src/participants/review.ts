import { Actor } from "../bus/actor.js";
import { EV, type EventPayloads } from "../bus/events.js";
import { ARBITER, REVIEWER, arbiterMessage, reviewerMessage } from "../agents/prompts.js";
import { ROLE_LIMITS, ReviewSchema, VerdictSchema } from "../agents/roles.js";
import { spawnAgent } from "../agents/spawn.js";
import { submitTool } from "../agents/tools.js";
import type { FactoryCtx } from "../runtime.js";
import type { Broker } from "./broker.js";

export const MAX_REVIEW_REOPENS = 2;

/** Nobody grades their own homework: every finished task gets a reviewer; every disputed test gets an arbiter. */
export class ReviewDesk extends Actor {
  private readonly reviewReopens = new Map<string, number>();
  private arbiters = 0;

  constructor(
    private readonly fc: FactoryCtx,
    private readonly candidate: string,
    private readonly broker: Broker,
  ) {
    super(`review-desk-${candidate}`);
    const mine = (e: { payload: unknown }) => (e.payload as { candidate?: string }).candidate === candidate;
    this.setHandlers([
      fc.bus.on([EV.taskDone], (e) => {
        if (mine(e)) this.review((e.payload as EventPayloads["task.done"]).taskId);
      }),
      fc.bus.on([EV.testDisputed], (e) => {
        if (mine(e)) this.arbitrate(e.payload as EventPayloads["test.disputed"]);
      }),
    ]);
  }

  private review(taskId: string, attempt = 1): void {
    const { fc, candidate } = this;
    if (fc.state.finished.has(candidate)) return;
    const cand = fc.state.candidate(candidate);
    const board = cand.board!;
    const task = board.tasks().find((t) => t.id === taskId)!;
    const generation = board.leaseOf(taskId)?.generation;
    const files = task.writeSurface.map((path) => ({ path, content: cand.workspace.peek(path)?.content ?? "(missing)" }));
    const tests = cand.matrix
      .all()
      .filter((r) => r.requirementIds.some((id) => task.requirements.includes(id)))
      .map((r) => `${r.status.toUpperCase()} ${r.title}${r.failure ? `: ${r.failure.split("\n")[0]}` : ""}`)
      .join("\n");
    const h = spawnAgent(fc, {
      role: "reviewer",
      slot: "reviewer",
      candidate,
      tier: ROLE_LIMITS.reviewer.tier,
      taskId,
      instruction: REVIEWER,
      tools: () => [
        submitTool("submit_review", "Hand in your verdict on the task.", ReviewSchema, ({ verdict, findings }) => {
          if (board.status(taskId) !== "done" || board.leaseOf(taskId)?.generation !== generation) return undefined; // superseded
          const reopens = this.reviewReopens.get(taskId) ?? 0;
          if (verdict === "approve" || findings.length === 0 || reopens >= MAX_REVIEW_REOPENS) {
            board.approve(taskId);
            fc.bus.emit(EV.taskApproved, "reviewer", { candidate, taskId });
            return undefined;
          }
          this.reviewReopens.set(taskId, reopens + 1);
          board.reopen(taskId, `reviewer: ${findings.join(" | ")}`);
          fc.bus.emit(EV.taskReopened, "reviewer", { candidate, taskId, reason: findings.join(" | ").slice(0, 500) });
          return undefined;
        }),
      ],
      message: reviewerMessage(task, fc.state.ledger!, files, tests),
      maxSteps: ROLE_LIMITS.reviewer.maxSteps,
    });
    // A reviewer that ends without a verdict (provider error, stop, plain text) must not leave the task hanging.
    void h.done.then(() => {
      if (board.status(taskId) !== "done" || board.leaseOf(taskId)?.generation !== generation || fc.state.finished.has(candidate)) return;
      if (attempt === 1) return this.review(taskId, 2);
      board.approve(taskId);
      fc.bus.emit(EV.taskApproved, "review-desk", { candidate, taskId });
    });
  }

  private arbitrate(d: EventPayloads["test.disputed"]): void {
    const { fc, candidate } = this;
    if (this.arbiters >= 12 || fc.state.finished.has(candidate)) return;
    this.arbiters += 1;
    const cand = fc.state.candidate(candidate);
    const record = cand.matrix.all().find((r) => r.id === d.testId || r.title === d.testId || (r.title !== "" && d.testId.includes(r.title)));
    const testFile = record?.file ?? cand.workspace.list("test/").find((f) => cand.workspace.peek(f)?.content.includes(d.testId));
    const source = testFile ? (cand.workspace.peek(testFile)?.content ?? "") : "";
    const authorId = testFile ? cand.workspace.peek(testFile)?.author : undefined;
    const authorSlot = authorId ? fc.state.agents.get(authorId)?.slot : undefined;
    spawnAgent(fc, {
      role: "arbiter",
      slot: "arbiter",
      candidate,
      tier: ROLE_LIMITS.arbiter.tier,
      instruction: ARBITER,
      tools: () => [
        submitTool("submit_verdict", "Hand in your ruling.", VerdictSchema, ({ ruling, reasoning, interpretation }) => {
          fc.bus.emit(EV.verdictIssued, "arbiter", { candidate, testId: d.testId, ruling, reasoning, interpretation });
          const note = `Arbiter ruling on "${d.testId}": ${ruling}. ${reasoning}${interpretation ? ` Interpretation to follow: ${interpretation}` : ""}`;
          if (ruling === "ambiguous") fc.state.ledger?.ambiguities.push({ question: d.testId, chosen: interpretation ?? reasoning });
          const reqId = d.testId.match(/^requirement (R\d+)$/)?.[1];
          const req = reqId ? fc.state.ledger?.requirements.find((r) => r.id === reqId) : undefined;
          if (ruling === "untestable" && req) Object.assign(req, { kind: "non-functional", interpretation: `not testable black-box: ${reasoning}` });
          if ((ruling === "test-wrong" || ruling === "ambiguous") && authorSlot) this.broker.reviseTests(authorSlot, note);
          if ((ruling === "code-wrong" || ruling === "ambiguous") && d.agentId) fc.state.deliver(d.agentId, "arbiter", note);
          return undefined;
        }),
      ],
      message: arbiterMessage(fc.state.spec, d, source, record?.failure ?? ""),
      maxSteps: ROLE_LIMITS.arbiter.maxSteps,
    });
  }
}
