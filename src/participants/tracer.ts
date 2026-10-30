import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SituationSpecification, type SemanticEvent } from "@mozaik-ai/core";
import { Actor } from "../bus/actor.js";
import { EV } from "../bus/events.js";
import { callCost } from "../llm/pricing.js";
import type { FactoryCtx } from "../runtime.js";
import type { Role } from "../state/factory-state.js";

export type TraceLine = { t: number; type: string; producer: string; role?: Role; slot?: string; taskId?: string; candidate?: string; payload: unknown };

class Everything extends SituationSpecification {
  isSatisfiedBy(): boolean {
    return true;
  }
}

const clip = (s: unknown, n = 2000) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}… [${s.length - n} more]` : s);

/** Keeps what a reader of the trace needs and drops the bulk (contexts, tool schemas, raw responses). */
function slim(event: SemanticEvent): unknown {
  const p = (event.payload ?? {}) as Record<string, any>;
  switch (event.type) {
    case "message_received.started":
      return { loopId: p.loopId, content: clip(p.content, 1500) };
    case "inference.started":
      return { loopId: p.loopId, model: p.model };
    case "inference.completed": {
      const item = (p.items ?? []).find((i: any) => i?.type === "function_call" || i?.type === "message");
      return {
        loopId: p.loopId,
        tokenUsage: p.tokenUsage,
        cost: p.rowResponse?.cost,
        output: item?.type === "function_call" ? { call: item.name } : { text: clip(item?.content?.text, 600) },
      };
    }
    case "function_call.started":
      return { loopId: p.loopId, tool: p.call?.name, args: clip(p.call?.args, 1200) };
    case "function_call.completed":
      return { loopId: p.loopId, output: clip(p.output?.text, 1200) };
    case "model.answer":
      return { loopId: p.loopId, answer: clip(p.answer?.content?.text, 1500) };
    case "interception.started":
    case "interception.finished":
      return { nextStateId: p.nextStateId };
    case "message_received.completed":
    case "inference.stream":
    case "participant.joined":
    case "participant.left":
      return { loopId: p.loopId };
    default: {
      const json = JSON.stringify(p);
      return json.length > 4000 ? { truncated: json.slice(0, 4000) } : p;
    }
  }
}

/** Writes every bus event to trace.jsonl and turns each inference into a priced llm.call. */
export class Tracer extends Actor {
  private readonly started = new Map<string, number>();
  private budgetAnnounced = false;

  constructor(
    private readonly fc: FactoryCtx,
    readonly path: string,
  ) {
    super("tracer");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    this.setHandlers([{ specification: new Everything(), processor: { apply: ({ event }) => this.record(event) } }]);
  }

  private record(event: SemanticEvent): void {
    if (event.type === "participant.joined" || event.type === "participant.left" || event.type === "inference.stream") return;
    const info = this.fc.state.agents.get(event.producerId);
    const line: TraceLine = {
      t: event.occurredAt.getTime(),
      type: event.type,
      producer: event.producerId,
      ...(info ? { role: info.role, slot: info.slot, taskId: info.taskId, candidate: info.candidate } : {}),
      payload: slim(event),
    };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    const p = event.payload as Record<string, any>;
    if (event.type === "inference.started" && p?.loopId) this.started.set(p.loopId, line.t);
    if (event.type === "inference.completed" && info) this.price(event, info.model, info.role, info.taskId, line.t);
  }

  private price(event: SemanticEvent, model: string, role: Role, taskId: string | undefined, t: number): void {
    const p = event.payload as Record<string, any>;
    const cost = callCost(model, p.tokenUsage, p.rowResponse);
    const start = this.started.get(p.loopId);
    this.started.delete(p.loopId);
    this.fc.state.budget.add(cost.usd, { role, taskId, model, agentId: event.producerId });
    this.fc.bus.emit(EV.llmCall, event.producerId, {
      agentId: event.producerId,
      model,
      inputTokens: p.tokenUsage?.inputTokens ?? 0,
      outputTokens: p.tokenUsage?.outputTokens ?? 0,
      cachedTokens: p.tokenUsage?.inputTokenDetails?.cached_tokens ?? 0,
      costUsd: cost.usd,
      ms: start ? t - start : 0,
    });
    if (!this.budgetAnnounced && this.fc.state.budget.exceeded()) {
      this.budgetAnnounced = true;
      this.fc.bus.emit(EV.budgetExceeded, "tracer", { spentUsd: this.fc.state.budget.spent(), capUsd: this.fc.state.budget.capUsd });
    }
  }
}
