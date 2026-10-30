import { Actor } from "../bus/actor.js";
import { EV } from "../bus/events.js";
import { ANALYST, analystMessage, architectInstruction, architectMessage, renderLedger } from "../agents/prompts.js";
import { reconcile } from "../agents/reconcile.js";
import { ROLE_LIMITS } from "../agents/roles.js";
import { spawnAgent } from "../agents/spawn.js";
import { REPORT_PATH, fileTools, submitTool } from "../agents/tools.js";
import type { FactoryCtx } from "../runtime.js";
import { parseVitestJson } from "../sandbox/parse.js";
import { BlueprintSchema } from "../state/blueprint.js";
import { Board } from "../state/board.js";
import type { ReleaseStatus } from "../state/factory-state.js";
import { LedgerSchema, type Ledger } from "../state/ledger.js";
import { scaffold } from "../template/scaffold.js";
import type { Broker } from "./broker.js";
import { releaseCheck } from "./release.js";
import type { Verifier } from "./verifier.js";

export const CLEAN_ROOM = [
  "npm ci --ignore-scripts --no-audit --no-fund --loglevel=error",
  "npm run build",
  "npx vitest run --reporter=json --outputFile=.grout/vitest.json",
];

export type Finish = { candidate: string; status: ReleaseStatus; reason: string; dist: Record<string, string> };

type Crew = { broker: Broker; verifier: Verifier };

/**
 * Starts the run (Analyst ∥ Architect), turns an accepted blueprint into a scaffolded project and an
 * open board, and decides when a candidate is releasable. It never calls a builder: brokers react to
 * the board, the verifier reacts to commits, and this participant reacts to their events.
 */
export class Conductor extends Actor {
  private resolveLedger!: (l: Ledger) => void;
  private readonly ledgerReady = new Promise<Ledger>((r) => (this.resolveLedger = r));
  private readonly finished = new Set<string>();
  private readonly checking = new Set<string>();
  private readonly cleanRoomFailures = new Map<string, number>();
  private readonly uncoveredRevisions = new Map<string, number>();
  private readonly retries = new Map<string, number>();
  private resolveFinish!: (f: Finish[]) => void;
  readonly done = new Promise<Finish[]>((r) => (this.resolveFinish = r));
  private readonly results: Finish[] = [];
  private watchdog?: NodeJS.Timeout;
  private lastActivity = Date.now();

  constructor(
    private readonly fc: FactoryCtx,
    private readonly crews: Map<string, Crew>,
    private readonly opts: { title: string; mode: string; architectModel?: string },
  ) {
    super("conductor");
    this.setHandlers([
      fc.bus.on([EV.testsRan, EV.taskApproved, EV.testsSubmitted, EV.agentEnded], (e) => {
        this.lastActivity = Date.now();
        const c = (e.payload as { candidate?: string }).candidate;
        if (c) void this.check(c);
      }),
      fc.bus.on([EV.workspaceCommitted, EV.agentSpawned], () => {
        this.lastActivity = Date.now();
      }),
      fc.bus.on([EV.budgetExceeded], () => {
        for (const c of this.crews.keys()) void this.finish(c, "budget exhausted");
      }),
    ]);
  }

  start(): void {
    const { fc } = this;
    fc.bus.emit(EV.runStarted, "conductor", { runId: fc.state.runId, candidates: [...this.crews.keys()], mode: this.opts.mode });
    this.spawnAnalyst();
    for (const c of this.crews.keys()) this.spawnArchitect(c, architectMessage(fc.state.spec));
    this.watchdog = setInterval(() => this.tick(), 5000);
  }

  private spawnAnalyst(): void {
    const { fc } = this;
    const h = spawnAgent(fc, {
      role: "analyst",
      slot: "analyst",
      candidate: [...this.crews.keys()][0],
      tier: ROLE_LIMITS.analyst.tier,
      instruction: ANALYST,
      tools: () => [
        submitTool("submit_ledger", "Hand in the requirement ledger.", LedgerSchema, (ledger) => {
          if (fc.state.ledger) return undefined;
          fc.state.ledger = ledger;
          fc.bus.emit(EV.ledgerReady, "analyst", { requirements: ledger.requirements.length, ambiguities: ledger.ambiguities.length });
          for (const a of fc.state.liveAgents({ role: "architect" })) {
            fc.state.deliver(a.agentId, "analyst", `The requirement ledger is ready. Use these ids in your tasks:\n${renderLedger(ledger)}`);
          }
          this.resolveLedger(ledger);
          return undefined;
        }),
      ],
      message: analystMessage(fc.state.spec),
      maxSteps: ROLE_LIMITS.analyst.maxSteps,
    });
    void h.done.then((answer) => {
      if (fc.state.ledger) return;
      if (this.bump("analyst") <= 2) this.spawnAnalyst();
      else for (const c of this.crews.keys()) void this.finish(c, `the analyst never produced a ledger: ${answer.slice(0, 200)}`);
    });
  }

