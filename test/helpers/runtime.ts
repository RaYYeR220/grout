import { createAgent, defineRuntime, type InterceptionHandler, type Tool } from "@mozaik-ai/core";
import { FactoryState } from "../../src/state/factory-state.js";
import { ScriptedRunner, type Script } from "../../src/llm/scripted-runner.js";
import { Bus, EV } from "../../src/bus/events.js";
import { Actor } from "../../src/bus/actor.js";

export function makeRuntime(script: Script, stateOpts: Partial<ConstructorParameters<typeof FactoryState>[0]> = {}) {
  const rt = defineRuntime<FactoryState>();
  const state = new FactoryState({ runId: "test", spec: "", budgetUsd: 10, ...stateOpts });
  rt.initializeRuntime({ state, inferenceRunnerConfig: { runner: new ScriptedRunner(script) } });
  const bus = new Bus((e) => rt.resolveRuntime().publish(e));
  const events: { type: string; payload: unknown }[] = [];
  rt.join(new Actor("recorder", [bus.on(Object.values(EV), (e) => { events.push({ type: e.type, payload: e.payload }); })]));
  return { rt, state, bus, events };
}

/** Runs one raw agent loop with a gate and resolves with its final answer. */
export function runRawAgent(
  rt: ReturnType<typeof makeRuntime>["rt"],
  opts: { name: string; tools: Tool[]; message: string; gate?: InterceptionHandler; instruction?: string },
): Promise<string> {
  const agent = createAgent({ name: opts.name, capabilities: [], instruction: opts.instruction ?? opts.name, tools: opts.tools, handlers: [] });
  return new Promise((resolve) => {
    rt.join(
      new Actor(`waiter-${agent.getId()}`, [
        {
          specification: { isSatisfiedBy: ({ event }: { event: { type: string; producerId: string } }) => event.type === "model.answer" && event.producerId === agent.getId() } as never,
          processor: { apply: ({ event }: { event: { payload: { answer: { content: { text: string } } } } }) => resolve(event.payload.answer.content.text) } as never,
        },
      ]),
    );
    rt.join(agent);
    rt.runLoop(agent.getId(), opts.message, { model: "scripted", tools: agent.getTools(), context: agent.getMemory().getContext() }, opts.gate);
  });
}
