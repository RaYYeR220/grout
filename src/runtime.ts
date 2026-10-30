import { defineRuntime, type InferenceRunner } from "@mozaik-ai/core";
import { Actor } from "./bus/actor.js";
import { Bus, EV } from "./bus/events.js";
import type { Tier } from "./llm/presets.js";
import type { Sandbox } from "./sandbox/types.js";
import type { FactoryState } from "./state/factory-state.js";

export type Runtime = ReturnType<typeof defineRuntime<FactoryState>>;

/** Everything a participant needs: the runtime, the shared state, the bus and the sandbox. */
export type FactoryCtx = {
  rt: Runtime;
  state: FactoryState;
  bus: Bus;
  sandbox?: Sandbox;
  models: Record<Tier, string>;
  maxTokens: Record<Tier, number>;
  /** agentId → resolver for that agent's final answer (see spawnAgent). */
  waiters: Map<string, (answer: string) => void>;
};

export function createFactory(opts: {
  state: FactoryState;
  runner: InferenceRunner;
  models: Record<Tier, string>;
  maxTokens?: Record<Tier, number>;
  sandbox?: Sandbox;
}): FactoryCtx {
  const rt = defineRuntime<FactoryState>();
  rt.initializeRuntime({ state: opts.state, inferenceRunnerConfig: { runner: opts.runner } });
  const bus = new Bus((e) => rt.resolveRuntime().publish(e));
  const fc: FactoryCtx = {
    rt,
    state: opts.state,
    bus,
    sandbox: opts.sandbox,
    models: opts.models,
    maxTokens: opts.maxTokens ?? { planner: 16000, builder: 16000, utility: 4000 },
    waiters: new Map(),
  };
  // Lifecycle: an agent's loop is over when it publishes its final answer.
  rt.join(
    new Actor("lifecycle", [
      bus.on(["model.answer"], (e) => {
        const resolve = fc.waiters.get(e.producerId);
        if (!resolve) return;
        fc.waiters.delete(e.producerId);
        const answer = (e.payload as { answer?: { content?: { text?: string } } }).answer?.content?.text ?? "";
        const info = fc.state.agents.get(e.producerId);
        if (info) {
          info.endedAt = Date.now();
          bus.emit(EV.agentEnded, e.producerId, { candidate: info.candidate, agentId: info.agentId, role: info.role, slot: info.slot, taskId: info.taskId, answer: answer.slice(0, 2000) });
        }
        setImmediate(() => {
          try {
            rt.leave(rt.resolveParticipant(e.producerId));
          } catch {
            /* already left */
          }
          resolve(answer);
        });
      }),
    ]),
  );
  return fc;
}

export function labelOf(state: FactoryState, agentId: string): string {
  const a = state.agents.get(agentId);
  if (!a) return agentId;
  return a.taskId ? `${a.slot}(${a.taskId})` : a.slot;
}