  private spawnArchitect(candidate: string, message: string): void {
    const { fc } = this;
    const h = spawnAgent(fc, {
      role: "architect",
      slot: "architect",
      candidate,
      tier: ROLE_LIMITS.architect.tier,
      model: this.opts.architectModel,
      instruction: architectInstruction(fc.state.lessons),
      tools: (self) => [
        ...fileTools({ fc, self, role: "architect", candidate, slot: "architect" }),
        submitTool("submit_blueprint", "Hand in the plan. It is checked against the ledger and the dependencies are installed before it is accepted.", BlueprintSchema, (bp) =>
          this.acceptBlueprint(candidate, bp),
        ),
      ],
      message,
      maxSteps: ROLE_LIMITS.architect.maxSteps,
    });
    void h.done.then((answer) => {
      if (fc.state.candidate(candidate).board) return;
      if (this.bump(`architect-${candidate}`) <= 2) this.spawnArchitect(candidate, `${architectMessage(fc.state.spec)}\n\nA previous attempt ended without an accepted blueprint: ${answer.slice(0, 400)}`);
      else void this.finish(candidate, "the architect never produced an accepted blueprint");
    });
  }

  private async acceptBlueprint(candidate: string, bp: Parameters<typeof reconcile>[1]): Promise<string | undefined> {
    const { fc } = this;
    const cand = fc.state.candidate(candidate);
    if (cand.board) return "a blueprint was already accepted";
    const ledger = await Promise.race([this.ledgerReady, new Promise<undefined>((r) => setTimeout(r, 300_000))]);
    if (!ledger) return "the requirement ledger is still not ready; call submit_blueprint again";
    const rec = reconcile(ledger, bp);
    fc.bus.emit(EV.planReconciled, "conductor", { candidate, ...rec });
    if (!rec.ok) {
      const parts = [
        rec.uncoveredRequirements.length ? `these requirements belong to no task: ${rec.uncoveredRequirements.join(", ")}` : "",
        rec.unknownRequirementRefs.length ? `these ids are not in the ledger: ${rec.unknownRequirementRefs.join(", ")}` : "",
      ].filter(Boolean);
      return `the plan does not match the ledger (${parts.join("; ")})`;
    }
    const files = scaffold(ledger, bp, this.opts.title);
    const started = Date.now();
    const install = fc.sandbox ? await fc.sandbox.installDeps(files.get("package.json")!) : undefined;
    fc.bus.emit(EV.depsInstalled, "conductor", { candidate, ok: !install || install.exitCode === 0, ms: Date.now() - started });
    if (install && install.exitCode !== 0) return `installing the dependencies failed:\n${(install.stderr || install.stdout).slice(-1500)}\nUse dependencies and exact versions that exist, or none`;
    if (install?.lockfile) files.set("package-lock.json", install.lockfile);
    for (const [path, content] of files) {
      cand.workspace.read("scaffold", path);
      cand.workspace.commit("scaffold", path, content);
    }
    cand.blueprint = bp;
    cand.lockfile = install?.lockfile;
    cand.board = new Board(bp.tasks);
    fc.bus.emit(EV.blueprintReady, "conductor", { candidate, tasks: bp.tasks.length });
    fc.bus.emit(EV.boardOpened, "conductor", { candidate, tasks: bp.tasks.map((t) => t.id) });
    return undefined;
  }

  private bump(key: string): number {
    const n = (this.retries.get(key) ?? 0) + 1;
    this.retries.set(key, n);
    return n;
  }

  private async check(candidate: string): Promise<void> {
    if (this.finished.has(candidate) || this.checking.has(candidate)) return;
    const { fc } = this;
    const cand = fc.state.candidate(candidate);
    const crew = this.crews.get(candidate)!;
    const ledger = fc.state.ledger;
    if (fc.state.budget.exceeded()) return void this.finish(candidate, "budget exhausted");
    if (fc.state.budget.pastDeadline()) return void this.finish(candidate, "deadline reached");
    if (!ledger || !cand.board || !cand.board.allApproved()) return;
    if (crew.broker.testAuthorCount === 0 || cand.testAuthorsDone.size < crew.broker.testAuthorCount) return;
    if (!crew.verifier.lastRun || crew.verifier.lastRun.rev !== cand.workspace.rev) {
      if (crew.verifier.idle) crew.verifier.request();
      return;
    }
    const status = releaseCheck(cand, ledger);
    if (!status.green) {
      this.reviseUncovered(candidate, status.uncovered);
      return;
    }
    this.checking.add(candidate);
    try {
      await this.cleanRoom(candidate);
    } finally {
      this.checking.delete(candidate);
    }
  }

