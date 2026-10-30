import { Actor } from "../bus/actor.js";
import { EV } from "../bus/events.js";
import { REPORT_PATH, TEST_CMD, TYPECHECK_CMD } from "../agents/tools.js";
import type { FactoryCtx } from "../runtime.js";
import { parseTsc, parseVitestJson, type VitestResult } from "../sandbox/parse.js";
import { requirementIdsOf, type TestRecord } from "../state/test-matrix.js";
import { triage, type Destination } from "../triage.js";
import type { Broker } from "./broker.js";

export const MAX_ATTEMPTS = 5;
export const PERSISTENT_AFTER = 3;

export type VerifierRun = { rev: number; pass: number; fail: number; tscErrors: number; at: number };

/** A test that passed in the previous run and fails now was broken by a recent change: say so. */
export function markRegressions(previous: ReadonlyMap<string, string>, results: VitestResult[], previousRev: number): VitestResult[] {
  return results.map((r) =>
    (r.status === "fail" || r.status === "error") && previous.get(`${r.file} > ${r.title}`) === "pass"
      ? { ...r, failure: `REGRESSION: this test passed at rev ${previousRev} and fails now, so a recent change broke it.\n${r.failure ?? ""}` }
      : r,
  );
}

/** Runs the whole suite on the shared codebase as it changes, and sends every failure to whoever can fix it. */
export class Verifier extends Actor {
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;
  lastRun?: VerifierRun;

  constructor(
    private readonly fc: FactoryCtx,
    private readonly candidate: string,
    private readonly broker: Broker,
    private readonly debounceMs = 2500,
  ) {
    super(`verifier-${candidate}`);
    this.setHandlers([
      fc.bus.on([EV.workspaceCommitted, EV.taskDone, EV.testsSubmitted], (e) => {
        if ((e.payload as { candidate?: string }).candidate === candidate) this.request();
      }),
    ]);
  }

  get idle(): boolean {
    return !this.running && !this.timer && !this.again;
  }

  request(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, this.debounceMs);
  }

  /** Whoever last wrote a test file fixes it: a test author by slot, a builder through its task. */
  private ownerOfTest = (file: string): Destination | undefined => {
    const author = this.fc.state.candidate(this.candidate).workspace.peek(file)?.author;
    const info = author ? this.fc.state.agents.get(author) : undefined;
    if (info?.role === "test-author") return { kind: "test-author", slot: info.slot };
    if (info?.role === "builder" && info.taskId) return { kind: "task", taskId: info.taskId };
    return undefined;
  };

  async run(): Promise<void> {
    const { fc, candidate } = this;
    const cand = fc.state.candidate(candidate);
    const ledger = fc.state.ledger;
    const sandbox = fc.sandboxFor(candidate);
    if (!sandbox || !ledger || !cand.workspace.peek("package.json")) return;
    this.running = true;
    try {
      const rev = cand.workspace.rev;
      const files = cand.workspace.snapshot();
      const started = Date.now();
      const tsc = await sandbox.exec(files, TYPECHECK_CMD, { timeoutMs: 120_000 });
      const test = await sandbox.exec(files, TEST_CMD, { collect: [REPORT_PATH], timeoutMs: 240_000 });
      for (const r of [tsc, test]) fc.bus.emit(EV.sandboxCommand, this.getId(), { cmd: r.cmd, exitCode: r.exitCode, ms: r.durationMs, timedOut: r.timedOut, candidate });
      const tscErrors = parseTsc(tsc.stdout + tsc.stderr);
      const report = test.outputs[REPORT_PATH];
      const previous = new Map(cand.matrix.all().map((t) => [t.id, t.status] as const));
      const results: VitestResult[] = markRegressions(previous, report ? parseVitestJson(report, "", test.stdout + test.stderr) : [], this.lastRun?.rev ?? 0);
      const records: TestRecord[] = results.map((r) => ({
        id: `${r.file} > ${r.title}`,
        file: r.file,
        title: r.title,
        requirementIds: requirementIdsOf(r.title),
        status: r.status,
        ...(r.failure ? { failure: r.failure.slice(0, 2000) } : {}),
        rev,
      }));
      cand.matrix.update(records);
      const testable = ledger.requirements.filter((q) => q.kind !== "non-functional").map((q) => q.id);
      const pass = records.filter((r) => r.status === "pass").length;
      const fail = records.filter((r) => r.status === "fail" || r.status === "error").length;
      this.lastRun = { rev, pass, fail, tscErrors: tscErrors.length, at: Date.now() };
      fc.bus.emit(EV.testsRan, this.getId(), {
        candidate,
        rev,
        pass,
        fail,
        total: records.length,
        tscErrors: tscErrors.length,
        uncovered: cand.matrix.coverage(testable).uncovered,
        ms: Date.now() - started,
      });
      this.route(tscErrors, results);
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.request();
      }
    }
  }

  private readonly escalated = new Set<string>();

  /** A test that keeps failing after several attempts goes to the arbiter: maybe the test, not the code, is wrong. */
  private escalate(testIds: string[], taskId: string): void {
    for (const testId of testIds) {
      if (this.escalated.has(testId)) continue;
      this.escalated.add(testId);
      this.fc.bus.emit(EV.testDisputed, this.getId(), { candidate: this.candidate, testId, reason: `persistent failure: task ${taskId} has been reopened ${PERSISTENT_AFTER}+ times for it`, by: "verifier" });
    }
  }

  private route(tsc: ReturnType<typeof parseTsc>, results: VitestResult[]): void {
    const { fc, candidate } = this;
    const cand = fc.state.candidate(candidate);
    const board = cand.board;
    if (!board) return;
    for (const r of triage({ tsc, tests: results }, cand, fc.state.ledger!, this.ownerOfTest)) {
      if (r.to.kind === "test-author") {
        if (!cand.testAuthorsDone.has(r.to.slot)) continue; // still writing: it runs its own checks
        fc.bus.emit(EV.testFailed, this.getId(), { candidate, requirementIds: r.requirementIds, to: r.to.slot, message: r.message.slice(0, 500) });
        this.broker.reviseTests(r.to.slot, r.message);
        continue;
      }
      const status = board.status(r.to.taskId);
      if (status !== "done" && status !== "approved") continue; // being built right now, or not started
      if (board.attempts(r.to.taskId) >= PERSISTENT_AFTER) this.escalate(r.testIds, r.to.taskId);
      if (board.attempts(r.to.taskId) >= MAX_ATTEMPTS) continue;
      board.reopen(r.to.taskId, r.message);
      fc.bus.emit(EV.testFailed, this.getId(), { candidate, testId: r.testIds[0], requirementIds: r.requirementIds, to: r.to.taskId, message: r.message.slice(0, 500) });
      fc.bus.emit(EV.taskReopened, this.getId(), { candidate, taskId: r.to.taskId, reason: "failing checks" });
    }
  }
}
