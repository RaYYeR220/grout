import { z } from "zod";
import { Actor } from "../bus/actor.js";
import { EV, type EventPayloads } from "../bus/events.js";
import { ROLE_LIMITS } from "../agents/roles.js";
import { spawnAgent } from "../agents/spawn.js";
import { submitTool } from "../agents/tools.js";
import type { MemoryStore } from "../memory/store.js";
import type { FactoryCtx } from "../runtime.js";

const RECALL_QUERY = "pitfalls when building a small TypeScript Node CLI or HTTP API (ESM, NodeNext, tsc, vitest, exit codes, ports, output format)";

const DISTILL = `You keep the lessons of a software factory. Below is what went wrong during one run: tasks sent back with failing tests, refused tool calls, environment problems, arbiter rulings. Write at most 5 short, general, actionable lessons that would have prevented these problems in a future run on a different spec (e.g. "CLI entry files need #!/usr/bin/env node as the first line"). No lesson about this spec's specific feature. Call submit_lessons once.`;

/** Carries what one run learned into the next: recall before planning, distil after the run. */
export class Librarian extends Actor {
  private readonly material: string[] = [];

  constructor(
    private readonly fc: FactoryCtx,
    private readonly store: MemoryStore,
  ) {
    super("librarian");
    const note = (s: string): void => {
      if (this.material.length < 60) this.material.push(s.slice(0, 400));
    };
    this.setHandlers([
      fc.bus.on([EV.taskReopened], (e) => note(`task sent back: ${(e.payload as EventPayloads["task.reopened"]).reason}`)),
      fc.bus.on([EV.testFailed], (e) => note(`failure routed: ${(e.payload as EventPayloads["test.failed"]).message}`)),
      fc.bus.on([EV.gateRejected], (e) => {
        const p = e.payload as EventPayloads["gate.rejected"];
        note(`refused ${p.tool} [${p.rule}]: ${p.message}`);
      }),
      fc.bus.on([EV.envRemediated], (e) => {
        const p = e.payload as EventPayloads["env.remediated"];
        note(`environment: ${p.pattern} → ${p.action}`);
      }),
      fc.bus.on([EV.verdictIssued], (e) => {
        const p = e.payload as EventPayloads["verdict.issued"];
        note(`arbiter ${p.ruling}: ${p.reasoning}`);
      }),
    ]);
  }

  async recall(): Promise<void> {
    this.fc.state.lessons = await this.store.recall(RECALL_QUERY, 8);
    this.fc.bus.emit(EV.lessonsRecalled, "librarian", { count: this.fc.state.lessons.length, store: this.store.kind });
  }

  async distill(): Promise<void> {
    if (this.material.length === 0) return;
    let lessons: string[] = [];
    await spawnAgent(this.fc, {
      role: "utility",
      slot: "librarian",
      candidate: [...this.fc.state.candidates.keys()][0],
      tier: ROLE_LIMITS.utility.tier,
      instruction: DISTILL,
      tools: () => [
        submitTool("submit_lessons", "Hand in the lessons.", z.object({ lessons: z.array(z.string()).max(5) }), (v) => {
          lessons = v.lessons;
          return undefined;
        }),
      ],
      message: this.material.join("\n"),
      maxSteps: ROLE_LIMITS.utility.maxSteps,
    }).done;
    for (const lesson of lessons) await this.store.remember(lesson, { runId: this.fc.state.runId });
    this.fc.bus.emit(EV.lessonsStored, "librarian", { count: lessons.length, store: this.store.kind });
  }
}
