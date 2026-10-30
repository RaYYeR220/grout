import { createAgent, type Tool } from "@mozaik-ai/core";
import { EV } from "../bus/events.js";
import { makeGate } from "../gates/gatekeeper.js";
import type { Tier } from "../llm/presets.js";
import type { FactoryCtx } from "../runtime.js";
import type { Lease } from "../state/board.js";
import type { Role } from "../state/factory-state.js";

export type AgentSelf = { id: string };

export type SpawnOptions = {
  role: Role;
  slot: string;
  candidate: string;
  tier: Tier;
  /** Overrides the tier's model (supervisor escalation). */
  model?: string;
  taskId?: string;
  lease?: Lease;
  surface?: string[];
  instruction: string;
  /** Built after the agent exists, so tools know whose read-set and lease they act on. */
  tools: (self: AgentSelf) => Tool[];
  message: string;
  maxSteps?: number;
};

export type AgentHandle = { agentId: string; done: Promise<string> };

export function spawnAgent(fc: FactoryCtx, opts: SpawnOptions): AgentHandle {
  const self: AgentSelf = { id: "" };
  const tools = opts.tools(self);
  const agent = createAgent({ name: opts.slot, capabilities: [opts.role], instruction: opts.instruction, tools, handlers: [] });
  self.id = agent.getId();
  const model = opts.model ?? fc.models[opts.tier];
  const info = {
    agentId: self.id,
    role: opts.role,
    slot: opts.slot,
    candidate: opts.candidate,
    taskId: opts.taskId,
    model,
    spawnedAt: Date.now(),
  };
  fc.state.agents.set(self.id, info);
  const done = new Promise<string>((resolve) => fc.waiters.set(self.id, resolve));
  fc.rt.join(agent);
  fc.bus.emit(EV.agentSpawned, self.id, info);
  const gate = makeGate({
    agentId: self.id,
    role: opts.role,
    candidate: opts.candidate,
    state: fc.state,
    maxSteps: opts.maxSteps ?? 40,
    taskId: opts.taskId,
    surface: opts.surface,
    lease: opts.lease,
    bus: fc.bus,
  });
  fc.rt.runLoop(
    self.id,
    opts.message,
    { model, tools, context: agent.getMemory().getContext(), maxOutputTokens: fc.maxTokens[opts.tier] },
    gate,
  );
  return { agentId: self.id, done };
}