  /** Requirements nobody tested go back to the test author who owns them. */
  private reviseUncovered(candidate: string, uncovered: string[]): void {
    const crew = this.crews.get(candidate)!;
    if (uncovered.length === 0 || crew.verifier.lastRun?.fail) return;
    const n = this.uncoveredRevisions.get(candidate) ?? 0;
    if (n >= 2) return;
    this.uncoveredRevisions.set(candidate, n + 1);
    crew.broker.reviseUncovered(uncovered);
  }

  private async cleanRoom(candidate: string): Promise<void> {
    const { fc } = this;
    const cand = fc.state.candidate(candidate);
    if (!fc.sandbox) return void this.finish(candidate, "released without a sandbox", { ok: true, step: "skipped (no sandbox)" });
    const results = await fc.sandbox.cleanRoom(cand.workspace.snapshot(), CLEAN_ROOM, { collect: ["dist/", REPORT_PATH] });
    for (const r of results) fc.bus.emit(EV.sandboxCommand, "conductor", { cmd: `[clean room] ${r.cmd}`, exitCode: r.exitCode, ms: r.durationMs, timedOut: r.timedOut, candidate });
    const failed = results.find((r) => r.exitCode !== 0);
    const last = results[results.length - 1];
    const tests = last?.outputs[REPORT_PATH] ? parseVitestJson(last.outputs[REPORT_PATH], "") : [];
    const testsGreen = tests.length > 0 && tests.every((t) => t.status === "pass" || t.status === "skip");
    if (!failed && testsGreen) {
      const dist = Object.fromEntries(Object.entries(last.outputs).filter(([p]) => p.startsWith("dist/")));
      return void this.finish(candidate, "all requirements covered by passing tests; clean-room check passed", { ok: true }, dist);
    }
    const n = (this.cleanRoomFailures.get(candidate) ?? 0) + 1;
    this.cleanRoomFailures.set(candidate, n);
    const step = failed?.cmd ?? "tests";
    const excerpt = (failed ? failed.stderr || failed.stdout : JSON.stringify(tests.filter((t) => t.status !== "pass").slice(0, 3))).slice(-1500);
    if (n >= 2) return void this.finish(candidate, `clean-room check keeps failing at ${step}`, { ok: false, step, excerpt });
    // Hand the clean-room failure to every task: it passed in the shared environment, so it is environmental or a build issue.
    for (const t of cand.board!.tasks()) cand.board!.reopen(t.id, `the clean-room check (fresh npm ci, build, tests) failed at "${step}":\n${excerpt}`);
    for (const t of cand.board!.tasks()) fc.bus.emit(EV.taskReopened, "conductor", { candidate, taskId: t.id, reason: `clean room failed at ${step}` });
  }

  /** No agent alive and nothing changing: the run is stuck, so it ends honestly instead of hanging. */
  private tick(): void {
    for (const c of this.crews.keys()) {
      if (this.finished.has(c) || this.checking.has(c)) continue;
      if (this.fc.state.budget.pastDeadline()) {
        void this.finish(c, "deadline reached");
        continue;
      }
      const live = this.fc.state.liveAgents({ candidate: c }).length;
      const crew = this.crews.get(c)!;
      if (live === 0 && crew.verifier.idle && Date.now() - this.lastActivity > 45_000) void this.finish(c, "stalled: no agent is working and the release gate is still red");
    }
  }

  private async finish(candidate: string, reason: string, cleanRoom?: ReleaseStatus["cleanRoom"], dist: Record<string, string> = {}): Promise<void> {
    if (this.finished.has(candidate)) return;
    this.finished.add(candidate);
    const { fc } = this;
    for (const a of fc.state.liveAgents({ candidate })) fc.state.stopped.set(a.agentId, "the run is over");
    const cand = fc.state.candidate(candidate);
    const ledger = fc.state.ledger;
    const status: ReleaseStatus = ledger
      ? releaseCheck(cand, ledger, cleanRoom)
      : { green: false, failingTests: [], uncovered: [], failingRequirements: [], unapproved: [], untestable: [], ...(cleanRoom ? { cleanRoom } : {}) };
    if (!status.green && Object.keys(dist).length === 0 && fc.sandbox && cand.workspace.peek("package.json")) {
      const build = await fc.sandbox.exec(cand.workspace.snapshot(), "npm run build", { collect: ["dist/"], timeoutMs: 120_000 }).catch(() => undefined);
      if (build) dist = build.outputs;
    }
    cand.releaseStatus = status;
    fc.bus.emit(EV.releaseChecked, "conductor", { candidate, ...status });
    this.results.push({ candidate, status, reason, dist });
    if (this.results.length === this.crews.size) {
      clearInterval(this.watchdog);
      this.resolveFinish(this.results);
    }
  }
}
