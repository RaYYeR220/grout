import { SituationSpecification } from "@mozaik-ai/core";
import { Actor } from "../bus/actor.js";
import { EV } from "../bus/events.js";
import { ROLE_LIMITS } from "../agents/roles.js";
import type { FactoryCtx } from "../runtime.js";

class AnyEvent extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

export type SupervisorOptions = { stallMs?: { builder: number; planner: number }; everyMs?: number };

/**
 * Watches every live agent. One that produces no event for too long is stopped: the gate ends its
 * loop at the next transition, the broker reopens its task, and the next attempt starts from a fresh
 * context (on a stronger model after two failed attempts).
 */
export class Supervisor extends Actor {
  private readonly lastSeen = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private readonly stallMs: { builder: number; planner: number };

  constructor(
    private readonly fc: FactoryCtx,
    opts: SupervisorOptions = {},
  ) {
    super("supervisor");
    this.stallMs = opts.stallMs ?? { builder: 240_000, planner: 360_000 };
    this.setHandlers([
      {
        specification: new AnyEvent(),
        processor: {
          apply: ({ event }) => {
            if (fc.state.agents.has(event.producerId)) this.lastSeen.set(event.producerId, Date.now());
          },
        },
      },
    ]);
    if (opts.everyMs !== 0) this.timer = setInterval(() => this.check(Date.now()), opts.everyMs ?? 5000);
  }

  check(now: number): void {
    for (const a of this.fc.state.liveAgents()) {
      if (this.fc.state.stopped.has(a.agentId)) continue;
      const limit = ROLE_LIMITS[a.role].tier === "builder" ? this.stallMs.builder : this.stallMs.planner;
      const last = this.lastSeen.get(a.agentId) ?? a.spawnedAt;
      if (now - last <= limit) continue;
      const reason = `stalled: no activity for ${Math.round((now - last) / 1000)} s`;
      this.fc.state.stopped.set(a.agentId, reason);
      this.fc.bus.emit(EV.agentStalled, "supervisor", { agentId: a.agentId, reason });
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
