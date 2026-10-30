import { Actor } from "../bus/actor.js";
import { EV } from "../bus/events.js";
import type { FactoryCtx } from "../runtime.js";

type P = Record<string, any>;

const short = (s: unknown, n = 90) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** One line per meaningful event; undefined for events that are not worth a line. */
export function formatEvent(type: string, who: string, p: P): string | undefined {
  switch (type) {
    case EV.runStarted:
      return `run started (${p.mode}, candidates ${p.candidates?.join(", ")})`;
    case EV.ledgerReady:
      return `ledger ready: ${p.requirements} requirements, ${p.ambiguities} ambiguities resolved`;
    case EV.planReconciled:
      return p.ok ? `[${p.candidate}] plan matches the ledger` : `[${p.candidate}] plan refused: uncovered ${p.uncoveredRequirements?.join(",") || "-"}, unknown ${p.unknownRequirementRefs?.join(",") || "-"}`;
    case EV.depsInstalled:
      return `[${p.candidate}] dependencies ${p.ok ? "installed" : "FAILED"} (${(p.ms / 1000).toFixed(1)} s)`;
    case EV.boardOpened:
      return `[${p.candidate}] board open: ${p.tasks?.join(", ")}`;
    case EV.agentSpawned:
      return `+ ${p.slot}${p.taskId ? ` (${p.taskId})` : ""} [${p.role}, ${p.model}]`;
    case EV.agentEnded:
      return `- ${p.slot}${p.taskId ? ` (${p.taskId})` : ""}: ${short(p.answer, 70)}`;
    case EV.taskLeased:
      return `  ${p.taskId} → ${p.worker} (attempt ${p.generation})`;
    case EV.taskDone:
      return `  ${p.taskId} done by ${p.worker}: ${short(p.summary, 60)}`;
    case EV.taskApproved:
      return `✓ ${p.taskId} approved`;
    case EV.taskReopened:
      return `↺ ${p.taskId} reopened: ${short(p.reason, 70)}`;
    case EV.workspaceCommitted:
      return `  ${p.author} wrote ${p.path} v${p.version}`;
    case EV.workspaceStale:
      return `⚡ STALE write refused: ${p.by} wrote ${p.path} from v${p.seen ?? "never read"}, but ${p.currentAuthor} had made it v${p.current}; re-applying`;
    case EV.gateRejected:
      return `! gate refused ${who} ${p.tool}: [${p.rule}] ${short(p.message, 70)}`;
    case EV.testsRan:
      return `= [${p.candidate}] tests at rev ${p.rev}: ${p.pass} pass, ${p.fail} failing, ${p.tscErrors} type errors${p.uncovered?.length ? `, untested ${p.uncovered.join(",")}` : ""}`;
    case EV.testFailed:
      return `→ failure routed to ${p.to}: ${short(p.message, 60)}`;
    case EV.testDisputed:
      return `? ${p.by} disputes "${short(p.testId, 50)}": ${short(p.reason, 50)}`;
    case EV.verdictIssued:
      return `§ arbiter: ${p.ruling} — ${short(p.reasoning, 60)}`;
    case EV.inboxDelivered:
      return `  ${who} received ${p.count} message(s) mid-flight`;
    case EV.changeRequested:
      return `  ${p.from} asks ${p.to} to change ${p.path}`;
    case EV.envRemediated:
      return `~ environment: ${p.action} (${p.pattern})`;
    case EV.agentStalled:
      return `~ supervisor stopped ${who}: ${p.reason}`;
    case EV.budgetExceeded:
      return `$ budget reached: $${p.spentUsd.toFixed(4)} of $${p.capUsd}`;
    case EV.releaseChecked:
      return `${p.green ? "★ GREEN" : "✗ not green"} [${p.candidate}]${p.green ? "" : `: failing ${p.failingTests?.length ?? 0}, untested ${p.uncovered?.length ?? 0}, unapproved ${p.unapproved?.length ?? 0}`}`;
    case EV.candidatesCompared:
      return `⇄ candidates compared: ${p.winner} wins (${p.reason})`;
    case EV.humanNudge:
      return `✋ human: ${short(p.text, 80)}`;
    default:
      return undefined;
  }
}

/** Prints the run as it happens: who is working on what, every refusal, every test run, the money. */
export function liveLogger(fc: FactoryCtx, write: (s: string) => void = (s) => process.stdout.write(s)): Actor {
  const t0 = Date.now();
  const label = (id: string) => {
    const a = fc.state.agents.get(id);
    return a ? `${a.slot}${a.taskId ? `(${a.taskId})` : ""}` : id;
  };
  return new Actor("live-log", [
    fc.bus.on(Object.values(EV), (e) => {
      const line = formatEvent(e.type, label(e.producerId), (e.payload ?? {}) as P);
      if (!line) return;
      const s = Math.floor((Date.now() - t0) / 1000);
      const clock = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      write(`[${clock} $${fc.state.budget.spent().toFixed(3)} live ${fc.state.liveAgents().length}] ${line}\n`);
    }),
  ]);
}
