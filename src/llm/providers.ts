import { OpenAIChatCompletions, supportedModels, type InferenceRunnerConfig } from "@mozaik-ai/core";
import type { Preset, Tier } from "./presets.js";

export type GenerativeModel = NonNullable<InferenceRunnerConfig["supportedModels"]>[number];

const CONTEXT_ITEM_TYPES = [
  "user_message",
  "system_message",
  "developer_message",
  "function_call",
  "function_call_output",
  "model_message",
  "reasoning",
];

/**
 * Chat-completions presets get our own model specifications. The runtime's chat-completions
 * mapper does not forward max tokens, so each model gets its own endpoint whose extra body
 * carries max_tokens (the largest any tier needs) and disables parallel tool calls, since the
 * agent loop executes only the first call of a turn.
 */
export function buildModels(preset: Preset, maxTokens: Record<Tier, number>, env: Record<string, string | undefined>): GenerativeModel[] {
  const ids = new Map<string, number>();
  for (const tier of ["planner", "builder", "utility"] as const) {
    const id = preset.models[tier];
    ids.set(id, Math.max(ids.get(id) ?? 0, maxTokens[tier]));
  }

  if (preset.name === "anthropic" || preset.name === "openai") {
    return supportedModels.filter((m) => ids.has(m.specification.name));
  }

  return [...ids].map(([name, max]) => ({
    endpoint: new OpenAIChatCompletions(undefined, {
      baseURL: preset.baseURL,
      apiKey: env[preset.apiKeyEnv],
      extraBody: { ...preset.extraBody, max_tokens: max, parallel_tool_calls: false },
    }),
    specification: {
      name,
      provider: preset.name,
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
      supportsStreaming: false,
      supportsFunctionCalling: true,
      supportsStructuredOutput: false,
      contextWindowSize: 200_000,
      maxOutputTokens: max,
      supportedContextItemTypes: CONTEXT_ITEM_TYPES,
    },
  })) as GenerativeModel[];
}
