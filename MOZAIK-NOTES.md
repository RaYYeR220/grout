# Notes on Mozaik 4.2.0

What we learned about the runtime while building grout on `@mozaik-ai/core@4.2.0`, with where each behaviour lives in `node_modules/@mozaik-ai/core/dist/index.mjs` and how grout handles it. Line numbers refer to the published 4.2.0 build.

## What grout relies on

| Primitive | How grout uses it |
|---|---|
| `InterceptionHandler` | The gate (`src/gates/gatekeeper.ts`). Before every tool call it applies the write policies and answers refusals in place of the tool; before every inference it delivers queued messages into the agent's context; it ends loops that are stopped, out of budget or over their step limit. |
| `FunctionCallItem.rehydrate` / `FunctionCallOutputItem.create` | Refusals are written into the context as a call plus its output, so the model sees exactly which call was refused and why. Empty `""` arguments are rewritten to `{}` before the tool runs. |
| `RuntimeState` | `FactoryState`: the versioned workspace, the requirement ledger, the task board, the test matrix and the budget, shared by every participant. |
| Semantic events + `SituationHandler` | Every deterministic participant (broker, verifier, review desk, supervisor, conductor, tracer) reacts to events; none of them calls an agent directly. |
| `runLoop` per task | Each task attempt is a fresh agent loop with its own context, so retries do not inherit a confused history. |
| `inference.completed` | The tracer turns every inference into a priced `llm.call` line (provider-reported cost when available). |
| `@mozaik-ai/cloud-sdk/exporter` | Optional: the whole run as one Mozaik Cloud session (`GROUT_MOZAIK_KEY`). |

## Behaviours worth knowing

1. **A transition returned by an interceptor is not intercepted again** (`AgentLoop.run`, lines 560–576). The interceptor runs once per loop iteration, and whatever it returns is executed directly. If a gate refuses a tool call by returning an `inference` transition, that inference skips the gate. A step limit or a stop flag checked "before inference" is then bypassed, and an agent whose every call is refused loops forever (we reproduced this: the test process ran out of memory). grout's gate runs its pre-inference checks itself on the refusal path (`beforeInference` in `src/gates/gatekeeper.ts`).

2. **`runLoop` does not await or catch the loop** (line 933). Any error inside a loop (a provider 5xx, an empty model turn, a handler throw) becomes an unhandled rejection, which ends a default Node process. grout wraps the inference runner (`src/llm/guarded-runner.ts`): timeout, retries with backoff, and a final error is turned into a model message so the loop ends cleanly and the supervisor can respawn the task.

3. **A model turn with neither a tool call nor a message throws** `No transition rule found` (line 687). Some providers return an empty turn now and then. The guarded runner retries an empty turn once, then substitutes a placeholder message.

4. **Only the first tool call of a turn runs** (line 747). Parallel tool calls from the model are dropped silently. grout sends `parallel_tool_calls: false` so models stop producing them.

5. **Empty tool arguments crash the call** (`DefaultFunctionCallRunner`, `JSON.parse(input.args)`). Models often send `""` for tools without required arguments; the runner answers `Error calling tool: SyntaxError`. The gate rewrites `""` to `{}` with `FunctionCallItem.rehydrate`.

6. **The chat-completions mapper sends only `model`, `messages`, `tools`, `reasoning_effort` and `stream`.** `maxOutputTokens`, structured output and `parallel_tool_calls` never reach an OpenAI-compatible endpoint. grout builds one endpoint per model with these in `extraBody` (`src/llm/providers.ts`).

7. **Returning `idle` from an interceptor crashes the loop.** The executor has no `idle` state. A clean stop is a `model_message` transition with a synthetic `ModelMessageItem`.

8. **`Memory` and `InferenceInputValidator` are not exported.** Agents can only be created with random UUIDs (grout keeps readable labels in its own state), and a custom runner cannot reuse the default request validation.

9. **The built-in cloud export opens a client per `runLoop`** (line 823). With no key it prints a warning for every agent loop; with a key, every loop becomes its own session. grout uses its own variable for the exporter and filters that warning.

10. **Event fan-out is synchronous and depth-first.** An event emitted inside a handler is delivered to later participants before the event that triggered it. grout defers every emit with `setImmediate` (`src/bus/events.ts`), so causes are always delivered before their effects.

11. **Concurrent loops on one agent share one context.** Two `runLoop` calls on the same agent interleave into a single `ModelContext`. grout never reuses an agent for a second loop.

12. **Validate-at-interception is not enough for shared state.** Not a runtime bug, but the reason grout's CAS lives in the workspace: a gate that checks a version and then lets an async tool write later leaves a window in which two agents both pass the check (reproduced with two live builders). The version check and the write happen in one synchronous step (`Workspace.commit`).
