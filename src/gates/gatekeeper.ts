import {
  FunctionCallItem,
  FunctionCallOutputItem,
  ModelMessageItem,
  UserMessageItem,
  type ExecutableTransition,
  type InterceptionHandler,
} from "@mozaik-ai/core";
import { EV, type Bus } from "../bus/events.js";
import type { Lease } from "../state/board.js";
import type { FactoryState, Role } from "../state/factory-state.js";
import { decide, type RuleId } from "./policies.js";

export type GateContext = {
  agentId: string;
  role: Role;
  candidate: string;
  state: FactoryState;
  maxSteps: number;
  taskId?: string;
  surface?: string[];
  lease?: Lease;
  bus?: Bus;
};

/**
 * One gate per agent loop, run by Mozaik before every state transition.
 * - before a tool call: policies decide; a refusal is answered in place of the tool, with the rule
 * - before an inference: messages queued for this agent are delivered into its context mid-flight
 * - a stopped agent, an exhausted budget or the step limit ends the loop with a final message
 */
export function makeGate(ctx: GateContext): InterceptionHandler {
  let steps = 0;
  const { state } = ctx;

  const refuse = (t: Extract<ExecutableTransition, { nextStateId: "function_call" }>, rule: RuleId, message: string): ExecutableTransition => {
    const { call, inferenceInput } = t.input;
    // The refused call goes back into the context with valid JSON arguments: providers reject a
    // conversation that contains an unparseable tool input, which would fail every later turn.
    let args = "{}";
    try {
      JSON.parse(call.args ?? "");
      args = call.args;
    } catch {
      /* keep {} */
    }
    inferenceInput.context.addContextItems([
      FunctionCallItem.rehydrate({ callId: call.callId, name: call.name, args }),
      FunctionCallOutputItem.create(call.callId, `REJECTED [${rule}]: ${message}`),
    ]);
    ctx.bus?.emit(EV.gateRejected, ctx.agentId, { candidate: ctx.candidate, agentId: ctx.agentId, tool: call.name, rule, message });
    // The runtime executes a transition returned by an interceptor without intercepting it again,
    // so the pre-inference checks run here too; otherwise a refused agent would never be stopped.
    return beforeInference({ nextStateId: "inference", input: inferenceInput });
  };

  const beforeInference = (t: Extract<ExecutableTransition, { nextStateId: "inference" | "inference_streaming" }>): ExecutableTransition => {
    steps += 1;
    const stop = stopReason();
    if (stop) return { nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text: `STOPPED: ${stop}` }) } };
    const messages = state.takeInbox(ctx.agentId);
    if (messages.length > 0) {
      t.input.context.addContextItems(messages.map((m) => UserMessageItem.create(m)));
      ctx.bus?.emit(EV.inboxDelivered, ctx.agentId, { agentId: ctx.agentId, count: messages.length });
    }
    return t;
  };

  const stopReason = (): string | undefined =>
    state.stopped.get(ctx.agentId) ??
    (state.budget.exceeded() ? "budget exhausted" : undefined) ??
    (steps > ctx.maxSteps ? `step limit (${ctx.maxSteps}) reached` : undefined);

  return {
    isSatisfiedBy: () => true,
    handle: async (t) => {
      if (t.nextStateId === "inference" || t.nextStateId === "inference_streaming") return beforeInference(t);
      if (t.nextStateId === "function_call") {
        if ((t.input.call.args ?? "").trim() === "") {
          // Models send "" for a tool with no required arguments; the runtime would fail to parse it.
          const { callId, name } = t.input.call;
          t = { nextStateId: "function_call", input: { ...t.input, call: FunctionCallItem.rehydrate({ callId, name, args: "{}" }) } };
        }
        let args: unknown;
        try {
          args = JSON.parse(t.input.call.args);
        } catch {
          return refuse(t, "valid-json", "the arguments were not valid JSON (they look truncated: the output probably hit the token limit). Re-send a smaller call; write big files in parts with edit_file.");
        }
        const board = state.candidates.get(ctx.candidate)?.board;
        const d = decide(
          {
            agentId: ctx.agentId,
            role: ctx.role,
            candidate: ctx.candidate,
            taskId: ctx.taskId,
            surface: ctx.surface,
            board,
            stopped: state.stopped.get(ctx.agentId),
            budgetExceeded: state.budget.exceeded(),
            leaseCurrent: ctx.lease && board ? board.isCurrent(ctx.lease) : undefined,
          },
          t.input.call.name,
          args,
        );
        return d.allow ? t : refuse(t, d.rule, d.message);
      }
      return t;
    },
  };
}
